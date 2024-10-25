import {
  AccountUpdate,
  Bool,
  method,
  PublicKey,
  SmartContract,
  State,
  state,
  UInt64,
  Permissions,
  DeployArgs,
  Provable,
} from 'o1js';
import { FungibleTokenAdminBase } from 'mina-fungible-token';
import { ZKUSDOrchestrator } from './ZKUSDOrchestrator.js';

export class ZKUSDAdmin
  extends SmartContract
  implements FungibleTokenAdminBase
{
  @state(PublicKey) orchestratorPublicKey = State<PublicKey>();

  async deploy(args: DeployArgs & { orchestratorPublicKey: PublicKey }) {
    await super.deploy(args);
    this.orchestratorPublicKey.set(args.orchestratorPublicKey);
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
    // Only allow minting if called by the zkUSDOrchestrator
    const zkUSDOrchestrator = new ZKUSDOrchestrator(
      this.orchestratorPublicKey.getAndRequireEquals()
    );

    return await zkUSDOrchestrator.assertInteractionFlag();
  }

  @method.returns(Bool)
  public async canBurn(_accountUpdate: AccountUpdate) {
    // Only allow burning if called by the zkUSDOrchestrator
    const zkUSDOrchestrator = new ZKUSDOrchestrator(
      this.orchestratorPublicKey.getAndRequireEquals()
    );

    return await zkUSDOrchestrator.assertInteractionFlag();
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
