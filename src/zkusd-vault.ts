import { FungibleToken } from 'mina-fungible-token';
import {
  DeployArgs,
  PublicKey,
  SmartContract,
  state,
  State,
  UInt64,
  Permissions,
  Field,
  Poseidon,
  method,
  AccountUpdate,
  Bool,
  Provable,
  Signature,
  Struct,
  UInt32,
} from 'o1js';
import { ZkUsdProtocolVault } from './zkusd-protocol-vault';

export const ZkUsdVaultErrors = {
  AMOUNT_ZERO: 'Transaction amount must be greater than zero',
  BALANCE_ZERO: 'Vault balance must be greater than zero',
  HEALTH_FACTOR_TOO_LOW:
    'Vault would become undercollateralized (health factor < 100). Add more collateral or reduce debt first',
  HEALTH_FACTOR_TOO_HIGH:
    'Cannot liquidate: Vault is sufficiently collateralized (health factor > 100)',
  AMOUNT_EXCEEDS_DEBT:
    'Cannot repay more than the current outstanding debt amount',
  INVALID_SECRET: 'Access denied: Invalid ownership secret provided',
  INVALID_ORACLE_SIG: 'Invalid price feed signature from oracle',
  ORACLE_EXPIRED:
    'Price feed data has expired - please use current oracle data',
  INSUFFICIENT_BALANCE: 'Requested amount exceeds the vaults zkUSD balance',
  INSUFFICIENT_COLLATERAL:
    'Requested amount exceeds the deposited collateral in the vault ',
};

export class OraclePayload extends Struct({
  price: UInt64,
  blockchainLength: UInt32,
  signature: Signature,
}) {}

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

export class WithdrawZkUsdEvent extends Struct({
  vaultAddress: PublicKey,
  amountWithdrawn: UInt64,
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

export class ZkUsdVault extends SmartContract {
  @state(UInt64) collateralAmount = State<UInt64>();
  @state(UInt64) debtAmount = State<UInt64>();
  @state(Field) ownershipHash = State<Field>();
  @state(PublicKey) oraclePublicKey = State<PublicKey>();
  @state(Bool) mintFlag = State<Bool>(Bool(false));

  static COLLATERAL_RATIO = Field.from(150);
  static COLLATERAL_RATIO_PRECISION = Field.from(100);
  static PROTOCOL_FEE_PRECISION = UInt64.from(100);
  static UNIT_PRECISION = Field.from(1e9);
  static MIN_HEALTH_FACTOR = UInt64.from(100);
  static ORACLE_PUBLIC_KEY = PublicKey.fromBase58(
    'B62qkQA5kdAsyvizsSdZ9ztzNidsqNXj9YrESPkMwUPt1J8RYDGkjAY'
  );
  static ZKUSD_TOKEN_ADDRESS = PublicKey.fromBase58(
    'B62qry2wngUSGZqQn9erfnA9rZPn4cMbDG1XPasGdK1EtKQAxmgjDtt'
  );
  static PROTOCOL_VAULT_ADDRESS = PublicKey.fromBase58(
    'B62qkJvkDUiw1c7kKn3PBa9YjNFiBgSA6nbXUJiVuSU128mKH4DiSih'
  );

  readonly events = {
    NewVault: NewVaultEvent,
    DepositCollateral: DepositCollateralEvent,
    RedeemCollateral: RedeemCollateralEvent,
    MintZkUsd: MintZkUsdEvent,
    WithdrawZkUsd: WithdrawZkUsdEvent,
    BurnZkUsd: BurnZkUsdEvent,
    Liquidate: LiquidateEvent,
  };

  async deploy(args: DeployArgs & { secret: Field }) {
    await super.deploy(args);
    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      send: Permissions.proof(),
    });

    this.collateralAmount.set(UInt64.from(0));
    this.debtAmount.set(UInt64.from(0));

    const ownershipHash = Poseidon.hash(args.secret.toFields());
    this.ownershipHash.set(ownershipHash);

    this.emitEvent(
      'NewVault',
      new NewVaultEvent({
        vaultAddress: this.address,
      })
    );
  }

  @method async depositCollateral(amount: UInt64, secret: Field) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();

    //assert amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    const collateralDeposit = AccountUpdate.createSigned(
      this.sender.getAndRequireSignatureV2()
    );

    collateralDeposit.send({
      to: this.address,
      amount: amount,
    });

    this.collateralAmount.set(collateralAmount.add(amount));

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

  @method async redeemCollateral(
    amount: UInt64,
    secret: Field,
    oraclePayload: OraclePayload
  ) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();
    let balance = this.account.balance.getAndRequireEquals();

    //Get the protocol vault
    const protocolVault = new ZkUsdProtocolVault(
      ZkUsdVault.PROTOCOL_VAULT_ADDRESS
    );

    //assert balance is greater than 0
    balance.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.BALANCE_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    //verify the oracle price
    this.verifyOraclePayload(oraclePayload);

    //Assert the amount is less than or equal to the collateral amount
    amount.assertLessThanOrEqual(
      collateralAmount,
      ZkUsdVaultErrors.INSUFFICIENT_COLLATERAL
    );

    //Calculate the USD value of the collateral after redemption
    const remainingCollateral = collateralAmount.sub(amount);

    //Calculate the health factor
    const healthFactor = this.calculateHealthFactor(
      remainingCollateral,
      debtAmount,
      oraclePayload.price
    );

    //Assert the health factor is greater than the minimum health factor
    healthFactor.assertGreaterThanOrEqual(
      ZkUsdVault.MIN_HEALTH_FACTOR,
      ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW
    );

    //Check if there are any staking rewards: Whatever the balance is above the collateral amount is the staking rewards
    const stakingRewards = balance.sub(collateralAmount);

    //Get the protocol fee from the protocol vault
    const currentProtocolFee = protocolVault.protocolFee.getAndRequireEquals();

    //Calculate the protocol fee from the staking rewards
    const protocolFee = stakingRewards
      .mul(currentProtocolFee)
      .div(ZkUsdVault.PROTOCOL_FEE_PRECISION);

    //If there are staking rewards, send the protocol fee to the protocol vault
    let protocolFeeUpdate = AccountUpdate.createIf(
      protocolFee.greaterThan(UInt64.from(0)),
      ZkUsdVault.PROTOCOL_VAULT_ADDRESS
    );

    protocolFeeUpdate.balance.addInPlace(protocolFee);
    this.balance.subInPlace(protocolFee);

    //Send the remaining staking rewards to the owner
    const stakingRewardsDividend = stakingRewards.sub(protocolFee);

    //Send the collateral back to the sender including the staking rewards
    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: amount.add(stakingRewardsDividend),
    });

    //Update the collateral amount
    this.collateralAmount.set(remainingCollateral);

    //Emit the WithdrawZkUsd event
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

  @method async mintZkUsd(
    amount: UInt64,
    secret: Field,
    oraclePayload: OraclePayload
  ) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();

    //Assert the sender has the secret
    const zkUSD = new FungibleToken(ZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    //Assert the amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    //Verify the oracle price
    this.verifyOraclePayload(oraclePayload);

    const healthFactor = this.calculateHealthFactor(
      collateralAmount,
      debtAmount.add(amount), // Add the amount they want to mint to the debt
      oraclePayload.price
    );

    //Assert the health factor is greater than the minimum health factor
    healthFactor.assertGreaterThanOrEqual(
      ZkUsdVault.MIN_HEALTH_FACTOR,
      ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW
    );

    //Mint the zkUSD
    await zkUSD.mint(this.address, amount);

    //Update the debt amount
    this.debtAmount.set(debtAmount.add(amount));

    //Set the interaction flag
    this.mintFlag.set(Bool(true));

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

  @method async withdrawZkUsd(amount: UInt64, secret: Field) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();

    //Get the zkUSD token
    const zkUsd = new FungibleToken(ZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    //Assert the amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    //Assert the withdrawal amount is less that the balance of zkUSD
    amount.assertLessThanOrEqual(
      await zkUsd.getBalanceOf(this.address),
      ZkUsdVaultErrors.INSUFFICIENT_BALANCE
    );

    //Send the zkUSD to the sender
    await zkUsd.transfer(
      this.address,
      this.sender.getAndRequireSignatureV2(),
      amount
    );

    //Emit the WithdrawZkUsd event
    this.emitEvent(
      'WithdrawZkUsd',
      new WithdrawZkUsdEvent({
        vaultAddress: this.address,
        amountWithdrawn: amount,
        vaultCollateralAmount: collateralAmount,
        vaultDebtAmount: debtAmount,
      })
    );
  }

  @method async burnZkUsd(amount: UInt64, secret: Field) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();
    let ownershipHash = this.ownershipHash.getAndRequireEquals();
    //Get the zkUSD token
    const zkUsd = new FungibleToken(ZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    //Assert the amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), ZkUsdVaultErrors.AMOUNT_ZERO);

    //Assert the ownership secret is correct
    ownershipHash.assertEquals(
      Poseidon.hash(secret.toFields()),
      ZkUsdVaultErrors.INVALID_SECRET
    );

    //Assert the amount is less than the debt amount
    debtAmount.assertGreaterThanOrEqual(
      amount,
      ZkUsdVaultErrors.AMOUNT_EXCEEDS_DEBT
    );

    //Update the debt amount
    this.debtAmount.set(debtAmount.sub(amount));

    //Burn the zkUsd
    await zkUsd.burn(this.sender.getAndRequireSignatureV2(), amount);

    //Emit the BurnZkUsd event
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

  @method async liquidate(oraclePayload: OraclePayload) {
    //Preconditions
    let collateralAmount = this.collateralAmount.getAndRequireEquals();
    let debtAmount = this.debtAmount.getAndRequireEquals();

    //Get the zkUSD token
    const zkUSD = new FungibleToken(ZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    //Verify the oracle price
    this.verifyOraclePayload(oraclePayload);

    //Calculate the health factor
    const healthFactor = this.calculateHealthFactor(
      collateralAmount,
      debtAmount,
      oraclePayload.price
    );

    //Assert the health factor is less than the minimum health factor
    healthFactor.assertLessThanOrEqual(
      ZkUsdVault.MIN_HEALTH_FACTOR,
      ZkUsdVaultErrors.HEALTH_FACTOR_TOO_HIGH
    );

    //Send the collateral to the liquidator
    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: collateralAmount,
    });

    //Update the collateral amount
    this.collateralAmount.set(UInt64.from(0));

    //Burn the zkUSD
    await zkUSD.burn(this.sender.getUnconstrainedV2(), debtAmount);

    //Update the debt amount
    this.debtAmount.set(UInt64.from(0));

    //Emit the Liquidate event
    this.emitEvent(
      'Liquidate',
      new LiquidateEvent({
        vaultAddress: this.address,
        liquidator: this.sender.getUnconstrainedV2(),
        vaultCollateralLiquidated: collateralAmount,
        vaultDebtRepaid: debtAmount,
        price: oraclePayload.price,
      })
    );
  }

  @method.returns(UInt64)
  async getHealthFactor(oraclePayload: OraclePayload) {
    //Verify the oracle price
    this.verifyOraclePayload(oraclePayload);

    return this.calculateHealthFactor(
      this.collateralAmount.getAndRequireEquals(),
      this.debtAmount.getAndRequireEquals(),
      oraclePayload.price
    );
  }

  // This flag is set so the zkUSD Admin contract can check its permissions
  @method.returns(Bool)
  public async assertInteractionFlag() {
    this.mintFlag.requireEquals(Bool(true));
    this.mintFlag.set(Bool(false));
    return Bool(true);
  }

  private verifyOraclePayload(oraclePayload: OraclePayload) {
    const validSignature = oraclePayload.signature.verify(
      ZkUsdVault.ORACLE_PUBLIC_KEY,
      [
        ...oraclePayload.price.toFields(),
        ...oraclePayload.blockchainLength.toFields(),
      ]
    );

    //Assert the signature is valid
    validSignature.assertTrue(ZkUsdVaultErrors.INVALID_ORACLE_SIG);

    //Assert the blockchain length is the same
    let length = this.network.blockchainLength.getAndRequireEquals();

    oraclePayload.blockchainLength.assertEquals(length);
  }

  private calculateUsdValue(amount: UInt64, price: UInt64): Field {
    const numCollateralValue = amount.toFields()[0].mul(price.toFields()[0]);

    return this.fieldIntegerDiv(numCollateralValue, ZkUsdVault.UNIT_PRECISION);
  }

  private calculateMaxAllowedDebt(collateralValue: Field): Field {
    const numCollateralValue = collateralValue.mul(
      ZkUsdVault.COLLATERAL_RATIO_PRECISION
    );

    return this.fieldIntegerDiv(
      numCollateralValue,
      ZkUsdVault.COLLATERAL_RATIO
    );
  }

  public calculateHealthFactor(
    collateralAmount: UInt64,
    debtAmount: UInt64,
    price: UInt64
  ): UInt64 {
    const collateralValue = this.calculateUsdValue(collateralAmount, price);
    const maxAllowedDebt = this.calculateMaxAllowedDebt(collateralValue);

    // Check if debtAmount is zero to avoid division by zero
    const numerator = maxAllowedDebt.mul(ZkUsdVault.COLLATERAL_RATIO_PRECISION);
    const denominator = debtAmount.toFields()[0];

    return UInt64.fromFields([this.safeDiv(numerator, denominator)]);
  }

  private fieldIntegerDiv(x: Field, y: Field): Field {
    // Ensure y is not zero to avoid division by zero
    y.assertNotEquals(Field(0), 'Division by zero');

    // Witness the quotient q = floor(x / y)
    const q = Provable.witness(Field, () => {
      const xn = x.toBigInt();
      const yn = y.toBigInt();
      const qn = xn / yn; // Integer division
      return Field(qn);
    });

    // Compute the remainder r = x - q * y
    const r = x.sub(q.mul(y));

    // Add constraints to ensure x = q * y + r, and 0 ≤ r < y
    r.assertGreaterThanOrEqual(Field(0));
    r.assertLessThan(y);

    // Enforce the relation x = q * y + r
    x.assertEquals(q.mul(y).add(r));

    // Return the quotient q
    return q;
  }

  private safeDiv(numerator: Field, denominator: Field): Field {
    const isDenominatorZero = denominator.equals(Field(0));
    const safeDenominator = Provable.if(
      isDenominatorZero,
      Field(1),
      denominator
    );

    const divisionResult = this.fieldIntegerDiv(numerator, safeDenominator);

    return Provable.if(
      isDenominatorZero,
      UInt64.MAXINT().toFields()[0],
      divisionResult
    );
  }
}
