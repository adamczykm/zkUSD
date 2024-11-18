import {
  AccountUpdate,
  Bool,
  method,
  PublicKey,
  SmartContract,
  Permissions,
  DeployArgs,
  VerificationKey,
} from 'o1js';
import { FungibleTokenAdminBase } from 'mina-fungible-token';
import { ZkUsdVault } from './zkusd-vault.js';

export class ZkUsdTokenAdmin
  extends SmartContract
  implements FungibleTokenAdminBase
{
  static ZkUsdVaultContract: new (...args: any) => ZkUsdVault = ZkUsdVault;

  async deploy(args: DeployArgs) {
    await super.deploy(args);

    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  /** Update the verification key.
   * Note that because we have set the permissions for setting the verification key to `impossibleDuringCurrentVersion()`, this will only be possible in case of a protocol update that requires an update.
   */
  @method
  async updateVerificationKey(vk: VerificationKey) {
    this.account.verificationKey.set(vk);
  }

  @method.returns(Bool)
  public async canMint(_accountUpdate: AccountUpdate) {
    //Only allow minting if called by a zkUSDVault
    const zkUSDVault = new ZkUsdTokenAdmin.ZkUsdVaultContract(
      _accountUpdate.publicKey
    );
    return await zkUSDVault.assertInteractionFlag();
  }

  // Implement other required methods
  @method.returns(Bool)
  public async canChangeAdmin(_newAdmin: PublicKey) {
    return Bool(false); // Disallow changing admin
  }

  @method.returns(Bool)
  public async canPause() {
    return Bool(false); // Disallow pausing
  }

  @method.returns(Bool)
  public async canResume() {
    return Bool(false); // Disallow resuming
  }
}
