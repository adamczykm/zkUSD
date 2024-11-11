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
  Reducer,
  Bool,
} from 'o1js';
import { ZkUsdProtocolAdmin } from './zkusd-protocol-admin';

const { OffchainState, OffchainStateCommitments } = Experimental;

export const offchainState = OffchainState({
  whitelist: OffchainState.Map(PublicKey, Bool),
});

class StateProof extends offchainState.Proof {}

export class PriceFeedAction extends Struct({
  address: PublicKey,
  price: UInt64,
}) {}

export class ZkUsdPriceFeedOracle extends SmartContract {
  @state(OffchainState.Commitments) offchainStateCommitments =
    offchainState.emptyCommitments();

  reducer = Reducer({ actionType: PriceFeedAction });
  offchainState = offchainState.init(this);

  @state(Field) actionState = State<Field>();

  //The price has 9 decimal precision

  //Price
  @state(UInt64) price = State<UInt64>();

  //Fallback price
  @state(UInt64) fallbackPrice = State<UInt64>();

  // Whitelist
  @state(Field) whitelistRoot = State<Field>();
  @state(Field) whitelistLength = State<Field>();

  static MAX_PRICES = 10;

  static ZKUSD_PROTOCOL_ADMIN_KEY = PublicKey.fromBase58(
    'B62qkkJyWEXwHN9zZmqzfdf2ec794EL5Nyr8hbpvqRX4BwPyQcwKJy6'
  );

  static ZkUsdProtocolAdminContract = new ZkUsdProtocolAdmin(
    ZkUsdPriceFeedOracle.ZKUSD_PROTOCOL_ADMIN_KEY
  );

  @method async addNewWhitelistAddress(address: PublicKey) {
    const canAddNewWhitelistAddress =
      await ZkUsdPriceFeedOracle.ZkUsdProtocolAdminContract.canAddNewWhitelistAddress(
        this.self
      );
    canAddNewWhitelistAddress.assertTrue();
    this.offchainState.fields.whitelist.update(address, {
      from: undefined,
      to: Bool(true),
    });
  }

  @method async removeWhitelistAddress(address: PublicKey) {
    const canRemoveWhitelistAddress =
      await ZkUsdPriceFeedOracle.ZkUsdProtocolAdminContract.canRemoveWhitelistAddress(
        this.self
      );
    canRemoveWhitelistAddress.assertTrue();

    this.offchainState.fields.whitelist.update(address, {
      from: Bool(true),
      to: Bool(false),
    });
  }

  @method async reinstateWhitelistAddress(address: PublicKey) {
    const canReinstateWhitelistAddress =
      await ZkUsdPriceFeedOracle.ZkUsdProtocolAdminContract.canReinstateWhitelistAddress(
        this.self
      );
    canReinstateWhitelistAddress.assertTrue();

    this.offchainState.fields.whitelist.update(address, {
      from: Bool(false),
      to: Bool(true),
    });
  }

  @method async updateFallbackPrice(price: UInt64) {
    //Precondition
    this.fallbackPrice.getAndRequireEquals();

    const canUpdateFallbackPrice =
      await ZkUsdPriceFeedOracle.ZkUsdProtocolAdminContract.canUpdateFallbackPrice(
        this.self
      );
    canUpdateFallbackPrice.assertTrue();

    this.fallbackPrice.set(price);
  }

  @method
  async settleWhitelist(proof: StateProof) {
    await this.offchainState.settle(proof);
  }

  //Can I verify the sender is in the whitelist via a proof?
  @method async submitPrice(price: UInt64) {
    const submitter = this.sender.getAndRequireSignatureV2();

    const isValidAddressOption = await this.offchainState.fields.whitelist.get(
      submitter
    );
    const isValidAddress = isValidAddressOption.assertSome(
      'Sender not in the whitelist'
    );
    isValidAddress.assertTrue();

    // Get current action state
    const actionState = this.actionState.getAndRequireEquals();

    // Get pending actions
    const pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    // Check if submitter has any pending actions
    const hasPendingAction = this.reducer.reduce(
      pendingActions,
      Bool,
      (state: Bool, action: PriceFeedAction) => {
        return Provable.if(
          action.address.equals(submitter),
          Bool(true), // Found a pending action from this address
          state // Keep checking
        );
      },
      Bool(false) // Initial state: no pending action found
    );

    hasPendingAction.assertFalse('Address already has a pending action');

    const priceFeedAction = new PriceFeedAction({
      address: submitter,
      price,
    });

    this.reducer.dispatch(priceFeedAction);
  }

  @method async reduceNewPriceUpdate() {
    //Preconditions
    this.price.getAndRequireEquals();
    let fallbackPrice = this.fallbackPrice.getAndRequireEquals();
    let actionState = this.actionState.getAndRequireEquals();

    let pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    //Protocol has a limit of 10 prices
    let priceArray = Array(ZkUsdPriceFeedOracle.MAX_PRICES).fill(fallbackPrice);

    Provable.log('Initial Price Array', priceArray);

    let result = this.reducer.reduce(
      pendingActions,
      Provable.Array(UInt64, ZkUsdPriceFeedOracle.MAX_PRICES),
      (state: UInt64[], action: PriceFeedAction) => {
        return state.map((price, index) =>
          index === state.indexOf(fallbackPrice) ? action.price : price
        );
      },
      priceArray
    );

    Provable.log('After reducing actions:', result);
  }
}
