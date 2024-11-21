import {
  SmartContract,
  state,
  State,
  UInt64,
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
} from 'o1js';
import { OracleWhitelist, ZkUsdProtocolVault } from './zkusd-protocol-vault';

/**
 * @title   zkUSD Price Feed Oracle Contract

 * @notice  This contract manages price feed data for the zkUSD protocol.
 *          It allows whitelisted oracles to submit price updates and calculates
 *          the median price from multiple submissions. The contract also maintains
 *          fallback prices and can be halted in emergency situations.
 * @dev     Price updates are processed in even/odd blocks to allow for concurrency as prices are read
 *          from the contract and updated in the same block. This ensures we don't invalidate preconditions from the vaults
 *          that read the price from this contract.
 * @dev     The contract uses a reducer pattern to handle pending price submissions. As we will only ever have 10 trusted oracles,
 *          and we only allow one price update per oracle, we can safely use this pattern as there will only ever be a maximum of 10
 *          pending actions to process.
 */

// Errors
export const ZkUsdPriceFeedOracleErrors = {
  SENDER_NOT_WHITELISTED: 'Sender not in the whitelist',
  INVALID_WHITELIST: 'Invalid whitelist',
  PENDING_ACTION_EXISTS: 'Address already has a pending action',
  EMERGENCY_HALT:
    'Oracle is in emergency mode - all protocol actions are suspended',
  AMOUNT_ZERO: 'Amount must be greater than zero',
};

// Structs
export class PriceFeedAction extends Struct({
  address: PublicKey,
  price: UInt64,
}) {}

export class PriceState extends Struct({
  prices: Provable.Array(UInt64, 10),
  count: UInt64,
}) {}

// Events
export class PriceUpdateEvent extends Struct({
  newPrice: UInt64,
  blockNumber: UInt32,
  isOddBlock: Bool,
}) {}

export class FallbackPriceUpdateEvent extends Struct({
  newPrice: UInt64,
  blockNumber: UInt32,
  isOddBlock: Bool,
}) {}

export class PriceSubmissionEvent extends Struct({
  submitter: PublicKey,
  price: UInt64,
  oracleFee: UInt64,
}) {}

export class EmergencyStopEvent extends Struct({
  blockNumber: UInt32,
}) {}

export class EmergencyResumeEvent extends Struct({
  blockNumber: UInt32,
}) {}

export class ZkUsdPriceFeedOracle extends SmartContract {
  // State Variables
  @state(UInt64) priceEvenBlock = State<UInt64>();
  @state(UInt64) priceOddBlock = State<UInt64>();
  @state(UInt64) fallbackPriceEvenBlock = State<UInt64>();
  @state(UInt64) fallbackPriceOddBlock = State<UInt64>();
  @state(Field) actionState = State<Field>();
  @state(Bool) protocolEmergencyStop = State<Bool>(Bool(false)); // Flag to halt the protocol in case of emergency

  // We use the protocol vault address as a constant to avoid having to store it in the state - the vault address should never change
  static PROTOCOL_VAULT_ADDRESS = PublicKey.fromBase58(
    'B62qkJvkDUiw1c7kKn3PBa9YjNFiBgSA6nbXUJiVuSU128mKH4DiSih'
  );

  // We will only ever have 10 trusted oracles
  static MAX_PARTICIPANTS = 10;

  static ZkUsdProtocolVaultContract: new (...args: any) => ZkUsdProtocolVault =
    ZkUsdProtocolVault;

  // Reducer definition
  reducer = Reducer({ actionType: PriceFeedAction });

  readonly events = {
    PriceUpdate: PriceUpdateEvent,
    FallbackPriceUpdate: FallbackPriceUpdateEvent,
    PriceSubmission: PriceSubmissionEvent,
    EmergencyStop: EmergencyStopEvent,
    EmergencyResume: EmergencyResumeEvent,
  };

  /**
   * @notice  Deploys the oracle contract and sets initial state
   * @param   args.initialPrice We initialise the contract with a price
   */
  async deploy(
    args: DeployArgs & {
      initialPrice: UInt64;
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

  /**
   * @notice  Halts all protocol operations in emergency situations
   * @dev     Can only be called by authorized addresses via protocol vault
   */
  @method async stopTheProtocol() {
    //Precondition
    const isAlreadyHalted = this.protocolEmergencyStop.getAndRequireEquals();

    //Assertions
    isAlreadyHalted.assertFalse(ZkUsdPriceFeedOracleErrors.EMERGENCY_HALT);

    //Do we have the right permissions to stop the protocol?
    const protocolVault = await this.getProtocolVaultContract();
    const canStop = await protocolVault.canStopTheProtocol();
    canStop.assertTrue();

    //Stop the protocol
    this.protocolEmergencyStop.set(Bool(true));

    // Add emergency stop event
    this.emitEvent(
      'EmergencyStop',
      new EmergencyStopEvent({
        blockNumber: this.network.blockchainLength.getAndRequireEquals(),
      })
    );
  }

  /**
   * @notice  Resumes protocol operations after emergency halt
   * @dev     Can only be called by authorized addresses via protocol vault
   */
  @method async resumeTheProtocol() {
    //Precondition
    const isHalted = this.protocolEmergencyStop.getAndRequireEquals();

    //Assertions
    isHalted.assertTrue(ZkUsdPriceFeedOracleErrors.EMERGENCY_HALT);

    //Do we have the right permissions to resume the protocol?
    const protocolVault = await this.getProtocolVaultContract();
    const canResume = await protocolVault.canResumeTheProtocol();
    canResume.assertTrue();

    //Resume the protocol
    this.protocolEmergencyStop.set(Bool(false));

    // Add emergency resume event
    this.emitEvent(
      'EmergencyResume',
      new EmergencyResumeEvent({
        blockNumber: this.network.blockchainLength.getAndRequireEquals(),
      })
    );
  }

  /**
   * @notice  Updates the fallback price which is used if we don't have enough oracle submissions to calculate a median
   * @param   price The new fallback price
   */
  @method async updateFallbackPrice(price: UInt64) {
    //Preconditions
    const currentPrices = this.getAndRequireCurrentFallbackPrices();
    const { isOddBlock } = this.getBlockInfo();

    //Ensure price is greater than zero
    price
      .greaterThan(UInt64.zero)
      .assertTrue(ZkUsdPriceFeedOracleErrors.AMOUNT_ZERO);

    //Do we have the right permissions to update the fallback price?
    const protocolVault = await this.getProtocolVaultContract();
    const canUpdateFallbackPrice = await protocolVault.canUpdateFallbackPrice(
      this.self
    );
    canUpdateFallbackPrice.assertTrue();

    //Update the fallback price based on the current block
    const { evenPrice, oddPrice } = this.updateBlockPrices(
      isOddBlock,
      price,
      currentPrices
    );

    //Set the new fallback price
    this.fallbackPriceEvenBlock.set(evenPrice);
    this.fallbackPriceOddBlock.set(oddPrice);

    // Add fallback price update event
    this.emitEvent(
      'FallbackPriceUpdate',
      new FallbackPriceUpdateEvent({
        newPrice: price,
        blockNumber: this.network.blockchainLength.getAndRequireEquals(),
        isOddBlock: isOddBlock,
      })
    );
  }

  /**
   * @notice  Submits a new price update from an oracle as an action to be reduced
   * @notice  This oracle contract should always have funds from the protocol to pay the oracle fee
   *          However in the event that it doesn't, we should not fail the price submission
   *          We hope that the oracles will have enough good will to continue to submit prices
   *          until the contract is funded again
   * @param   price The new price
   * @param   whitelist The whitelist of authorized oracles
   */
  @method async submitPrice(price: UInt64, whitelist: OracleWhitelist) {
    //We need to ensure the sender is the oracle in the whitelist
    const submitter = this.sender.getAndRequireSignatureV2();
    const balance = this.account.balance.getAndRequireEquals();

    //Get the current oracle fee from the protocol vault
    const protocolVault = await this.getProtocolVaultContract();
    const oracleFee = await protocolVault.getOracleFee();

    //Ensure price is greater than zero
    price
      .greaterThan(UInt64.zero)
      .assertTrue(ZkUsdPriceFeedOracleErrors.AMOUNT_ZERO);

    //Validate the sender is authorized to submit a price update
    await this.validateWhitelist(submitter, whitelist);

    //Validate the sender does not already have a pending action in this "batch"
    await this.validatePendingActions(submitter);

    //Create the action
    const priceFeedAction = new PriceFeedAction({
      address: submitter,
      price,
    });

    //If the balance is less than the oracle fee, stop paying the fee
    const payout = Provable.if(
      balance.lessThan(oracleFee),
      UInt64.zero,
      oracleFee
    );

    // Pay the oracle fee for the price submission
    const receiverUpdate = AccountUpdate.create(submitter);

    receiverUpdate.balance.addInPlace(payout);
    this.balance.subInPlace(payout);

    //Dispatch the action
    this.reducer.dispatch(priceFeedAction);

    // Add price submission event
    this.emitEvent(
      'PriceSubmission',
      new PriceSubmissionEvent({
        submitter: submitter,
        price: price,
        oracleFee: payout,
      })
    );
  }

  /**
   * @notice  Settles pending price updates and calculates the median price
   * @dev     Updates the price based on the median of submitted prices.
   * @dev     It does this by maintaining an array of prices and a count of the number of prices submitted.
   *          It then reduces the array by replacing the fallback price with the submitted price if the index matches the count.
   *          It increments the count until it reaches the max number of participants, after which it will use the last submitted price in the array.
   *          We should never have more than 10 pending actions at one time.
   * @dev     The median price is calculated with the new state. If we have less than 3 submitted prices, we use the fallback price in the median calculation.
   */
  @method async settlePriceUpdate() {
    //Preconditions
    const { isOddBlock } = this.getBlockInfo();
    this.requireCorrectFallbackPrices(isOddBlock);
    let actionState = this.actionState.getAndRequireEquals();
    const currentPrices = this.getAndRequireCurrentPrices();

    //Get the right fallback price based on the current block
    let fallbackPrice = Provable.if(
      isOddBlock,
      this.fallbackPriceEvenBlock.get(),
      this.fallbackPriceOddBlock.get()
    );

    //Get the pending actions
    let pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    //Create an array of fallback prices
    let priceArray = Array(ZkUsdPriceFeedOracle.MAX_PARTICIPANTS).fill(
      fallbackPrice
    );

    //Create the initial state
    let initialState = {
      prices: priceArray,
      count: UInt64.zero,
    };

    //Reduce the pending actions
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
      }
    );

    //Calculate the median price
    let medianPrice = Provable.if(
      newState.count.greaterThan(UInt64.zero),
      this.calculateMedian(newState, fallbackPrice),
      fallbackPrice
    );

    //Update the correct price based on the median price
    const { evenPrice, oddPrice } = this.updateBlockPrices(
      isOddBlock,
      medianPrice,
      currentPrices
    );

    this.priceEvenBlock.set(evenPrice);
    this.priceOddBlock.set(oddPrice);

    //set the action state
    this.actionState.set(pendingActions.hash);

    // Add price update event
    this.emitEvent(
      'PriceUpdate',
      new PriceUpdateEvent({
        newPrice: medianPrice,
        blockNumber: this.network.blockchainLength.get(),
        isOddBlock: isOddBlock,
      })
    );
  }

  /**
   * @notice  Returns the current price
   * @notice  If the protcol is halted, this will fail, meaning that no actions can be taken from the vaults
   * @returns The price based on the current block
   */
  @method.returns(UInt64)
  async getPrice() {
    //Preconditions
    const isProtocolHalted = this.protocolEmergencyStop.getAndRequireEquals();
    const { isOddBlock } = this.getBlockInfo();

    //Ensure the protocol is not halted
    isProtocolHalted.assertFalse(ZkUsdPriceFeedOracleErrors.EMERGENCY_HALT);

    //Get the current prices
    const prices = this.getCurrentPrices();

    //Ensure the correct price is returned based on the current block
    this.priceOddBlock.requireEqualsIf(isOddBlock, prices.odd);
    this.priceEvenBlock.requireEqualsIf(isOddBlock.not(), prices.even);

    return Provable.if(isOddBlock, prices.odd, prices.even);
  }

  /**
   * @notice  Returns the current fallback price
   * @returns The fallback price based on the current block
   */
  @method.returns(UInt64)
  async getFallbackPrice() {
    //Preconditions
    const { isOddBlock } = this.getBlockInfo();
    const prices = this.getCurrentFallbackPrices();

    this.fallbackPriceOddBlock.requireEqualsIf(isOddBlock, prices.odd);
    this.fallbackPriceEvenBlock.requireEqualsIf(isOddBlock.not(), prices.even);

    return Provable.if(isOddBlock, prices.odd, prices.even);
  }

  /**
   * @notice  Returns the protocol vault contract
   * @returns The protocol vault contract
   */
  public async getProtocolVaultContract(): Promise<ZkUsdProtocolVault> {
    return new ZkUsdPriceFeedOracle.ZkUsdProtocolVaultContract(
      ZkUsdPriceFeedOracle.PROTOCOL_VAULT_ADDRESS
    );
  }

  /**
   * @notice  Returns the current block info to be used to set the isOddBlock flag
   * @returns The current block length and the isOddBlock flag
   */
  private getBlockInfo(): { blockchainLength: UInt32; isOddBlock: Bool } {
    const blockchainLength =
      this.network.blockchainLength.getAndRequireEquals();
    const isOddBlock = blockchainLength.mod(2).equals(UInt32.from(1));
    return { blockchainLength, isOddBlock };
  }

  /**
   * @notice  Ensures the correct fallback price is set based on the current block
   * @param   isOddBlock The isOddBlock flag
   */
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

  /**
   * @notice  Updates the price based on the current block, if we are on an odd block, we update the even price, otherwise we update the odd price
   * @param   isOddBlock The isOddBlock flag
   * @param   newPrice The new price
   * @param   currentPrices The current prices
   * @returns The updated prices
   */
  private updateBlockPrices(
    isOddBlock: Bool,
    newPrice: UInt64,
    currentPrices: { even: UInt64; odd: UInt64 }
  ) {
    const evenPrice = Provable.if(isOddBlock, newPrice, currentPrices.even);
    const oddPrice = Provable.if(isOddBlock.not(), newPrice, currentPrices.odd);
    return { evenPrice, oddPrice };
  }

  /**
   * @notice  Helper function to return the current prices
   * @returns The current prices
   */
  private getCurrentPrices(): { even: UInt64; odd: UInt64 } {
    return {
      even: this.priceEvenBlock.get(),
      odd: this.priceOddBlock.get(),
    };
  }

  /**
   * @notice  Helper function to return the current prices and set the preconditions
   * @returns The current prices
   */
  private getAndRequireCurrentPrices(): { even: UInt64; odd: UInt64 } {
    return {
      even: this.priceEvenBlock.getAndRequireEquals(),
      odd: this.priceOddBlock.getAndRequireEquals(),
    };
  }

  /**
   * @notice  Helper function to return the current fallback prices
   * @returns The current fallback prices
   */
  private getCurrentFallbackPrices(): { even: UInt64; odd: UInt64 } {
    return {
      even: this.fallbackPriceEvenBlock.get(),
      odd: this.fallbackPriceOddBlock.get(),
    };
  }

  /**
   * @notice  Helper function to return the current fallback prices and set the preconditions
   * @returns The current fallback prices
   */
  private getAndRequireCurrentFallbackPrices(): {
    even: UInt64;
    odd: UInt64;
  } {
    return {
      even: this.fallbackPriceEvenBlock.getAndRequireEquals(),
      odd: this.fallbackPriceOddBlock.getAndRequireEquals(),
    };
  }

  /**
   * @notice  Validates the sender is in the whitelist. The whitelist hash is maintained in the protocol vault.
   * @param   submitter The sender
   * @param   whitelist The whitelist
   */
  private async validateWhitelist(
    submitter: PublicKey,
    whitelist: OracleWhitelist
  ) {
    //Gets the current whitelist hash from the protocol vault
    const protocolVault = await this.getProtocolVaultContract();
    const whitelistHash = await protocolVault.getOracleWhitelistHash();

    //Ensure the whitelist hash matches the submitted whitelist
    whitelistHash.assertEquals(
      Poseidon.hash(OracleWhitelist.toFields(whitelist)),
      ZkUsdPriceFeedOracleErrors.INVALID_WHITELIST
    );

    //Check if the sender is in the whitelist
    let isWhitelisted = Bool(false);
    for (let i = 0; i < whitelist.addresses.length; i++) {
      isWhitelisted = isWhitelisted.or(
        submitter.equals(whitelist.addresses[i])
      );
    }

    isWhitelisted.assertTrue(ZkUsdPriceFeedOracleErrors.SENDER_NOT_WHITELISTED);
  }

  /**
   * @notice  Validates the sender does not already have a pending action in this "batch"
   * @param   submitter The sender
   */
  private async validatePendingActions(submitter: PublicKey): Promise<void> {
    //Precondition

    // IMPORTANT: Is this going to be a problem? We are setting a precondition on the action state when we validate the pending actions
    // then we are also going to be setting the action state in the settlePriceUpdate method which would invalidate the precondition.
    // can we guarentee that the settlePriceUpdate will be processed last?
    // If not, we might need to rethink this approach.
    // For example: can we maintain different actions states for each block type - odd/even?
    const actionState = this.actionState.getAndRequireEquals();

    //Get the pending actions
    const pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    //Check if the sender has a pending action against
    const hasPendingAction = this.reducer.reduce(
      pendingActions,
      Bool,
      (state: Bool, action: PriceFeedAction) => {
        return Provable.if(action.address.equals(submitter), Bool(true), state);
      },
      Bool(false)
    );

    //Ensure the sender does not have a pending action
    hasPendingAction.assertFalse(
      ZkUsdPriceFeedOracleErrors.PENDING_ACTION_EXISTS
    );
  }

  /**
   * @notice  Calculates the median price from submitted oracle prices
   * @dev     The function follows these steps:
   *          1. Pads the price array with fallback prices if we have fewer than 3 submissions
   *          2. Sorts all prices using bubble sort
   *          3. Calculates median based on the effective count:
   *            - For odd counts: takes the middle value
   *            - For even counts: averages the two middle values
   * @param   priceState Contains the array of submitted prices and count of submissions
   * @param   fallbackPrice Used to pad the array if we have fewer than 3 submissions
   * @returns The calculated median price
   */
  private calculateMedian(
    priceState: PriceState,
    fallbackPrice: UInt64
  ): UInt64 {
    // Pad array with fallback prices for any unused slots
    // If we have 2 submissions, the array will contain: [price1, price2, fallbackPrice, fallbackPrice, ...]
    const paddedPrices = priceState.prices.map((price, i) => {
      return Provable.if(
        UInt64.from(i).lessThan(priceState.count),
        price,
        fallbackPrice
      );
    });

    // If we have fewer than 3 submissions, use 3 as the effective count
    // This ensures we always calculate median using at least 3 values
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

    // Create conditions for each possible count (3 through MAX_PARTICIPANTS)
    // We'll use these to select the correct median calculation
    const conditions = [];
    for (let i = 3; i <= ZkUsdPriceFeedOracle.MAX_PARTICIPANTS; i++) {
      conditions.push(effectiveCount.equals(UInt64.from(i)));
    }

    // Calculate potential median values for each possible count
    // For even counts: average of two middle values
    // For odd counts: middle value
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

    // Select the correct median value based on our effective count
    return Provable.switch(conditions, UInt64, medianValues);
  }
}
