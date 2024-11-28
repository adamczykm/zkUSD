import { FungibleTokenAdminBase } from 'mina-fungible-token';
import { AccountUpdate, Bool, method, PublicKey, SmartContract } from 'o1js';

export class ZkUsdEngine
  extends SmartContract
  implements FungibleTokenAdminBase
{
  @method.returns(Bool)
  public async canMint(_accountUpdate: AccountUpdate) {
    return Bool(true);
  }

  @method.returns(Bool)
  public async canChangeAdmin(_admin: PublicKey) {
    return Bool(true);
  }

  @method.returns(Bool)
  public async canPause(): Promise<Bool> {
    return Bool(true);
  }

  @method.returns(Bool)
  public async canResume(): Promise<Bool> {
    return Bool(true);
  }
}
