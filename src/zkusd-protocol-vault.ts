import {
  SmartContract,
  state,
  PublicKey,
  State,
  method,
  Bool,
  Permissions,
  DeployArgs,
  AccountUpdate,
  Provable,
  assert,
  VerificationKey,
  UInt64,
  Field,
  Struct,
  Poseidon,
} from 'o1js';

export const ZkUsdProtocolVaultErrors = {
  INVALID_FEE:
    'Protocol fee is a percentage and must be less than or equal to 100',
};

export class OracleWhitelist extends Struct({
  addresses: Provable.Array(PublicKey, 10),
}) {}

export class ZkUsdProtocolVault extends SmartContract {
  @state(PublicKey) admin = State<PublicKey>();
  @state(UInt64) oracleFlatFee = State<UInt64>(); // Flat fee in Mina to pay to the oracles for price submission
  @state(Field) oracleWhitelistHash = State<Field>(); // Hash of the oracle whitelist
  @state(UInt64) protocolPercentageFee = State<UInt64>(); // Percentage fee for the protocol taken from the staking rewards

  async deploy(
    args: DeployArgs & {
      adminPublicKey: PublicKey;
      initialProtocolFee: UInt64;
    }
  ) {
    await super.deploy(args);

    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(), // We might want to change this so we can upgrade the contract
    });

    this.protocolPercentageFee.set(args.initialProtocolFee);
    this.admin.set(args.adminPublicKey);
    this.oracleWhitelistHash.set(Field(0));
  }

  private async ensureAdminSignature() {
    const admin = await Provable.witnessAsync(PublicKey, async () => {
      let pk = await this.admin.fetch();
      assert(pk !== undefined, 'could not fetch admin public key');
      return pk;
    });
    this.admin.requireEquals(admin);
    return AccountUpdate.createSigned(admin);
  }

  @method async updateAdmin(newAdmin: PublicKey) {
    await this.ensureAdminSignature();
    this.admin.set(newAdmin);
  }

  //We should be able to update this protocol admin contract
  @method
  async updateVerificationKey(vk: VerificationKey) {
    await this.ensureAdminSignature();
    this.account.verificationKey.set(vk);
  }

  @method async updateOracleWhitelist(whitelist: OracleWhitelist) {
    await this.ensureAdminSignature();

    this.oracleWhitelistHash.getAndRequireEquals();

    const updatedWhitelistHash = Poseidon.hash(
      OracleWhitelist.toFields(whitelist)
    );
    this.oracleWhitelistHash.set(updatedWhitelistHash);
  }

  @method.returns(Field)
  public async getOracleWhitelistHash() {
    return this.oracleWhitelistHash.getAndRequireEquals();
  }

  @method.returns(Bool)
  public async canUpdateProtocolVaultVerificationKey(
    _accountUpdate: AccountUpdate
  ) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(UInt64)
  public async getProtocolFee() {
    return this.protocolPercentageFee.getAndRequireEquals();
  }

  @method async setProtocolFee(fee: UInt64) {
    await this.ensureAdminSignature();
    //assert fee is less than or equal to 100

    this.protocolPercentageFee.getAndRequireEquals();

    fee.assertLessThanOrEqual(
      UInt64.from(100),
      ZkUsdProtocolVaultErrors.INVALID_FEE
    );
    this.protocolPercentageFee.set(fee);
  }

  @method.returns(Bool)
  public async canUpdateFallbackPrice(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canSetOracleFee(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canStopTheProtocol() {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canResumeTheProtocol() {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method async setOracleFee(fee: UInt64) {
    await this.ensureAdminSignature();
    this.oracleFlatFee.set(fee);
  }

  @method.returns(UInt64)
  public async getOracleFee() {
    return this.oracleFlatFee.getAndRequireEquals();
  }

  @method async withdrawProtocolFunds(recipient: PublicKey, amount: UInt64) {
    await this.ensureAdminSignature();

    // Process withdrawal
    this.send({
      to: recipient,
      amount: amount,
    });
  }
}
