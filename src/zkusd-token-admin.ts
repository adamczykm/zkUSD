import {
  AccountUpdate,
  Bool,
  method,
  PublicKey,
  SmartContract,
  Permissions,
  DeployArgs,
} from 'o1js';
import { FungibleTokenAdminBase } from 'mina-fungible-token';
import { ZkUsdVault } from './zkusd-vault.js';

export class ZkUsdAdmin
  extends SmartContract
  implements FungibleTokenAdminBase
{
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

  @method.returns(Bool)
  public async canMint(_accountUpdate: AccountUpdate) {
    //Only allow minting if called by a zkUSDVault
    const zkUSDVault = new ZkUsdVault(_accountUpdate.publicKey);
    return await zkUSDVault.assertInteractionFlag();
  }

  @method.returns(Bool)
  public async canBurn(_accountUpdate: AccountUpdate) {
    // Only allow burning if called by a zkUSDVault
    const zkUSDVault = new ZkUsdVault(_accountUpdate.publicKey);
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
