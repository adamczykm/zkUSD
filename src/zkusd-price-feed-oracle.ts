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
  DeployArgs,
  Permissions,
  Bool,
  AccountUpdate,
  UInt32,
  assert,
} from 'o1js';
import { OracleWhitelist, ZkUsdProtocolVault } from './zkusd-protocol-vault';

export const ZkUsdPriceFeedOracleErrors = {
  SENDER_NOT_WHITELISTED: 'Sender not in the whitelist',
  INVALID_WHITELIST: 'Invalid whitelist',
  PENDING_ACTION_EXISTS: 'Address already has a pending action',
  EMERGENCY_HALT:
    'Oracle is in emergency mode - all protocol actions are suspended',
  AMOUNT_ZERO: 'Amount must be greater than zero',
};

export class PriceFeedAction extends Struct({
  address: PublicKey,
  price: UInt64,
}) {}

export class PriceState extends Struct({
  prices: Provable.Array(UInt64, 10),
  count: UInt64,
}) {}

export class ZkUsdPriceFeedOracle extends SmartContract {
  reducer = Reducer({ actionType: PriceFeedAction });

  // Price states
  @state(UInt64) priceEvenBlock = State<UInt64>();
  @state(UInt64) priceOddBlock = State<UInt64>();
  @state(UInt64) fallbackPriceEvenBlock = State<UInt64>();
  @state(UInt64) fallbackPriceOddBlock = State<UInt64>();
  @state(Field) actionState = State<Field>();
  @state(Bool) protocolEmergencyStop = State<Bool>(Bool(false)); // Flag to halt the protocol in case of emergency

  static PROTOCOL_VAULT_ADDRESS = PublicKey.fromBase58(
    'B62qkJvkDUiw1c7kKn3PBa9YjNFiBgSA6nbXUJiVuSU128mKH4DiSih'
  );

  static MAX_PARTICIPANTS = 10;

  static ZkUsdProtocolVaultContract: new (...args: any) => ZkUsdProtocolVault =
    ZkUsdProtocolVault;

  async deploy(
    args: DeployArgs & {
      initialPrice: UInt64;
      oracleFee: UInt64;
    }
  ) {
    await super.deploy(args);

    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      editState: Permissions.proof(),
      send: Permissions.proof(),
    });

    this.actionState.set(Reducer.initialActionState);
    this.priceEvenBlock.set(args.initialPrice);
    this.priceOddBlock.set(args.initialPrice);
    this.fallbackPriceEvenBlock.set(args.initialPrice);
    this.fallbackPriceOddBlock.set(args.initialPrice);
  }

  public async getProtocolVaultContract(): Promise<ZkUsdProtocolVault> {
    return new ZkUsdPriceFeedOracle.ZkUsdProtocolVaultContract(
      ZkUsdPriceFeedOracle.PROTOCOL_VAULT_ADDRESS
    );
  }

  // Helper methods for block management
  private getBlockInfo(): { blockchainLength: UInt32; isOddBlock: Bool } {
    const blockchainLength =
      this.network.blockchainLength.getAndRequireEquals();
    const isOddBlock = blockchainLength.mod(2).equals(UInt32.from(1));
    return { blockchainLength, isOddBlock };
  }

  private requireCorrectFallbackPrices(isOddBlock: Bool) {
    this.fallbackPriceEvenBlock.requireEqualsIf(
      isOddBlock,
      this.fallbackPriceEvenBlock.get()
    );
    this.fallbackPriceOddBlock.requireEqualsIf(
      isOddBlock.not(),
      this.fallbackPriceOddBlock.get()
    );
  }

  // Price management helpers
  private updateBlockPrices(
    isOddBlock: Bool,
    newPrice: UInt64,
    currentPrices: { even: UInt64; odd: UInt64 }
  ) {
    const evenPrice = Provable.if(isOddBlock, newPrice, currentPrices.even);
    const oddPrice = Provable.if(isOddBlock.not(), newPrice, currentPrices.odd);
    return { evenPrice, oddPrice };
  }

  private getCurrentPrices(): { even: UInt64; odd: UInt64 } {
    return {
      even: this.priceEvenBlock.get(),
      odd: this.priceOddBlock.get(),
    };
  }

  private getAndRequireCurrentPrices(): { even: UInt64; odd: UInt64 } {
    return {
      even: this.priceEvenBlock.getAndRequireEquals(),
      odd: this.priceOddBlock.getAndRequireEquals(),
    };
  }

  private getCurrentFallbackPrices(): { even: UInt64; odd: UInt64 } {
    return {
      even: this.fallbackPriceEvenBlock.get(),
      odd: this.fallbackPriceOddBlock.get(),
    };
  }

  private getAndRequireCurrentFallbackPrices(): {
    even: UInt64;
    odd: UInt64;
  } {
    return {
      even: this.fallbackPriceEvenBlock.getAndRequireEquals(),
      odd: this.fallbackPriceOddBlock.getAndRequireEquals(),
    };
  }

  // Validation helpers
  private async validateWhitelist(
    submitter: PublicKey,
    whitelist: OracleWhitelist
  ) {
    const protocolVault = await this.getProtocolVaultContract();
    const whitelistHash = await protocolVault.getOracleWhitelistHash();

    whitelistHash.assertEquals(
      Poseidon.hash(OracleWhitelist.toFields(whitelist)),
      ZkUsdPriceFeedOracleErrors.INVALID_WHITELIST
    );

    let isWhitelisted = Bool(false);
    for (let i = 0; i < whitelist.addresses.length; i++) {
      isWhitelisted = isWhitelisted.or(
        submitter.equals(whitelist.addresses[i])
      );
    }

    isWhitelisted.assertTrue(ZkUsdPriceFeedOracleErrors.SENDER_NOT_WHITELISTED);
  }

  private async validatePendingActions(submitter: PublicKey): Promise<void> {
    const actionState = this.actionState.getAndRequireEquals();
    const pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    const hasPendingAction = this.reducer.reduce(
      pendingActions,
      Bool,
      (state: Bool, action: PriceFeedAction) => {
        return Provable.if(action.address.equals(submitter), Bool(true), state);
      },
      Bool(false),
      { skipActionStatePrecondition: true }
    );

    hasPendingAction.assertFalse(
      ZkUsdPriceFeedOracleErrors.PENDING_ACTION_EXISTS
    );
  }

  @method async stopTheProtocol() {
    const protocolVault = await this.getProtocolVaultContract();
    const canStop = await protocolVault.canStopTheProtocol();
    canStop.assertTrue();
    this.protocolEmergencyStop.set(Bool(true));
  }

  @method async resumeTheProtocol() {
    const protocolVault = await this.getProtocolVaultContract();
    const canResume = await protocolVault.canResumeTheProtocol();
    canResume.assertTrue();
    this.protocolEmergencyStop.set(Bool(false));
  }

  @method async updateFallbackPrice(price: UInt64) {
    //Ensure price is greater than zero
    price
      .greaterThan(UInt64.zero)
      .assertTrue(ZkUsdPriceFeedOracleErrors.AMOUNT_ZERO);

    const { isOddBlock } = this.getBlockInfo();

    const currentPrices = this.getAndRequireCurrentFallbackPrices();

    const protocolVault = await this.getProtocolVaultContract();
    const canUpdateFallbackPrice = await protocolVault.canUpdateFallbackPrice(
      this.self
    );
    canUpdateFallbackPrice.assertTrue();

    const { evenPrice, oddPrice } = this.updateBlockPrices(
      isOddBlock,
      price,
      currentPrices
    );

    this.fallbackPriceEvenBlock.set(evenPrice);
    this.fallbackPriceOddBlock.set(oddPrice);
  }

  @method async submitPrice(price: UInt64, whitelist: OracleWhitelist) {
    const submitter = this.sender.getAndRequireSignatureV2();

    const protocolVault = await this.getProtocolVaultContract();
    const oracleFee = await protocolVault.getOracleFee();

    //Ensure price is greater than zero
    price
      .greaterThan(UInt64.zero)
      .assertTrue(ZkUsdPriceFeedOracleErrors.AMOUNT_ZERO);

    await this.validateWhitelist(submitter, whitelist);
    await this.validatePendingActions(submitter);

    const priceFeedAction = new PriceFeedAction({
      address: submitter,
      price,
    });

    // Pay the oracle fee for the price submission

    const receiverUpdate = AccountUpdate.createSigned(submitter);

    receiverUpdate.balance.addInPlace(oracleFee);
    this.balance.subInPlace(oracleFee);

    this.reducer.dispatch(priceFeedAction);
  }

  @method async settlePriceUpdate() {
    const { isOddBlock } = this.getBlockInfo();
    this.requireCorrectFallbackPrices(isOddBlock);

    let fallbackPrice = Provable.if(
      isOddBlock,
      this.fallbackPriceEvenBlock.get(),
      this.fallbackPriceOddBlock.get()
    );

    let actionState = this.actionState.getAndRequireEquals();
    let pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    let priceArray = Array(ZkUsdPriceFeedOracle.MAX_PARTICIPANTS).fill(
      fallbackPrice
    );
    let initialState = {
      prices: priceArray,
      count: UInt64.zero,
    };

    let newState = this.reducer.reduce(
      pendingActions,
      PriceState,
      (state: PriceState, action: PriceFeedAction) => {
        let newPrices = state.prices.map((price, i) => {
          let condition = state.count.equals(UInt64.from(i));
          return Provable.if(condition, action.price, price);
        });

        let newCount = Provable.if(
          state.count.lessThan(
            UInt64.from(ZkUsdPriceFeedOracle.MAX_PARTICIPANTS)
          ),
          state.count.add(1),
          state.count
        );

        return {
          prices: newPrices,
          count: newCount,
        };
      },
      initialState,
      {
        maxActionsPerUpdate: ZkUsdPriceFeedOracle.MAX_PARTICIPANTS,
        skipActionStatePrecondition: true,
      }
    );

    let medianPrice = Provable.if(
      newState.count.greaterThan(UInt64.zero),
      this.calculateMedian(newState, fallbackPrice),
      fallbackPrice
    );

    const currentPrices = this.getAndRequireCurrentPrices();

    const { evenPrice, oddPrice } = this.updateBlockPrices(
      isOddBlock,
      medianPrice,
      currentPrices
    );

    this.priceEvenBlock.set(evenPrice);
    this.priceOddBlock.set(oddPrice);

    //set the action state
    this.actionState.set(pendingActions.hash);
  }

  @method.returns(UInt64)
  async getPrice() {
    const isProtocolHalted = this.protocolEmergencyStop.getAndRequireEquals();

    isProtocolHalted.assertFalse(ZkUsdPriceFeedOracleErrors.EMERGENCY_HALT);

    const { isOddBlock } = this.getBlockInfo();
    const prices = this.getCurrentPrices();

    this.priceOddBlock.requireEqualsIf(isOddBlock, prices.odd);
    this.priceEvenBlock.requireEqualsIf(isOddBlock.not(), prices.even);

    return Provable.if(isOddBlock, prices.odd, prices.even);
  }

  @method.returns(UInt64)
  async getFallbackPrice() {
    const { isOddBlock } = this.getBlockInfo();
    const prices = this.getCurrentFallbackPrices();

    this.fallbackPriceOddBlock.requireEqualsIf(isOddBlock, prices.odd);
    this.fallbackPriceEvenBlock.requireEqualsIf(isOddBlock.not(), prices.even);

    return Provable.if(isOddBlock, prices.odd, prices.even);
  }

  private calculateMedian(
    priceState: PriceState,
    fallbackPrice: UInt64
  ): UInt64 {
    const paddedPrices = priceState.prices.map((price, i) => {
      return Provable.if(
        UInt64.from(i).lessThan(priceState.count),
        price,
        fallbackPrice
      );
    });

    const effectiveCount = Provable.if(
      priceState.count.lessThan(UInt64.from(3)),
      UInt64.from(3),
      priceState.count
    );

    // Sort prices using bubble sort
    for (let i = 0; i < ZkUsdPriceFeedOracle.MAX_PARTICIPANTS - 1; i++) {
      for (let j = 0; j < ZkUsdPriceFeedOracle.MAX_PARTICIPANTS - i - 1; j++) {
        let shouldSwap = paddedPrices[j].greaterThan(paddedPrices[j + 1]);
        let temp = Provable.if(
          shouldSwap,
          paddedPrices[j],
          paddedPrices[j + 1]
        );
        paddedPrices[j] = Provable.if(
          shouldSwap,
          paddedPrices[j + 1],
          paddedPrices[j]
        );
        paddedPrices[j + 1] = temp;
      }
    }

    const conditions = [];
    for (let i = 3; i <= ZkUsdPriceFeedOracle.MAX_PARTICIPANTS; i++) {
      conditions.push(effectiveCount.equals(UInt64.from(i)));
    }

    const medianValues = [];
    for (let i = 3; i <= ZkUsdPriceFeedOracle.MAX_PARTICIPANTS; i++) {
      if (i % 2 === 0) {
        let middleIndex = i / 2;
        medianValues.push(
          paddedPrices[middleIndex - 1]
            .add(paddedPrices[middleIndex])
            .div(UInt64.from(2))
        );
      } else {
        let middleIndex = (i - 1) / 2;
        medianValues.push(paddedPrices[middleIndex]);
      }
    }

    return Provable.switch(conditions, UInt64, medianValues);
  }
}
