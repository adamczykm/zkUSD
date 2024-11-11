import {
  SmartContract,
  state,
  State,
  UInt64,
  Experimental,
  PublicKey,
  Struct,
  Field,
  method,
  Provable,
  Poseidon,
} from 'o1js';
import { ZkUsdProtocolAdmin } from './zkusd-protocol-admin';

const { IndexedMerkleMap, BatchReducer } = Experimental;

class MerkleMap extends IndexedMerkleMap(10) {}

export class PriceFeedAction extends Struct({
  address: PublicKey,
  price: UInt64,
}) {}

let batchReducer = new BatchReducer({
  actionType: PriceFeedAction,
  batchSize: 3,
});

class Batch extends batchReducer.Batch {}
class BatchProof extends batchReducer.BatchProof {}

export class ZkUsdPriceFeedOracle extends SmartContract {
  // Batch reducer related
  @state(Field)
  actionState = State(BatchReducer.initialActionState);
  @state(Field)
  actionStack = State(BatchReducer.initialActionStack);

  //Price
  @state(UInt64) price = State<UInt64>();

  //Fallback price
  @state(UInt64) fallbackPrice = State<UInt64>();

  // Whitelist
  @state(Field) whitelistRoot = State<Field>();
  @state(Field) whitelistLength = State<Field>();

  static ZKUSD_PROTOCOL_ADMIN_KEY = PublicKey.fromBase58(
    'B62qkkJyWEXwHN9zZmqzfdf2ec794EL5Nyr8hbpvqRX4BwPyQcwKJy6'
  );

  static ZkUsdProtocolAdminContract = new ZkUsdProtocolAdmin(
    ZkUsdPriceFeedOracle.ZKUSD_PROTOCOL_ADMIN_KEY
  );

  //Can I verify the sender is in the whitelist via a proof?
  @method async submitPrice(price: UInt64) {
    let address = this.sender.getAndRequireSignatureV2();

    const priceFeedAction = new PriceFeedAction({
      address,
      price,
    });

    batchReducer.dispatch(priceFeedAction);
  }

  @method async settleBatch(
    batch: Batch,
    proof: BatchProof,
    whitelistMap: MerkleMap
  ) {
    let witnessedMap = Provable.witness(MerkleMap, () => whitelistMap);

    this.whitelistRoot.requireEquals(witnessedMap.root);
    this.whitelistLength.requireEquals(witnessedMap.length);

    batchReducer.processBatch({ batch, proof }, (action, isDummy) => {
      let addressKey = Poseidon.hash(action.address.toFields());
      let isValidAddress = witnessedMap.getOption(addressKey).orElse(0n);
      isValidAddress = Provable.if(isDummy, Field(0), isValidAddress);

      //if the address is valid
    });
  }
}
