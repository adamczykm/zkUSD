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
  UInt32,
} from 'o1js';

/**
 * @title   zkUSD Protocol Vault Contract
 * @notice  This contract manages the administrative functions of the zkUSD protocol.
 *          It controls oracle whitelisting, protocol fees, and emergency controls.
 *          Only the admin can perform administrative actions.
 * @dev     The contract uses a simple admin pattern where only the designated admin
 *          can perform privileged operations. This admin key can be updated by the protocol to potentially
 *          move to a multi-sig admin in the future.
 */

// Errors
export const ZkUsdProtocolVaultErrors = {
  INVALID_FEE:
    'Protocol fee is a percentage and must be less than or equal to 100',
  INSUFFICIENT_BALANCE: 'Insufficient balance for withdrawal',
};

// Structs
export class OracleWhitelist extends Struct({
  addresses: Provable.Array(PublicKey, 10),
}) {}

// Event Definitions
export class AdminUpdatedEvent extends Struct({
  previousAdmin: PublicKey,
  newAdmin: PublicKey,
  blockNumber: UInt32,
}) {}

export class OracleWhitelistUpdatedEvent extends Struct({
  previousHash: Field,
  newHash: Field,
  blockNumber: UInt32,
}) {}

export class ProtocolFeeUpdated extends Struct({
  previousFee: UInt64,
  newFee: UInt64,
  blockNumber: UInt32,
}) {}

export class OracleFeeUpdated extends Struct({
  previousFee: UInt64,
  newFee: UInt64,
  blockNumber: UInt32,
}) {}

export class FundsWithdrawnEvent extends Struct({
  recipient: PublicKey,
  amount: UInt64,
  blockNumber: UInt32,
}) {}

export class VerificationKeyUpdatedEvent extends Struct({
  blockNumber: UInt32,
}) {}

export class ZkUsdProtocolVault extends SmartContract {
  @state(PublicKey) admin = State<PublicKey>();
  @state(UInt64) oracleFlatFee = State<UInt64>(); // Flat fee in Mina to pay to the oracles for price submission
  @state(Field) oracleWhitelistHash = State<Field>(); // Hash of the oracle whitelist
  @state(UInt64) protocolPercentageFee = State<UInt64>(); // Percentage fee for the protocol taken from the staking rewards

  readonly events = {
    AdminUpdated: AdminUpdatedEvent,
    OracleWhitelistUpdated: OracleWhitelistUpdatedEvent,
    ProtocolFeeUpdated: ProtocolFeeUpdated,
    OracleFeeUpdated: OracleFeeUpdated,
    FundsWithdrawn: FundsWithdrawnEvent,
    VerificationKeyUpdated: VerificationKeyUpdatedEvent,
  };

  /**
   * @notice  Deploys the protocol vault contract and sets initial state
   * @param   args.adminPublicKey The public key of the admin
   * @param   args.initialProtocolFee The initial protocol fee percentage
   */
  async deploy(
    args: DeployArgs & {
      adminPublicKey: PublicKey;
      initialProtocolFee: UInt64;
      initialOracleFlatFee: UInt64;
    }
  ) {
    await super.deploy(args);

    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(), // We might want to change this so we can upgrade the contract
    });

    // Set the fees
    this.protocolPercentageFee.set(args.initialProtocolFee);
    this.oracleFlatFee.set(args.initialOracleFlatFee);

    // Set the admin
    this.admin.set(args.adminPublicKey);

    // Set the oracle whitelist hash
    this.oracleWhitelistHash.set(Field(0));
  }

  /**
   * @notice  Internal helper to validate admin signature
   * @returns The signed account update from the admin
   */
  private async ensureAdminSignature(): Promise<AccountUpdate> {
    const admin = await Provable.witnessAsync(PublicKey, async () => {
      let pk = await this.admin.fetch();
      assert(pk !== undefined, 'could not fetch admin public key');
      return pk;
    });
    this.admin.requireEquals(admin);
    return AccountUpdate.createSigned(admin);
  }

  /**
   * @notice  Updates the verification key for the protocol vault
   * @param   vk The new verification key
   */
  @method
  async updateVerificationKey(vk: VerificationKey) {
    await this.ensureAdminSignature();
    this.account.verificationKey.set(vk);

    this.emitEvent('VerificationKeyUpdated', {
      blockNumber: this.network.blockchainLength.getAndRequireEquals(),
    });
  }

  /**
   * @notice  Updates the admin public key
   * @param   newAdmin The new admin public key
   */
  @method async updateAdmin(newAdmin: PublicKey) {
    await this.ensureAdminSignature();
    this.admin.set(newAdmin);

    this.emitEvent('AdminUpdated', {
      previousAdmin: this.admin.get(), // Should be ok
      newAdmin,
      blockNumber: this.network.blockchainLength.getAndRequireEquals(),
    });
  }

  /**
   * @notice  Updates the oracle whitelist hash
   * @param   whitelist The new oracle whitelist
   */
  @method async updateOracleWhitelist(whitelist: OracleWhitelist) {
    //Precondition
    const previousHash = this.oracleWhitelistHash.getAndRequireEquals();

    //Ensure admin signature
    await this.ensureAdminSignature();

    const updatedWhitelistHash = Poseidon.hash(
      OracleWhitelist.toFields(whitelist)
    );
    this.oracleWhitelistHash.set(updatedWhitelistHash);

    this.emitEvent('OracleWhitelistUpdated', {
      previousHash,
      newHash: updatedWhitelistHash,
      blockNumber: this.network.blockchainLength.getAndRequireEquals(),
    });
  }

  /**
   * @notice  Updates the protocol fee percentage
   * @param   fee The new protocol fee percentage
   */
  @method async updateProtocolFee(fee: UInt64) {
    //Precondition
    const previousFee = this.protocolPercentageFee.getAndRequireEquals();

    //Ensure admin signature
    await this.ensureAdminSignature();

    //Ensure the fee is less than or equal to 100 (its a percentage)
    fee.assertLessThanOrEqual(
      UInt64.from(100),
      ZkUsdProtocolVaultErrors.INVALID_FEE
    );

    this.protocolPercentageFee.set(fee);

    this.emitEvent('ProtocolFeeUpdated', {
      previousFee,
      newFee: fee,
      blockNumber: this.network.blockchainLength.getAndRequireEquals(),
    });
  }

  /**
   * @notice  Updates the oracle fee
   * @param   fee The new oracle fee
   */
  @method async updateOracleFee(fee: UInt64) {
    //Precondition
    const previousFee = this.oracleFlatFee.getAndRequireEquals();

    //Ensure admin signature
    await this.ensureAdminSignature();

    this.oracleFlatFee.set(fee);

    this.emitEvent('OracleFeeUpdated', {
      previousFee,
      newFee: fee,
      blockNumber: this.network.blockchainLength.getAndRequireEquals(),
    });
  }

  /**
   * @notice  Returns the oracle whitelist hash
   * @returns The oracle whitelist hash
   */
  @method.returns(Field)
  public async getOracleWhitelistHash() {
    return this.oracleWhitelistHash.getAndRequireEquals();
  }

  /**
   * @notice  Returns the protocol fee
   * @returns The protocol fee
   */
  @method.returns(UInt64)
  public async getProtocolFee() {
    return this.protocolPercentageFee.getAndRequireEquals();
  }

  /**
   * @notice  Returns the oracle fee
   * @returns The oracle fee
   */
  @method.returns(UInt64)
  public async getOracleFee() {
    return this.oracleFlatFee.getAndRequireEquals();
  }

  /**
   * @notice  Checks if the account update can update the vault verification key hash
   * @param   _accountUpdate The account update to check
   * @returns True if the account update can update the vault verification key hash
   */
  @method.returns(Bool)
  public async canUpdateTheVaultVerificationKeyHash(
    _accountUpdate: AccountUpdate
  ) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  /**
   * @notice  Checks if the account update can update the fallback price
   * @param   _accountUpdate The account update to check
   * @returns True if the account update can update the fallback price
   */
  @method.returns(Bool)
  public async canUpdateFallbackPrice(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  /**
   * @notice  Checks if the account update can stop the protocol
   * @returns True if the account update can stop the protocol
   */
  @method.returns(Bool)
  public async canStopTheProtocol() {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  /**
   * @notice  Checks if the account update can resume the protocol
   * @returns True if the account update can resume the protocol
   */
  @method.returns(Bool)
  public async canResumeTheProtocol() {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  /**
   * @notice  Withdraws protocol funds
   * @param   recipient The recipient of the funds
   * @param   amount The amount of funds to withdraw
   */
  @method async withdrawProtocolFunds(recipient: PublicKey, amount: UInt64) {
    //Precondition
    const balance = this.account.balance.getAndRequireEquals();

    //Ensure the balance is greater than the amount
    balance.assertGreaterThanOrEqual(
      amount,
      ZkUsdProtocolVaultErrors.INSUFFICIENT_BALANCE
    );

    //Ensure admin signature
    await this.ensureAdminSignature();

    // Process withdrawal
    this.send({
      to: recipient,
      amount: amount,
    });
  }
}
