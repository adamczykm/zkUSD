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
} from 'o1js';

export class ZkUsdProtocolAdmin extends SmartContract {
  @state(PublicKey) admin = State<PublicKey>();

  async deploy(args: DeployArgs & { adminPublicKey: PublicKey }) {
    await super.deploy(args);

    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });

    this.admin.set(args.adminPublicKey);
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

  @method.returns(Bool)
  public async canUpdateVerificationKey(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canSetProtocolFee(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canWithdrawProtocolFunds(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canAddNewWhitelistAddress(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canRemoveWhitelistAddress(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canReinstateWhitelistAddress(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canUpdateFallbackPrice(_accountUpdate: AccountUpdate) {
    await this.ensureAdminSignature();
    return Bool(true);
  }
}
