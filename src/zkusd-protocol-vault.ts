import {
  SmartContract,
  state,
  PublicKey,
  State,
  DeployArgs,
  method,
  UInt64,
  Permissions,
  VerificationKey,
} from 'o1js';

export class ZkUsdProtocolVault extends SmartContract {
  // Add owner state
  @state(PublicKey) owner = State<PublicKey>();

  async deploy(args: DeployArgs) {
    await super.deploy(args);

    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey: Permissions.VerificationKey.proofOrSignature(), // We want to be able to upgrade the protocol vault contract
      setPermissions: Permissions.impossible(),
    });

    // Set initial owner as deployer
    this.owner.set(this.sender.getAndRequireSignatureV2());
  }

  private assertOwner() {
    const currentOwner = this.owner.getAndRequireEquals();
    const sender = this.sender.getAndRequireSignatureV2();

    sender.assertEquals(currentOwner);
  }

  @method
  async updateVerificationKey(vk: VerificationKey) {
    this.assertOwner();
    this.account.verificationKey.set(vk);
  }

  @method async withdraw(amount: UInt64) {
    // Assert owner
    this.assertOwner();

    // Process withdrawal
    this.send({
      to: this.sender.getUnconstrainedV2(),
      amount: amount,
    });
  }

  @method async updateOwner(newOwner: PublicKey) {
    // Get and verify current owner
    this.assertOwner();

    // Update to new owner
    this.owner.set(newOwner);
  }
}
