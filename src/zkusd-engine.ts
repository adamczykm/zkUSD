import { FungibleToken, FungibleTokenAdminBase } from 'mina-fungible-token';
import {
  AccountUpdate,
  Bool,
  DeployArgs,
  Field,
  method,
  Provable,
  PublicKey,
  Reducer,
  SmartContract,
  State,
  state,
  Struct,
  UInt32,
  UInt64,
  Permissions,
  assert,
  VerificationKey,
  Poseidon,
  TokenContractV2,
  AccountUpdateForest,
  Int64,
} from 'o1js';
import { ZkUsdVault } from './zkusd-vault-n';
import { ProtocolDataPacked, ProtocolData, VaultState } from './types';
import { PriceFeedAction, PriceState } from './zkusd-price-feed-oracle';
import { OracleWhitelist } from './zkusd-protocol-vault';

// Errors
export const ZkUsdEngineErrors = {
  SENDER_NOT_WHITELISTED: 'Sender not in the whitelist',
  INVALID_WHITELIST: 'Invalid whitelist',
  PENDING_ACTION_EXISTS: 'Address already has a pending action',
  EMERGENCY_HALT:
    'Oracle is in emergency mode - all protocol actions are suspended',
  AMOUNT_ZERO: 'Amount must be greater than zero',
  INVALID_FEE:
    'Protocol fee is a percentage and must be less than or equal to 100',
  INSUFFICIENT_BALANCE: 'Insufficient balance for withdrawal',
};

// Event Definitions

// Events
export class NewVaultEvent extends Struct({
  vaultAddress: PublicKey,
}) {}

export class DepositCollateralEvent extends Struct({
  vaultAddress: PublicKey,
  amountDeposited: UInt64,
  vaultCollateralAmount: UInt64,
  vaultDebtAmount: UInt64,
}) {}

export class RedeemCollateralEvent extends Struct({
  vaultAddress: PublicKey,
  amountRedeemed: UInt64,
  vaultCollateralAmount: UInt64,
  vaultDebtAmount: UInt64,
}) {}

export class MintZkUsdEvent extends Struct({
  vaultAddress: PublicKey,
  amountMinted: UInt64,
  vaultCollateralAmount: UInt64,
  vaultDebtAmount: UInt64,
}) {}

export class BurnZkUsdEvent extends Struct({
  vaultAddress: PublicKey,
  amountBurned: UInt64,
  vaultCollateralAmount: UInt64,
  vaultDebtAmount: UInt64,
}) {}

export class LiquidateEvent extends Struct({
  vaultAddress: PublicKey,
  liquidator: PublicKey,
  vaultCollateralLiquidated: UInt64,
  vaultDebtRepaid: UInt64,
  price: UInt64,
}) {}

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

// Event Definitions
export class AdminUpdatedEvent extends Struct({
  previousAdmin: PublicKey,
  newAdmin: PublicKey,
  blockNumber: UInt32,
}) {}

export class OracleWhitelistUpdatedEvent extends Struct({
  previousHash: Field,
  newHash: Field,
  blockNumber: UInt32,
}) {}

export class ProtocolFeeUpdated extends Struct({
  previousFee: UInt64,
  newFee: UInt64,
  blockNumber: UInt32,
}) {}

export class OracleFeeUpdated extends Struct({
  previousFee: UInt64,
  newFee: UInt64,
  blockNumber: UInt32,
}) {}

export class FundsWithdrawnEvent extends Struct({
  recipient: PublicKey,
  amount: UInt64,
  blockNumber: UInt32,
}) {}

export interface ZkUsdEngineDeployProps extends Exclude<DeployArgs, undefined> {
  initialPrice: UInt64;
  admin: PublicKey;
  oracleFlatFee: UInt64;
  protocolPercentageFee: UInt32;
  emergencyStop: Bool;
  vaultVerificationKeyHash: Field;
}

export class ZkUsdEngine
  extends TokenContractV2
  implements FungibleTokenAdminBase
{
  @state(UInt64) priceEvenBlock = State<UInt64>();
  @state(UInt64) priceOddBlock = State<UInt64>();
  @state(Field) actionState = State<Field>();
  @state(Field) oracleWhitelistHash = State<Field>(); // Hash of the oracle whitelist
  @state(ProtocolDataPacked) protocolDataPacked = State<ProtocolDataPacked>();
  @state(Field) vaultVerificationKeyHash = State<Field>(); // Hash of the vault verification key
  @state(Bool) interactionFlag = State<Bool>(); // Flag to prevent reentrancy

  // We will only ever have 10 trusted oracles
  // We need at least 3 price submissions to calculate the median, otherwise we fail out
  static MAX_PARTICIPANTS = 10;
  static MIN_PRICE_SUBMISSIONS = 3;

  //We hardcode the token address for the zkUSD token
  static ZKUSD_TOKEN_ADDRESS = PublicKey.fromBase58(
    'B62qry2wngUSGZqQn9erfnA9rZPn4cMbDG1XPasGdK1EtKQAxmgjDtt'
  );

  // Reducer definition
  reducer = Reducer({ actionType: PriceFeedAction });

  readonly events = {
    PriceUpdate: PriceUpdateEvent,
    FallbackPriceUpdate: FallbackPriceUpdateEvent,
    PriceSubmission: PriceSubmissionEvent,
    EmergencyStop: EmergencyStopEvent,
    EmergencyResume: EmergencyResumeEvent,
    AdminUpdated: AdminUpdatedEvent,
    OracleWhitelistUpdated: OracleWhitelistUpdatedEvent,
    ProtocolFeeUpdated: ProtocolFeeUpdated,
    OracleFeeUpdated: OracleFeeUpdated,
    FundsWithdrawn: FundsWithdrawnEvent,
    NewVault: NewVaultEvent,
    DepositCollateral: DepositCollateralEvent,
    RedeemCollateral: RedeemCollateralEvent,
    MintZkUsd: MintZkUsdEvent,
    BurnZkUsd: BurnZkUsdEvent,
    Liquidate: LiquidateEvent,
  };

  /**
   * @notice  Deploys the oracle contract and sets initial state
   * @param   args.initialPrice We initialise the contract with a price
   */
  async deploy(args: ZkUsdEngineDeployProps) {
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

    this.oracleWhitelistHash.set(Field.from(0));

    this.protocolDataPacked.set(
      ProtocolData.new({
        admin: args.admin,
        oracleFlatFee: args.oracleFlatFee,
        protocolPercentageFee: args.protocolPercentageFee,
        emergencyStop: args.emergencyStop,
      }).pack()
    );

    this.vaultVerificationKeyHash.set(args.vaultVerificationKeyHash);
  }

  //Blocks the updating of state of the token accounts
  approveBase(forest: AccountUpdateForest): Promise<void> {
    throw Error('Updates Blocked');
  }

  @method async initialize() {
    let au = AccountUpdate.createSigned(this.address, this.deriveTokenId());
    let permissions = Permissions.default();
    permissions.send = Permissions.none();
    permissions.setPermissions = Permissions.impossible();
    au.account.permissions.set(permissions);
  }

  @method.returns(UInt64)
  async getTotalDepositedCollateral(): Promise<UInt64> {
    const account = AccountUpdate.create(
      this.address,
      this.deriveTokenId()
    ).account;
    const balance = account.balance.getAndRequireEquals();
    return balance;
  }

  //CREATE VAULT
  @method async createVault(vaultAddress: PublicKey) {
    const vaultVerificationKeyHash =
      this.vaultVerificationKeyHash.getAndRequireEquals();

    const tokenId = this.deriveTokenId();

    //Get the zkUSD token contract
    const zkUSD = new FungibleToken(ZkUsdEngine.ZKUSD_TOKEN_ADDRESS);

    const update = AccountUpdate.createSigned(vaultAddress, tokenId);
    update.body.useFullCommitment = Bool(true);
    update.account.isNew.getAndRequireEquals().assertTrue(); //Create message here

    const vaultVerificationKey = new VerificationKey(
      ZkUsdVault._verificationKey!
    );

    vaultVerificationKey.hash.assertEquals(vaultVerificationKeyHash);

    update.body.update.verificationKey = {
      isSome: Bool(true),
      value: vaultVerificationKey,
    };

    update.body.update.permissions = {
      isSome: Bool(true),
      value: {
        ...Permissions.default(),
        send: Permissions.proof(),
        // Allow the upgrade authority to set the verification key
        // even when there is no protocol upgrade
        setVerificationKey:
          Permissions.VerificationKey.impossibleDuringCurrentVersion(),
        setPermissions: Permissions.impossible(),
        access: Permissions.proof(),
        setZkappUri: Permissions.none(),
        setTokenSymbol: Permissions.none(),
      },
    };

    const owner = this.sender.getAndRequireSignatureV2();

    //Do this to avoid having to pay fee when they mint zkUSD
    await zkUSD.getBalanceOf(owner);

    const initialVaultState = new VaultState({
      collateralAmount: UInt64.zero,
      debtAmount: UInt64.zero,
      owner: owner,
    });

    // Convert vault state to fields
    const vaultStateFields = VaultState.toFields(initialVaultState);

    // Create an array of all 8 app state updates, setting unused fields to Field(0)
    const appStateUpdates = Array(8).fill({
      isSome: Bool(true),
      value: Field(0),
    });

    // Update only the fields we need
    vaultStateFields.forEach((field, index) => {
      appStateUpdates[index] = {
        isSome: Bool(true),
        value: field,
      };
    });

    update.body.update.appState = appStateUpdates;
    //Emit the NewVault event
    this.emitEvent(
      'NewVault',
      new NewVaultEvent({
        vaultAddress: this.address,
      })
    );
  }

  @method async depositCollateral(vaultAddress: PublicKey, amount: UInt64) {
    const tokenId = this.deriveTokenId();
    const vault = new ZkUsdVault(vaultAddress, tokenId);

    const collateralDeposit = AccountUpdate.createSigned(
      this.sender.getUnconstrainedV2()
    );

    collateralDeposit.send({
      to: this.address,
      amount: amount,
    });

    const owner = collateralDeposit.publicKey;

    const { collateralAmount, debtAmount } = await vault.depositCollateral(
      amount,
      owner
    );

    const totalDepositedCollateral = AccountUpdate.create(
      this.address,
      tokenId
    );
    totalDepositedCollateral.balanceChange = Int64.fromUnsigned(amount);
    //Emit the DepositCollateral event
    this.emitEvent(
      'DepositCollateral',
      new DepositCollateralEvent({
        vaultAddress: this.address,
        amountDeposited: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
      })
    );
  }

  @method async redeemCollateral(vaultAddress: PublicKey, amount: UInt64) {
    const tokenId = this.deriveTokenId();
    const vault = new ZkUsdVault(vaultAddress, tokenId);

    const price = await this.getPrice();
    const owner = this.sender.getAndRequireSignatureV2();

    const { collateralAmount, debtAmount } = await vault.redeemCollateral(
      amount,
      owner,
      price
    );

    //Send the collateral back to the sender
    this.send({
      to: owner,
      amount: amount,
    });

    const totalDepositedCollateral = AccountUpdate.create(
      this.address,
      tokenId
    );
    totalDepositedCollateral.balanceChange = Int64.fromUnsigned(amount).negV2();

    //Emit the RedeemCollateral event
    this.emitEvent(
      'RedeemCollateral',
      new RedeemCollateralEvent({
        vaultAddress: this.address,
        amountRedeemed: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
      })
    );
  }

  @method async mintZkUsd(vaultAddress: PublicKey, amount: UInt64) {
    const tokenId = this.deriveTokenId();
    const vault = new ZkUsdVault(vaultAddress, tokenId);

    //Get the zkUSD token contract
    const zkUSD = new FungibleToken(ZkUsdEngine.ZKUSD_TOKEN_ADDRESS);

    const price = await this.getPrice();
    const owner = this.sender.getAndRequireSignatureV2();

    const { collateralAmount, debtAmount } = await vault.mintZkUsd(
      amount,
      owner,
      price
    );

    //Mint the zkUSD for the recipient
    await zkUSD.mint(owner, amount);

    //Set the interaction flag to true
    this.interactionFlag.set(Bool(true));

    //Emit the MintZkUsd event
    this.emitEvent(
      'MintZkUsd',
      new MintZkUsdEvent({
        vaultAddress: this.address,
        amountMinted: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
      })
    );
  }

  @method async burnZkUsd(vaultAddress: PublicKey, amount: UInt64) {
    const tokenId = this.deriveTokenId();
    const vault = new ZkUsdVault(vaultAddress, tokenId);

    const owner = this.sender.getAndRequireSignatureV2();

    //Get the zkUSD token contract
    const zkUSD = new FungibleToken(ZkUsdEngine.ZKUSD_TOKEN_ADDRESS);

    const { collateralAmount, debtAmount } = await vault.burnZkUsd(
      amount,
      owner
    );

    //Burn the zkUSD from the sender
    await zkUSD.burn(owner, amount);

    this.emitEvent(
      'BurnZkUsd',
      new BurnZkUsdEvent({
        vaultAddress: this.address,
        amountBurned: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
      })
    );
  }

  @method async liquidate(vaultAddress: PublicKey) {
    const tokenId = this.deriveTokenId();
    const vault = new ZkUsdVault(vaultAddress, tokenId);

    //Get the zkUSD token contract
    const zkUSD = new FungibleToken(ZkUsdEngine.ZKUSD_TOKEN_ADDRESS);

    const liquidator = this.sender.getAndRequireSignatureV2();

    const price = await this.getPrice();

    const { collateralAmount, debtAmount } = await vault.liquidate(price);

    await zkUSD.burn(liquidator, debtAmount);

    //Send the collateral to the liquidator
    this.send({
      to: liquidator,
      amount: collateralAmount,
    });

    //Update the total deposited collateral
    const totalDepositedCollateral = AccountUpdate.create(
      this.address,
      tokenId
    );
    totalDepositedCollateral.balanceChange =
      Int64.fromUnsigned(collateralAmount).negV2();

    //Emit the Liquidate event
    this.emitEvent(
      'Liquidate',
      new LiquidateEvent({
        vaultAddress: this.address,
        liquidator: this.sender.getUnconstrainedV2(),
        vaultCollateralLiquidated: collateralAmount,
        vaultDebtRepaid: debtAmount,
        price: price,
      })
    );
  }

  /**
   * @notice  Internal helper to validate admin signature
   * @returns The signed account update from the admin
   */
  private async ensureAdminSignature(): Promise<AccountUpdate> {
    const protocolData = ProtocolData.unpack(
      this.protocolDataPacked.getAndRequireEquals()
    );
    return AccountUpdate.createSigned(protocolData.admin);
  }

  /**
   * @notice  Halts all protocol operations in emergency situations
   * @dev     Can only be called by authorized addresses via protocol vault
   */
  @method async stopTheProtocol() {
    const protocolData = ProtocolData.unpack(
      this.protocolDataPacked.getAndRequireEquals()
    );

    //Assertions
    protocolData.emergencyStop.assertFalse(ZkUsdEngineErrors.EMERGENCY_HALT);

    //Do we have the right permissions to stop the protocol?
    await this.ensureAdminSignature();

    //Stop the protocol
    protocolData.emergencyStop = Bool(true);
    this.protocolDataPacked.set(protocolData.pack());

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
    const protocolData = ProtocolData.unpack(
      this.protocolDataPacked.getAndRequireEquals()
    );

    //Assertions
    protocolData.emergencyStop.assertTrue(ZkUsdEngineErrors.EMERGENCY_HALT);

    //Do we have the right permissions to resume the protocol?
    await this.ensureAdminSignature();

    //Resume the protocol
    protocolData.emergencyStop = Bool(false);
    this.protocolDataPacked.set(protocolData.pack());

    // Add emergency resume event
    this.emitEvent(
      'EmergencyResume',
      new EmergencyResumeEvent({
        blockNumber: this.network.blockchainLength.getAndRequireEquals(),
      })
    );
  }

  /**
   * @notice  Updates the oracle whitelist hash
   * @param   whitelist The new oracle whitelist
   */
  @method async updateOracleWhitelist(whitelist: OracleWhitelist) {
    //Precondition
    const previousHash = this.oracleWhitelistHash.getAndRequireEquals();

    //Ensure admin signature
    await this.ensureAdminSignature();

    const updatedWhitelistHash = Poseidon.hash(
      OracleWhitelist.toFields(whitelist)
    );
    this.oracleWhitelistHash.set(updatedWhitelistHash);

    this.emitEvent('OracleWhitelistUpdated', {
      previousHash,
      newHash: updatedWhitelistHash,
      blockNumber: this.network.blockchainLength.getAndRequireEquals(),
    });
  }

  /**
   * @notice  Updates the protocol fee percentage
   * @param   fee The new protocol fee percentage
   */
  @method async updateProtocolFee(fee: UInt32) {
    //Precondition
    const protocolData = ProtocolData.unpack(
      this.protocolDataPacked.getAndRequireEquals()
    );

    const previousFee = protocolData.protocolPercentageFee;

    //Ensure admin signature
    await this.ensureAdminSignature();

    //Ensure the fee is less than or equal to 100 (its a percentage)
    fee.assertLessThanOrEqual(UInt32.from(100), ZkUsdEngineErrors.INVALID_FEE);

    protocolData.protocolPercentageFee = fee;
    this.protocolDataPacked.set(protocolData.pack());

    this.emitEvent('ProtocolFeeUpdated', {
      previousFee: previousFee,
      newFee: fee,
      blockNumber: this.network.blockchainLength.getAndRequireEquals(),
    });
  }

  /**
   * @notice  Updates the oracle fee
   * @param   fee The new oracle fee
   */
  @method async updateOracleFee(fee: UInt64) {
    //Precondition
    const protocolData = ProtocolData.unpack(
      this.protocolDataPacked.getAndRequireEquals()
    );

    const previousFee = protocolData.oracleFlatFee;
    //Ensure admin signature
    await this.ensureAdminSignature();

    protocolData.oracleFlatFee = fee;
    this.protocolDataPacked.set(protocolData.pack());

    this.emitEvent('OracleFeeUpdated', {
      previousFee: previousFee,
      newFee: fee,
      blockNumber: this.network.blockchainLength.getAndRequireEquals(),
    });
  }

  /**
   * @notice  Withdraws protocol funds
   * @param   recipient The recipient of the funds
   * @param   amount The amount of funds to withdraw
   */
  @method async withdrawProtocolFunds(recipient: PublicKey, amount: UInt64) {
    //THIS NEEDS TO BE REIMPLEMENTED
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
    const protocolData = ProtocolData.unpack(
      this.protocolDataPacked.getAndRequireEquals()
    );

    //Get the current oracle fee
    const oracleFee = protocolData.oracleFlatFee;

    //Ensure price is greater than zero
    price.greaterThan(UInt64.zero).assertTrue(ZkUsdEngineErrors.AMOUNT_ZERO);

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
    let actionState = this.actionState.getAndRequireEquals();
    const currentPrices = this.getAndRequireCurrentPrices();

    //Get the pending actions
    let pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    Provable.log('Number of pending actions', pendingActions);

    //Create an array of fallback prices
    let priceArray = Array(ZkUsdEngine.MAX_PARTICIPANTS).fill(UInt64.MAXINT());

    const maxInteger = UInt64.from(Number.MAX_SAFE_INTEGER);

    Provable.log('Max integer', maxInteger);
    Provable.log('Max UInt64', UInt64.MAXINT());

    //Create the initial state
    let initialState = {
      prices: priceArray,
      count: UInt64.zero,
    };

    Provable.log('Initial state', initialState);

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
          state.count.lessThan(UInt64.from(ZkUsdEngine.MAX_PARTICIPANTS)),
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
        maxActionsPerUpdate: ZkUsdEngine.MAX_PARTICIPANTS,
      }
    );

    Provable.log('New state', newState);

    //Calculate the median price as long as there is atleast a count of 3
    let medianPrice = Provable.if(
      newState.count.greaterThanOrEqual(
        UInt64.from(ZkUsdEngine.MIN_PRICE_SUBMISSIONS)
      ),
      this.calculateMedian(newState),
      UInt64.zero
    );

    //Only update the price if the new price is greater than zero
    medianPrice
      .greaterThan(UInt64.zero)
      .assertTrue(ZkUsdEngineErrors.AMOUNT_ZERO);

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

  async getPrice(): Promise<UInt64> {
    //Preconditions
    const protocolData = ProtocolData.unpack(
      this.protocolDataPacked.getAndRequireEquals()
    );
    const { isOddBlock } = this.getBlockInfo();

    //Ensure the protocol is not halted
    protocolData.emergencyStop.assertFalse(ZkUsdEngineErrors.EMERGENCY_HALT);

    //Get the current prices
    const prices = this.getCurrentPrices();

    //Ensure the correct price is returned based on the current block
    this.priceOddBlock.requireEqualsIf(isOddBlock, prices.odd);
    this.priceEvenBlock.requireEqualsIf(isOddBlock.not(), prices.even);

    return Provable.if(isOddBlock, prices.odd, prices.even);
  }

  /**
   * @notice  This method is used to assert the interaction flag, this is used to ensure that the zkUSD token contract knows it is being called from the vault
   * @returns True if the flag is set
   */

  private assertInteractionFlag() {
    this.interactionFlag.requireEquals(Bool(true));
    this.interactionFlag.set(Bool(false));
    return Bool(true);
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
   * @notice  Validates the sender is in the whitelist. The whitelist hash is maintained in the protocol vault.
   * @param   submitter The sender
   * @param   whitelist The whitelist
   */
  private async validateWhitelist(
    submitter: PublicKey,
    whitelist: OracleWhitelist
  ) {
    //Gets the current whitelist hash from the protocol vault
    const whitelistHash = this.oracleWhitelistHash.getAndRequireEquals();

    //Ensure the whitelist hash matches the submitted whitelist
    whitelistHash.assertEquals(
      Poseidon.hash(OracleWhitelist.toFields(whitelist)),
      ZkUsdEngineErrors.INVALID_WHITELIST
    );

    //Check if the sender is in the whitelist
    let isWhitelisted = Bool(false);
    for (let i = 0; i < whitelist.addresses.length; i++) {
      isWhitelisted = isWhitelisted.or(
        submitter.equals(whitelist.addresses[i])
      );
    }

    isWhitelisted.assertTrue(ZkUsdEngineErrors.SENDER_NOT_WHITELISTED);
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
    hasPendingAction.assertFalse(ZkUsdEngineErrors.PENDING_ACTION_EXISTS);
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
  private calculateMedian(priceState: PriceState): UInt64 {
    // Pad array with fallback prices for any unused slots
    // If we have 2 submissions, the array will contain: [price1, price2, fallbackPrice, fallbackPrice, ...]
    const prices = [...priceState.prices];

    Provable.log('Prices', prices);

    // Sort prices using bubble sort
    for (let i = 0; i < ZkUsdEngine.MAX_PARTICIPANTS - 1; i++) {
      for (let j = 0; j < ZkUsdEngine.MAX_PARTICIPANTS - i - 1; j++) {
        let shouldSwap = prices[j].greaterThan(prices[j + 1]);
        let temp = Provable.if(shouldSwap, prices[j], prices[j + 1]);
        prices[j] = Provable.if(shouldSwap, prices[j + 1], prices[j]);
        prices[j + 1] = temp;
      }
    }

    Provable.log('Sorted prices', prices);

    // Create conditions for each possible count (1 through MAX_PARTICIPANTS)
    const conditions = [];
    for (let i = 1; i <= ZkUsdEngine.MAX_PARTICIPANTS; i++) {
      conditions.push(priceState.count.equals(UInt64.from(i)));
    }

    // Calculate potential median values for each possible count
    // For even counts: average of two middle values
    // For odd counts: middle value
    const medianValues = [];
    for (let i = 1; i <= ZkUsdEngine.MAX_PARTICIPANTS; i++) {
      if (i % 2 === 0) {
        Provable.log('Even count', i);
        let middleIndex = i / 2;

        let firstMiddleNumber = Provable.if(
          prices[middleIndex - 1].equals(UInt64.MAXINT()),
          UInt64.zero,
          prices[middleIndex - 1]
        );

        let secondMiddleNumber = Provable.if(
          prices[middleIndex].equals(UInt64.MAXINT()),
          UInt64.zero,
          prices[middleIndex]
        );

        let calculatedMedian = firstMiddleNumber
          .add(secondMiddleNumber)
          .div(UInt64.from(2));

        // Check if either middle value is MAXINT
        let hasMaxInt = prices[middleIndex - 1]
          .equals(UInt64.MAXINT())
          .or(prices[middleIndex].equals(UInt64.MAXINT()));

        calculatedMedian = Provable.if(
          hasMaxInt,
          UInt64.zero,
          calculatedMedian
        );

        medianValues.push(calculatedMedian);
      } else {
        Provable.log('Odd count', i);
        let middleIndex = (i - 1) / 2;
        medianValues.push(
          Provable.if(
            prices[middleIndex].equals(UInt64.MAXINT()),
            UInt64.zero,
            prices[middleIndex]
          )
        );
      }
    }

    Provable.log('Median values', medianValues);
    Provable.log('Conditions', conditions);

    // Select the correct median value based on our effective count
    return Provable.switch(conditions, UInt64, medianValues);
  }

  @method.returns(Bool)
  public async canMint(_accountUpdate: AccountUpdate) {
    return this.assertInteractionFlag();
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
