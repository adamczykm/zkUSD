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
  fetchAccount,
} from 'o1js';
import { ZkUsdVault } from './zkusd-vault';

import {
  OracleWhitelist,
  PriceFeedAction,
  PriceState,
  ProtocolDataPacked,
  ProtocolData,
  VaultState,
} from './types';
import { ZkUsdMasterOracle } from './zkusd-master-oracle';

// Errors
export const ZkUsdEngineErrors = {
  UPDATES_BLOCKED:
    'Updates to the engine accounts can only be made by the engine',
  VAULT_EXISTS: 'Vault already exists',
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
  price: UInt64,
}) {}

export class MintZkUsdEvent extends Struct({
  vaultAddress: PublicKey,
  amountMinted: UInt64,
  vaultCollateralAmount: UInt64,
  vaultDebtAmount: UInt64,
  price: UInt64,
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
}) {}

export class FallbackPriceUpdateEvent extends Struct({
  newPrice: UInt64,
}) {}

export class PriceSubmissionEvent extends Struct({
  submitter: PublicKey,
  price: UInt64,
  oracleFee: UInt64,
}) {}

export class EmergencyStopEvent extends Struct({}) {}

export class EmergencyResumeEvent extends Struct({}) {}

export class AdminUpdatedEvent extends Struct({
  previousAdmin: PublicKey,
  newAdmin: PublicKey,
}) {}

export class VerificationKeyUpdatedEvent extends Struct({}) {}

export class OracleWhitelistUpdatedEvent extends Struct({
  previousHash: Field,
  newHash: Field,
}) {}

export class OracleFeeUpdated extends Struct({
  previousFee: UInt64,
  newFee: UInt64,
}) {}

export class OracleFundsDepositedEvent extends Struct({
  amount: UInt64,
}) {}

export interface ZkUsdEngineDeployProps extends Exclude<DeployArgs, undefined> {
  initialPrice: UInt64;
  admin: PublicKey;
  oracleFlatFee: UInt64;
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

  static MASTER_ORACLE_ADDRESS = PublicKey.fromBase58(
    'B62qmApLja1zB4GwBLB9Xm1c6Fjc1PxgfCNa9z12wQorHUqZbaiKnym'
  );

  // Reducer definition
  reducer = Reducer({ actionType: PriceFeedAction });

  readonly events = {
    PriceUpdate: PriceUpdateEvent,
    FallbackPriceUpdate: FallbackPriceUpdateEvent,
    OracleFundsDeposited: OracleFundsDepositedEvent,
    PriceSubmission: PriceSubmissionEvent,
    EmergencyStop: EmergencyStopEvent,
    EmergencyResume: EmergencyResumeEvent,
    AdminUpdated: AdminUpdatedEvent,
    VerificationKeyUpdated: VerificationKeyUpdatedEvent,
    OracleWhitelistUpdated: OracleWhitelistUpdatedEvent,
    OracleFeeUpdated: OracleFeeUpdated,
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
        emergencyStop: args.emergencyStop,
      }).pack()
    );

    this.vaultVerificationKeyHash.set(args.vaultVerificationKeyHash);
  }

  //Blocks the updating of state of the token accounts
  approveBase(forest: AccountUpdateForest): Promise<void> {
    throw Error(ZkUsdEngineErrors.UPDATES_BLOCKED);
  }

  @method async initialize() {
    //Ensure admin key
    await this.ensureAdminSignature();

    //Set the permissions to track the collateral deposits on the engine
    let au = AccountUpdate.createSigned(this.address, this.deriveTokenId());
    au.account.isNew.getAndRequireEquals().assertTrue();
    let permissions = Permissions.default();
    permissions.send = Permissions.none();
    permissions.setPermissions = Permissions.impossible();
    au.account.permissions.set(permissions);

    // //Set up the master oracle to track the oracle funds and manage the fallback price
    const masterOracle = AccountUpdate.createSigned(
      ZkUsdEngine.MASTER_ORACLE_ADDRESS,
      this.deriveTokenId()
    );
    masterOracle.body.useFullCommitment = Bool(true);
    masterOracle.account.isNew.getAndRequireEquals().assertTrue();

    //Get the verification key for the master oracle
    const masterOracleVerificationKey = new VerificationKey(
      ZkUsdMasterOracle._verificationKey!
    );

    masterOracle.body.update.verificationKey = {
      isSome: Bool(true),
      value: masterOracleVerificationKey,
    };

    masterOracle.body.update.appState[0].value = this.priceEvenBlock
      .getAndRequireEquals()
      .toFields()[0];
    masterOracle.body.update.appState[0].isSome = Bool(true);
    masterOracle.body.update.appState[1].value = this.priceOddBlock
      .getAndRequireEquals()
      .toFields()[0];
    masterOracle.body.update.appState[1].isSome = Bool(true);

    masterOracle.account.permissions.set(permissions);
    this.self.approve(masterOracle);
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

  @method.returns(UInt64)
  async getAvailableOracleFunds(): Promise<UInt64> {
    const account = AccountUpdate.create(
      ZkUsdEngine.MASTER_ORACLE_ADDRESS,
      this.deriveTokenId()
    ).account;
    const balance = account.balance.getAndRequireEquals();

    return balance;
  }

  /**
   * @notice  Creates a new vault
   * @dev     The vault is deployed manually on the token account of the engine contract, this way
   *          we can ensure that updates to the vaults only happen through interaction with
   *          the engine contract. This pattern also allows the engine to be the admin account for the
   *          zkUSD token contract, which reduces the number of account updates when users take actions
   *          against their vaults
   * @param   vaultAddress The address of the vault to create
   */
  @method async createVault(vaultAddress: PublicKey) {
    //Preconditions
    const vaultVerificationKeyHash =
      this.vaultVerificationKeyHash.getAndRequireEquals();

    //The sender is the owner of the vault
    const owner = this.sender.getAndRequireSignatureV2();

    //Get the zkUSD token contract
    const zkUSD = new FungibleToken(ZkUsdEngine.ZKUSD_TOKEN_ADDRESS);

    //We create an account for the owner on the zkUSD token contract (if they don't already have one)
    await zkUSD.getBalanceOf(owner);

    //Create the new vault on the token account of the engine
    const vault = AccountUpdate.createSigned(
      vaultAddress,
      this.deriveTokenId()
    );

    //Prevents memo and fee changes
    vault.body.useFullCommitment = Bool(true);

    //Ensures that the vault does not already exist
    vault.account.isNew
      .getAndRequireEquals()
      .assertTrue(ZkUsdEngineErrors.VAULT_EXISTS);

    //Get the verification key for the vault
    const vaultVerificationKey = new VerificationKey(
      ZkUsdVault._verificationKey!
    );

    //Ensure that the verification key is the correct one for the vault
    vaultVerificationKey.hash.assertEquals(vaultVerificationKeyHash);

    //Set the verification key for the vault
    vault.body.update.verificationKey = {
      isSome: Bool(true),
      value: vaultVerificationKey,
    };

    //Set the permissions for the vault
    vault.body.update.permissions = {
      isSome: Bool(true),
      value: {
        ...Permissions.default(),
        send: Permissions.proof(),
        // IMPORTANT: We need to think about upgradability here
        setVerificationKey:
          Permissions.VerificationKey.impossibleDuringCurrentVersion(),
        setPermissions: Permissions.impossible(),
        access: Permissions.proof(),
        setZkappUri: Permissions.none(),
        setTokenSymbol: Permissions.none(),
      },
    };

    //Set the initial state for the vault
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

    //Set the app state for the vault
    vault.body.update.appState = appStateUpdates;

    //Emit the NewVault event
    this.emitEvent(
      'NewVault',
      new NewVaultEvent({
        vaultAddress: vaultAddress,
      })
    );
  }

  /**
   * @notice  Deposits collateral into a vault
   * @notice  The actual collateral is held by the engine contract, we are using the vault to track
   *          the state of each debt position
   * @param   vaultAddress The address of the vault to deposit collateral to
   * @param   amount The amount of collateral to deposit
   */
  @method async depositCollateral(vaultAddress: PublicKey, amount: UInt64) {
    //Get the vault
    const vault = new ZkUsdVault(vaultAddress, this.deriveTokenId());

    //Create the account update for the collateral deposit
    const collateralDeposit = AccountUpdate.createSigned(
      this.sender.getUnconstrainedV2()
    );

    //Send the collateral to the engine contract
    collateralDeposit.send({
      to: this.address,
      amount: amount,
    });

    //Get the owner of the collateral deposit, as we already have a signature from them
    const owner = collateralDeposit.publicKey;

    //Deposit the collateral into the vault
    const { collateralAmount, debtAmount } = await vault.depositCollateral(
      amount,
      owner
    );

    //Update the total deposited collateral
    const totalDepositedCollateral = AccountUpdate.create(
      this.address,
      this.deriveTokenId()
    );
    totalDepositedCollateral.balanceChange = Int64.fromUnsigned(amount);

    //Emit the DepositCollateral event
    this.emitEvent(
      'DepositCollateral',
      new DepositCollateralEvent({
        vaultAddress: vaultAddress,
        amountDeposited: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
      })
    );
  }

  /**
   * @notice  Redeems collateral from a vault
   * @param   vaultAddress The address of the vault to redeem collateral from
   * @param   amount The amount of collateral to redeem
   */
  @method async redeemCollateral(vaultAddress: PublicKey, amount: UInt64) {
    //Get the vault
    const vault = new ZkUsdVault(vaultAddress, this.deriveTokenId());

    //Get the price
    const price = await this.getPrice();

    //Get the owner of the collateral
    const owner = this.sender.getAndRequireSignatureV2();

    //Redeem the collateral
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

    //Update the total deposited collateral
    const totalDepositedCollateral = AccountUpdate.create(
      this.address,
      this.deriveTokenId()
    );
    totalDepositedCollateral.balanceChange = Int64.fromUnsigned(amount).negV2();

    //Emit the RedeemCollateral event
    this.emitEvent(
      'RedeemCollateral',
      new RedeemCollateralEvent({
        vaultAddress: vaultAddress,
        amountRedeemed: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
        price: price,
      })
    );
  }

  /**
   * @notice  Mints zkUSD for a vault
   * @param   vaultAddress The address of the vault to mint zkUSD for
   * @param   amount The amount of zkUSD to mint
   */
  @method async mintZkUsd(vaultAddress: PublicKey, amount: UInt64) {
    //Get the vault
    const vault = new ZkUsdVault(vaultAddress, this.deriveTokenId());

    //Get the zkUSD token contract
    const zkUSD = new FungibleToken(ZkUsdEngine.ZKUSD_TOKEN_ADDRESS);

    //Get the price
    const price = await this.getPrice();

    //Get the owner of the zkUSD
    const owner = this.sender.getAndRequireSignatureV2();

    //Manage the debt in the vault
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
        vaultAddress: vaultAddress,
        amountMinted: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
        price: price,
      })
    );
  }

  /**
   * @notice  Burns zkUSD from a vault
   * @param   vaultAddress The address of the vault to burn zkUSD from
   * @param   amount The amount of zkUSD to burn
   */
  @method async burnZkUsd(vaultAddress: PublicKey, amount: UInt64) {
    //Get the vault
    const vault = new ZkUsdVault(vaultAddress, this.deriveTokenId());

    //Get the owner of the zkUSD
    const owner = this.sender.getAndRequireSignatureV2();

    //Get the zkUSD token contract
    const zkUSD = new FungibleToken(ZkUsdEngine.ZKUSD_TOKEN_ADDRESS);

    //Manage the debt in the vault
    const { collateralAmount, debtAmount } = await vault.burnZkUsd(
      amount,
      owner
    );

    //Burn the zkUSD from the sender
    await zkUSD.burn(owner, amount);

    //Emit the BurnZkUsd event
    this.emitEvent(
      'BurnZkUsd',
      new BurnZkUsdEvent({
        vaultAddress: vaultAddress,
        amountBurned: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
      })
    );
  }

  /**
   * @notice  Liquidates a vault as long as the health factor is below 100
   * @param   vaultAddress The address of the vault to liquidate
   */
  @method async liquidate(vaultAddress: PublicKey) {
    //Get the vault
    const vault = new ZkUsdVault(vaultAddress, this.deriveTokenId());

    //Get the zkUSD token contract
    const zkUSD = new FungibleToken(ZkUsdEngine.ZKUSD_TOKEN_ADDRESS);

    //Get the liquidator
    const liquidator = this.sender.getAndRequireSignatureV2();

    //Get the price
    const price = await this.getPrice();

    const { collateralAmount, debtAmount } = await vault.liquidate(price);

    //Burn the debt from the liquidator
    await zkUSD.burn(liquidator, debtAmount);

    //Send the collateral to the liquidator
    this.send({
      to: liquidator,
      amount: collateralAmount,
    });

    //Update the total deposited collateral
    const totalDepositedCollateral = AccountUpdate.create(
      this.address,
      this.deriveTokenId()
    );
    totalDepositedCollateral.balanceChange =
      Int64.fromUnsigned(collateralAmount).negV2();

    //Emit the Liquidate event
    this.emitEvent(
      'Liquidate',
      new LiquidateEvent({
        vaultAddress: vaultAddress,
        liquidator: this.sender.getUnconstrainedV2(),
        vaultCollateralLiquidated: collateralAmount,
        vaultDebtRepaid: debtAmount,
        price: price,
      })
    );
  }

  /**
   * @notice  Returns the health factor of a vault
   * @param   vaultAddress The address of the vault
   * @returns The health factor of the vault
   */
  @method.returns(UInt64)
  public async getVaultHealthFactor(vaultAddress: PublicKey): Promise<UInt64> {
    //Get the vault
    const vault = new ZkUsdVault(vaultAddress, this.deriveTokenId());

    //Get the price
    const price = await this.getPrice();

    //Return the health factor
    return vault.getHealthFactor(price);
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
    this.emitEvent('EmergencyStop', new EmergencyStopEvent({}));
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
    this.emitEvent('EmergencyResume', new EmergencyResumeEvent({}));
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
    });
  }

  /**
   * @notice  Updates the verification key for the protocol vault
   * @param   vk The new verification key
   */
  @method
  async updateVerificationKey(vk: VerificationKey) {
    await this.ensureAdminSignature();
    this.account.verificationKey.set(vk);

    this.emitEvent('VerificationKeyUpdated', {});
  }

  /**
   * @notice  Updates the admin public key
   * @param   newAdmin The new admin public key
   */
  @method async updateAdmin(newAdmin: PublicKey) {
    //Ensure admin signature
    await this.ensureAdminSignature();

    const protocolData = ProtocolData.unpack(
      this.protocolDataPacked.getAndRequireEquals()
    );

    const previousAdmin = protocolData.admin;

    protocolData.admin = newAdmin;
    this.protocolDataPacked.set(protocolData.pack());

    this.emitEvent('AdminUpdated', {
      previousAdmin,
      newAdmin,
    });
  }

  @method async depositOracleFunds(amount: UInt64) {
    //We track the funds in the token account of the engine address
    const oracleFundsTrackerUpdate = AccountUpdate.create(
      ZkUsdEngine.MASTER_ORACLE_ADDRESS,
      this.deriveTokenId()
    );

    oracleFundsTrackerUpdate.balanceChange = Int64.fromUnsigned(amount);

    this.self.approve(oracleFundsTrackerUpdate);

    //Create the account update for the deposit
    const depositUpdate = AccountUpdate.createSigned(
      this.sender.getUnconstrainedV2()
    );

    depositUpdate.send({
      to: this.address,
      amount: amount,
    });

    this.emitEvent('OracleFundsDeposited', {
      amount: amount,
    });
  }

  /**
   * @notice  Updates the fallback price
   * @param   price The new fallback price
   */
  @method async updateFallbackPrice(price: UInt64) {
    //Ensure admin signature
    await this.ensureAdminSignature();

    const masterOracle = new ZkUsdMasterOracle(
      ZkUsdEngine.MASTER_ORACLE_ADDRESS,
      this.deriveTokenId()
    );

    await masterOracle.updateFallbackPrice(price);

    this.emitEvent('FallbackPriceUpdate', {
      newPrice: price,
    });
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

    const oracleFundsTracker = AccountUpdate.create(
      ZkUsdEngine.MASTER_ORACLE_ADDRESS,
      this.deriveTokenId()
    );

    oracleFundsTracker.balanceChange = Int64.fromUnsigned(oracleFee).negV2();

    this.self.approve(oracleFundsTracker);

    //TRANSACTION FAILS IF WE DONT HAVE AVAILABLE ORACLE FUNDS

    // Pay the oracle fee for the price submission
    const receiverUpdate = AccountUpdate.create(submitter);

    receiverUpdate.balance.addInPlace(oracleFee);
    this.balance.subInPlace(oracleFee);

    //Dispatch the action
    this.reducer.dispatch(priceFeedAction);

    // Add price submission event
    this.emitEvent(
      'PriceSubmission',
      new PriceSubmissionEvent({
        submitter: submitter,
        price: price,
        oracleFee: oracleFee,
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
    Provable.log('Action state', actionState);
    const currentPrices = this.getAndRequireCurrentPrices();

    //Get the master oracle
    const masterOracle = new ZkUsdMasterOracle(
      ZkUsdEngine.MASTER_ORACLE_ADDRESS,
      this.deriveTokenId()
    );

    //Get the fallback price
    const fallbackPrice = await masterOracle.getFallbackPrice();

    //Get the pending actions
    let pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    //Create an array of fallback prices
    let priceArray = Array(ZkUsdEngine.MAX_PARTICIPANTS).fill(fallbackPrice);

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
    for (let i = 0; i < ZkUsdEngine.MAX_PARTICIPANTS - 1; i++) {
      for (let j = 0; j < ZkUsdEngine.MAX_PARTICIPANTS - i - 1; j++) {
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
    for (let i = 3; i <= ZkUsdEngine.MAX_PARTICIPANTS; i++) {
      conditions.push(effectiveCount.equals(UInt64.from(i)));
    }

    // Calculate potential median values for each possible count
    // For even counts: average of two middle values
    // For odd counts: middle value
    const medianValues = [];
    for (let i = 3; i <= ZkUsdEngine.MAX_PARTICIPANTS; i++) {
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

  @method.returns(Bool)
  public async canMint(_accountUpdate: AccountUpdate) {
    return this.assertInteractionFlag();
  }

  @method.returns(Bool)
  public async canChangeAdmin(_admin: PublicKey) {
    return Bool(false);
  }

  @method.returns(Bool)
  public async canPause(): Promise<Bool> {
    return Bool(false);
  }

  @method.returns(Bool)
  public async canResume(): Promise<Bool> {
    return Bool(false);
  }
}
