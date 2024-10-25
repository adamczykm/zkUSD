import {
  Struct,
  Field,
  UInt64,
  Bool,
  Poseidon,
  SmartContract,
  state,
  State,
  method,
  AccountUpdate,
  PublicKey,
  DeployArgs,
  Signature,
  Provable,
  Experimental,
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';

const { OffchainState } = Experimental;

export class CDPPosition extends Struct({
  id: Field,
  collateralAmount: UInt64,
  debtAmount: UInt64,
  ownershipHash: Field,
}) {}

export const offchainState = OffchainState({
  cdps: OffchainState.Map(Field, CDPPosition),
  totalCollateral: OffchainState.Field(UInt64),
});

class StateProof extends offchainState.Proof {}

export class ZKUSDOrchestrator extends SmartContract {
  @state(OffchainState.Commitments) offchainStateCommitments =
    offchainState.emptyCommitments();
  @state(PublicKey) oraclePublicKey = State<PublicKey>();
  @state(PublicKey) zkUSDTokenAddress = State<PublicKey>();
  @state(Bool) interactionFlag = State<Bool>(Bool(false));

  offchainState = offchainState.init(this);

  static COLLATERAL_RATIO = Field.from(150);
  static COLLATERAL_RATIO_PRECISION = Field.from(100);
  static PRECISION = Field.from(1e9);
  static MIN_HEALTH_FACTOR = UInt64.from(100);

  async deploy(
    args: DeployArgs & {
      oraclePublicKey: PublicKey;
      zkUSDTokenAddress: PublicKey;
    }
  ) {
    await super.deploy(args);
    this.oraclePublicKey.set(args.oraclePublicKey);
    this.zkUSDTokenAddress.set(args.zkUSDTokenAddress);
  }

  @method async initialize() {
    this.offchainState.fields.totalCollateral.update({
      from: undefined,
      to: UInt64.from(0),
    });
  }

  @method async createCDP(cdpId: Field, secret: Field) {
    const cdpOwnershipHash = Poseidon.hash([cdpId, secret]);

    const cdpPosition = new CDPPosition({
      id: cdpId,
      collateralAmount: UInt64.from(0),
      debtAmount: UInt64.from(0),
      ownershipHash: cdpOwnershipHash,
    });

    this.offchainState.fields.cdps.update(cdpId, {
      from: undefined,
      to: cdpPosition,
    });
  }

  @method async depositCollateral(cdpId: Field, secret: Field, amount: UInt64) {
    const cdpOwnershipHash = Poseidon.hash([cdpId, secret]);

    //assert amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), 'Amount must be greater than 0');

    const cdpOption = await this.offchainState.fields.cdps.get(cdpId);
    const cdp = cdpOption.assertSome("CDP doesn't exist");

    //assert the ownership hash is correct
    cdp.ownershipHash.assertEquals(cdpOwnershipHash);

    const collateralDeposit = AccountUpdate.createSigned(
      this.sender.getAndRequireSignatureV2()
    );

    collateralDeposit.send({
      to: this.address,
      amount: amount,
    });

    this.offchainState.fields.cdps.update(cdpId, {
      from: cdp,
      to: new CDPPosition({
        ...cdp,
        collateralAmount: cdp.collateralAmount.add(amount),
      }),
    });

    //update the total collateral
    const totalCollateralOption =
      await this.offchainState.fields.totalCollateral.get();
    const totalCollateral = totalCollateralOption.orElse(0n);

    this.offchainState.fields.totalCollateral.update({
      from: totalCollateral,
      to: totalCollateral.add(amount),
    });
  }

  @method async redeemCollateral(
    cdpId: Field,
    secret: Field,
    amount: UInt64,
    price: UInt64,
    signature: Signature
  ) {
    const cdpOwnershipHash = Poseidon.hash([cdpId, secret]);

    amount.assertGreaterThan(UInt64.from(0), 'Amount must be greater than 0');

    const cdpOption = await this.offchainState.fields.cdps.get(cdpId);
    const cdp = cdpOption.assertSome('CDP exists');

    //assert the ownership hash is correct
    cdp.ownershipHash.assertEquals(cdpOwnershipHash);

    //verify the oracle price
    this.verifyOraclePrice(price, signature);

    //check if there is enough collateral to redeem
    cdp.collateralAmount.assertGreaterThanOrEqual(amount);

    //calculate the new collateral amount
    const newCollateralAmount = cdp.collateralAmount.sub(amount);

    //calculate the health factor
    const healthFactor = this.calculateHealthFactor(
      newCollateralAmount,
      cdp.debtAmount,
      price
    );

    //assert the health factor is greater than the minimum required
    healthFactor.assertGreaterThanOrEqual(ZKUSDOrchestrator.MIN_HEALTH_FACTOR);

    //update the collateral amount
    this.offchainState.fields.cdps.update(cdpId, {
      from: cdp,
      to: new CDPPosition({ ...cdp, collateralAmount: newCollateralAmount }),
    });

    //send the collateral back to the user
    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: amount,
    });

    //update the total collateral
    const totalCollateralOption =
      await this.offchainState.fields.totalCollateral.get();
    const totalCollateral = totalCollateralOption.orElse(0n);

    this.offchainState.fields.totalCollateral.update({
      from: totalCollateral,
      to: totalCollateral.sub(amount),
    });
  }

  @method async mintZKUSD(
    cdpId: Field,
    secret: Field,
    recipient: PublicKey,
    amount: UInt64,
    price: UInt64,
    signature: Signature
  ) {
    const zkUSDToken = new FungibleToken(
      this.zkUSDTokenAddress.getAndRequireEquals()
    );
    const cdpOwnershipHash = Poseidon.hash([cdpId, secret]);

    //assert the amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), 'Amount must be greater than 0');

    const cdpOption = await this.offchainState.fields.cdps.get(cdpId);
    const cdp = cdpOption.assertSome('CDP exists');

    //assert the ownership hash is correct
    cdp.ownershipHash.assertEquals(cdpOwnershipHash);

    //verify the oracle price
    this.verifyOraclePrice(price, signature);

    const healthFactor = this.calculateHealthFactor(
      cdp.collateralAmount,
      cdp.debtAmount.add(amount),
      price
    );

    //assert the health factor is greater than the minimum required
    healthFactor.assertGreaterThanOrEqual(ZKUSDOrchestrator.MIN_HEALTH_FACTOR);

    //update the cdp debt amount
    const newDebtAmount = cdp.debtAmount.add(amount);
    this.offchainState.fields.cdps.update(cdpId, {
      from: cdp,
      to: new CDPPosition({ ...cdp, debtAmount: newDebtAmount }),
    });

    //mint the zkUSD
    await zkUSDToken.mint(recipient, amount);
    this.interactionFlag.set(Bool(true));
  }

  @method async burnZKUSD(cdpId: Field, secret: Field, amount: UInt64) {
    const zkUSDToken = new FungibleToken(
      this.zkUSDTokenAddress.getAndRequireEquals()
    );
    const cdpOwnershipHash = Poseidon.hash([cdpId, secret]);

    const cdpOption = await this.offchainState.fields.cdps.get(cdpId);
    const cdp = cdpOption.assertSome('CDP exists');

    //assert the ownership hash is correct
    cdp.ownershipHash.assertEquals(cdpOwnershipHash);

    //assert the amount is greater than 0
    amount.assertGreaterThan(UInt64.from(0), 'Amount must be greater than 0');

    //assert the amount is less than the cdp debt amount
    cdp.debtAmount.assertGreaterThanOrEqual(amount);

    //update the cdp debt amount
    const newDebtAmount = cdp.debtAmount.sub(amount);
    this.offchainState.fields.cdps.update(cdpId, {
      from: cdp,
      to: new CDPPosition({ ...cdp, debtAmount: newDebtAmount }),
    });

    //burn the zkUSD
    await zkUSDToken.burn(this.sender.getAndRequireSignatureV2(), amount);
    this.interactionFlag.set(Bool(true));
  }

  @method async liquidateCDP(
    cdpId: Field,
    price: UInt64,
    signature: Signature
  ) {
    const zkUSDToken = new FungibleToken(
      this.zkUSDTokenAddress.getAndRequireEquals()
    );

    const cdpOption = await this.offchainState.fields.cdps.get(cdpId);
    const cdp = cdpOption.assertSome('CDP exists');

    //verify the oracle price
    this.verifyOraclePrice(price, signature);

    //Check the health factor is below the minimum required
    const healthFactor = this.calculateHealthFactor(
      cdp.collateralAmount,
      cdp.debtAmount,
      price
    );
    healthFactor.assertLessThanOrEqual(ZKUSDOrchestrator.MIN_HEALTH_FACTOR);

    //send the collateral to the liquidator
    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: cdp.collateralAmount,
    });

    //burn the zkUSD from the liquidator's balance
    await zkUSDToken.burn(
      this.sender.getAndRequireSignatureV2(),
      cdp.debtAmount
    );
    this.interactionFlag.set(Bool(true));

    //update the cdp to 0
    this.offchainState.fields.cdps.update(cdpId, {
      from: cdp,
      to: new CDPPosition({
        ...cdp,
        collateralAmount: UInt64.from(0),
        debtAmount: UInt64.from(0),
      }),
    });

    //update the total collateral
    const totalCollateralOption =
      await this.offchainState.fields.totalCollateral.get();
    const totalCollateral = totalCollateralOption.orElse(0n);

    this.offchainState.fields.totalCollateral.update({
      from: totalCollateral,
      to: totalCollateral.sub(cdp.collateralAmount),
    });
  }

  // This flag is set so the zkUSD Admin contract can check its permissions
  @method.returns(Bool)
  public async assertInteractionFlag() {
    this.interactionFlag.requireEquals(Bool(true));
    this.interactionFlag.set(Bool(false));
    return Bool(true);
  }

  private verifyOraclePrice(price: UInt64, signature: Signature) {
    const oraclePublicKey = this.oraclePublicKey.get();
    this.oraclePublicKey.requireEquals(oraclePublicKey);

    const validSignature = signature.verify(oraclePublicKey, [
      price.toFields()[0],
    ]);
    validSignature.assertTrue();
  }

  private calculateUsdValue(amount: UInt64, price: UInt64): Field {
    const numCollateralValue = amount.toFields()[0].mul(price.toFields()[0]);

    return this.fieldIntegerDiv(
      numCollateralValue,
      ZKUSDOrchestrator.PRECISION
    );
  }

  private calculateMaxAllowedDebt(collateralValue: Field): Field {
    const numCollateralValue = collateralValue.mul(
      ZKUSDOrchestrator.COLLATERAL_RATIO_PRECISION
    );

    return this.fieldIntegerDiv(
      numCollateralValue,
      ZKUSDOrchestrator.COLLATERAL_RATIO
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
    const numerator = maxAllowedDebt.mul(
      ZKUSDOrchestrator.COLLATERAL_RATIO_PRECISION
    );
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

  @method
  async settle(proof: StateProof) {
    await this.offchainState.settle(proof);
  }

  @method.returns(CDPPosition)
  async getCDPPosition(cdpId: Field): Promise<CDPPosition> {
    const cdpOption = await this.offchainState.fields.cdps.get(cdpId);
    Provable.log(`CDP Position inside getCDPPosition:`, cdpOption);
    return cdpOption.orElse(
      new CDPPosition({
        id: cdpId,
        collateralAmount: UInt64.from(0),
        debtAmount: UInt64.from(0),
        ownershipHash: Field(0),
      })
    );
  }

  @method.returns(UInt64)
  async getTotalCollateral(): Promise<UInt64> {
    const totalCollateralOption =
      await this.offchainState.fields.totalCollateral.get();
    return totalCollateralOption.orElse(0n);
  }
}
