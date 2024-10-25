import {
  Struct,
  Field,
  UInt64,
  Bool,
  MerkleMapWitness,
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
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';

/*

We want to allow a user to create a CDP as long as the index of that CDP in the merkle tree is not taken

When the user creates the CDP they will also create a corresponding OwnershipProof of that CDP which will be the hash of 
the cdpId and a secret

When a user takes action on their CDP such as:
- depositing collateral
- minting stablecoin
- withdrawing collateral
- redeeming stablecoin

They will need to provide a proof that they know the secret associated with that cdpID
Once their ownership is proven they can update the cdp state

This means that only the user with the secret can update the cdp state and no one else even if they know the cdpId

The only action that doesnt need an ownership proof is liquidation, which requires certain other conditions to be met


*/

export class CDPPosition extends Struct({
  id: Field,
  collateralAmount: UInt64,
  debtAmount: UInt64,
}) {}

export class CDPOwnershipState extends Struct({
  cdpPositionCommitment: Field,
  secret: Field,
}) {}

export class GlobalState extends Struct({
  totalCollateral: UInt64,
  totalDebt: UInt64,
  cdpCount: UInt64,
  cdpTreeCommitment: Field,
  cdpOwnershipTreeCommitment: Field,
}) {}

export class ZKUSDOrchestrator extends SmartContract {
  @state(Field) cdpTreeCommitment = State<Field>();
  @state(Field) cdpOwnershipTreeCommitment = State<Field>();
  @state(UInt64) totalCollateral = State<UInt64>();
  @state(PublicKey) oraclePublicKey = State<PublicKey>();
  @state(PublicKey) zkUSDTokenAddress = State<PublicKey>();
  @state(Bool) interactionFlag = State<Bool>(Bool(false));

  static COLLATERAL_RATIO = Field.from(150);
  static COLLATERAL_RATIO_PRECISION = Field.from(100);
  static PRECISION = Field.from(1e9);
  static MIN_HEALTH_FACTOR = UInt64.from(100);

  async deploy(
    args: DeployArgs & {
      oraclePublicKey: PublicKey;
      cdpTreeCommitment: Field;
      cdpOwnershipTreeCommitment: Field;
      zkUSDTokenAddress: PublicKey;
    }
  ) {
    await super.deploy(args);
    this.oraclePublicKey.set(args.oraclePublicKey);
    this.cdpTreeCommitment.set(args.cdpTreeCommitment);
    this.cdpOwnershipTreeCommitment.set(args.cdpOwnershipTreeCommitment);
    this.totalCollateral.set(UInt64.from(0));
    this.zkUSDTokenAddress.set(args.zkUSDTokenAddress);
  }

  @method async createCDP(
    cdpWitness: MerkleMapWitness,
    cdpOwnershipWitness: MerkleMapWitness,
    cdpPosition: CDPPosition,
    secret: Field
  ) {
    const cdpTreeCommitment = this.cdpTreeCommitment.getAndRequireEquals();
    const cdpOwnershipTreeCommitment =
      this.cdpOwnershipTreeCommitment.getAndRequireEquals();

    // Validate that the CDP slot is empty and get the CDP id
    const cdpId = this.validateNewCDPSlot(
      cdpWitness,
      cdpOwnershipWitness,
      cdpTreeCommitment,
      cdpOwnershipTreeCommitment
    );

    // Ensure that the CDP id matches the provided CDP position id
    cdpId.assertEquals(cdpPosition.id);

    // Update the CDP tree with the new CDP
    const newCDPCommitment = Poseidon.hash(CDPPosition.toFields(cdpPosition));
    const [newCDPTreeRoot] = cdpWitness.computeRootAndKeyV2(newCDPCommitment);
    this.cdpTreeCommitment.set(newCDPTreeRoot);

    // Update the CDP ownership tree with the hash of the CDP id and the secret
    const newCDPOwnershipHash = Poseidon.hash([cdpPosition.id, secret]);
    const [newCDPOwnershipTreeRoot] =
      cdpOwnershipWitness.computeRootAndKeyV2(newCDPOwnershipHash);
    this.cdpOwnershipTreeCommitment.set(newCDPOwnershipTreeRoot);
  }

  @method async depositCollateral(
    cdpWitness: MerkleMapWitness,
    cdpOwnershipWitness: MerkleMapWitness,
    oldCDPPosition: CDPPosition,
    collateralAmount: UInt64,
    secret: Field
  ) {
    const totalCollateral = this.totalCollateral.getAndRequireEquals();
    const cdpTreeCommitment = this.cdpTreeCommitment.getAndRequireEquals();
    const cdpOwnershipTreeCommitment =
      this.cdpOwnershipTreeCommitment.getAndRequireEquals();

    // Validate CDP ownership
    this.validateCDPOwnership(
      cdpOwnershipWitness,
      cdpOwnershipTreeCommitment,
      oldCDPPosition.id,
      secret
    );

    // Validate CDP data
    this.validateCDPData(cdpWitness, cdpTreeCommitment, oldCDPPosition);

    // Calculate the new total collateral
    const newCollateralTotal = totalCollateral.add(collateralAmount);

    // Send the collateral to the orchestrator
    let collateralDeposit = AccountUpdate.createSigned(
      this.sender.getAndRequireSignatureV2()
    );
    collateralDeposit.send({
      to: this.address,
      amount: collateralAmount,
    });

    // Update the CDP position
    const newCDPPosition = new CDPPosition({
      id: oldCDPPosition.id,
      collateralAmount: oldCDPPosition.collateralAmount.add(collateralAmount),
      debtAmount: oldCDPPosition.debtAmount,
    });

    // Update the CDP tree with the new CDP position
    const newCDPCommitment = Poseidon.hash(
      CDPPosition.toFields(newCDPPosition)
    );
    const [newCDPTreeRoot] = cdpWitness.computeRootAndKeyV2(newCDPCommitment);
    this.cdpTreeCommitment.set(newCDPTreeRoot);

    // Update the total collateral
    this.totalCollateral.set(newCollateralTotal);
  }

  @method async redeemCollateral(
    cdpWitness: MerkleMapWitness,
    cdpOwnershipWitness: MerkleMapWitness,
    oldCDPPosition: CDPPosition,
    redeemAmount: UInt64,
    secret: Field,
    price: UInt64,
    signature: Signature
  ) {
    const totalCollateral = this.totalCollateral.getAndRequireEquals();
    const cdpTreeCommitment = this.cdpTreeCommitment.getAndRequireEquals();
    const cdpOwnershipTreeCommitment =
      this.cdpOwnershipTreeCommitment.getAndRequireEquals();

    // Validate CDP ownership
    this.validateCDPOwnership(
      cdpOwnershipWitness,
      cdpOwnershipTreeCommitment,
      oldCDPPosition.id,
      secret
    );

    // Validate CDP data
    this.validateCDPData(cdpWitness, cdpTreeCommitment, oldCDPPosition);

    // Verify the oracle price
    this.verifyOraclePrice(price, signature);

    // Check if there's enough collateral to redeem
    oldCDPPosition.collateralAmount.assertGreaterThanOrEqual(redeemAmount);

    // Calculate new collateral amount
    const newCollateralAmount =
      oldCDPPosition.collateralAmount.sub(redeemAmount);

    // Update the total collateral
    const newTotalCollateral = totalCollateral.sub(redeemAmount);
    this.totalCollateral.set(newTotalCollateral);

    // Create a new CDP position with updated collateral
    const newCDPPosition = new CDPPosition({
      id: oldCDPPosition.id,
      collateralAmount: newCollateralAmount,
      debtAmount: oldCDPPosition.debtAmount,
    });

    // Calculate the new health factor
    const healthFactor = this.calculateHealthFactor(
      newCDPPosition.collateralAmount,
      newCDPPosition.debtAmount,
      price
    );

    // Assert that the health factor is above the minimum required
    healthFactor.assertGreaterThanOrEqual(ZKUSDOrchestrator.MIN_HEALTH_FACTOR);

    // Update the CDP tree with the new CDP position
    const newCDPCommitment = Poseidon.hash(
      CDPPosition.toFields(newCDPPosition)
    );
    const [newCDPTreeRoot] = cdpWitness.computeRootAndKeyV2(newCDPCommitment);
    this.cdpTreeCommitment.set(newCDPTreeRoot);

    // Send the redeemed collateral back to the user
    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: redeemAmount,
    });
  }

  @method async mintZKUSD(
    cdpWitness: MerkleMapWitness,
    cdpOwnershipWitness: MerkleMapWitness,
    oldCDPPosition: CDPPosition,
    mintAmount: UInt64,
    recipient: PublicKey,
    secret: Field,
    price: UInt64,
    signature: Signature
  ) {
    const zkUSDToken = new FungibleToken(
      this.zkUSDTokenAddress.getAndRequireEquals()
    );

    const cdpTreeCommitment = this.cdpTreeCommitment.getAndRequireEquals();
    const cdpOwnershipTreeCommitment =
      this.cdpOwnershipTreeCommitment.getAndRequireEquals();

    // Validate CDP ownership
    this.validateCDPOwnership(
      cdpOwnershipWitness,
      cdpOwnershipTreeCommitment,
      oldCDPPosition.id,
      secret
    );

    // Validate CDP data
    this.validateCDPData(cdpWitness, cdpTreeCommitment, oldCDPPosition);

    // Verify the oracle price
    this.verifyOraclePrice(price, signature);

    // Check that the health factor is above the minimum required
    const healthFactor = this.calculateHealthFactor(
      oldCDPPosition.collateralAmount,
      oldCDPPosition.debtAmount.add(mintAmount),
      price
    );
    healthFactor.assertGreaterThanOrEqual(ZKUSDOrchestrator.MIN_HEALTH_FACTOR);

    // Update the CDP position
    const newCDPPosition = new CDPPosition({
      id: oldCDPPosition.id,
      collateralAmount: oldCDPPosition.collateralAmount,
      debtAmount: oldCDPPosition.debtAmount.add(mintAmount),
    });

    // Update the CDP tree with the new CDP position
    const newCDPCommitment = Poseidon.hash(
      CDPPosition.toFields(newCDPPosition)
    );
    const [newCDPTreeRoot] = cdpWitness.computeRootAndKeyV2(newCDPCommitment);
    this.cdpTreeCommitment.set(newCDPTreeRoot);

    // Mint the zkUSD for the user
    await zkUSDToken.mint(recipient, mintAmount);
    this.interactionFlag.set(Bool(true));
  }

  @method async burnZKUSD(
    cdpWitness: MerkleMapWitness,
    cdpOwnershipWitness: MerkleMapWitness,
    oldCDPPosition: CDPPosition,
    burnAmount: UInt64,
    secret: Field
  ) {
    const zkUSDToken = new FungibleToken(
      this.zkUSDTokenAddress.getAndRequireEquals()
    );

    const cdpTreeCommitment = this.cdpTreeCommitment.getAndRequireEquals();
    const cdpOwnershipTreeCommitment =
      this.cdpOwnershipTreeCommitment.getAndRequireEquals();

    // Validate CDP ownership
    this.validateCDPOwnership(
      cdpOwnershipWitness,
      cdpOwnershipTreeCommitment,
      oldCDPPosition.id,
      secret
    );

    // Validate CDP data
    this.validateCDPData(cdpWitness, cdpTreeCommitment, oldCDPPosition);

    // Ensure the user can't burn more than their debt
    oldCDPPosition.debtAmount.assertGreaterThanOrEqual(burnAmount);

    // Calculate the new CDP position
    const newCDPPosition = new CDPPosition({
      id: oldCDPPosition.id,
      collateralAmount: oldCDPPosition.collateralAmount,
      debtAmount: oldCDPPosition.debtAmount.sub(burnAmount),
    });

    // Update the CDP tree with the new CDP position
    const newCDPCommitment = Poseidon.hash(
      CDPPosition.toFields(newCDPPosition)
    );
    const [newCDPTreeRoot] = cdpWitness.computeRootAndKeyV2(newCDPCommitment);
    this.cdpTreeCommitment.set(newCDPTreeRoot);

    // Burn the zkUSD from the user's balance
    await zkUSDToken.burn(this.sender.getAndRequireSignatureV2(), burnAmount);
    this.interactionFlag.set(Bool(true));
  }

  @method async liquidateCDP(
    cdpWitness: MerkleMapWitness,
    cdpPosition: CDPPosition,
    price: UInt64,
    signature: Signature
  ) {
    // Validate CDP data
    const zkUSDToken = new FungibleToken(
      this.zkUSDTokenAddress.getAndRequireEquals()
    );

    // Validate CDP data
    this.validateCDPData(
      cdpWitness,
      this.cdpTreeCommitment.getAndRequireEquals(),
      cdpPosition
    );
    // Verify the oracle price
    this.verifyOraclePrice(price, signature);

    // Check that the health factor is below the minimum required
    const healthFactor = this.calculateHealthFactor(
      cdpPosition.collateralAmount,
      cdpPosition.debtAmount,
      price
    );
    healthFactor.assertLessThanOrEqual(ZKUSDOrchestrator.MIN_HEALTH_FACTOR);

    // Send the collateral to the liquidator
    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: cdpPosition.collateralAmount,
    });

    // Burn the zkUSD from the liquidator's balance
    await zkUSDToken.burn(
      this.sender.getAndRequireSignatureV2(),
      cdpPosition.debtAmount
    );
    this.interactionFlag.set(Bool(true));

    // Update the CDP tree with the new CDP position
    const newCDPCommitment = Poseidon.hash(
      CDPPosition.toFields({
        id: cdpPosition.id,
        collateralAmount: UInt64.from(0),
        debtAmount: UInt64.from(0),
      })
    );
    const [newCDPTreeRoot] = cdpWitness.computeRootAndKeyV2(newCDPCommitment);
    this.cdpTreeCommitment.set(newCDPTreeRoot);
  }

  // This flag is set so the zkUSD Admin contract can check its permissions
  @method.returns(Bool)
  public async assertInteractionFlag() {
    this.interactionFlag.requireEquals(Bool(true));
    this.interactionFlag.set(Bool(false));
    return Bool(true);
  }

  // Helper method to validate CDP ownership
  private validateCDPOwnership(
    cdpOwnershipWitness: MerkleMapWitness,
    cdpOwnershipTreeCommitment: Field,
    cdpId: Field,
    secret: Field
  ) {
    const cdpOwnershipHash = Poseidon.hash([cdpId, secret]);
    const [computedCDPOwnershipTreeRoot] =
      cdpOwnershipWitness.computeRootAndKeyV2(cdpOwnershipHash);
    cdpOwnershipTreeCommitment.assertEquals(computedCDPOwnershipTreeRoot);
  }

  // Helper method to validate CDP data
  private validateCDPData(
    cdpWitness: MerkleMapWitness,
    cdpTreeCommitment: Field,
    cdpPosition: CDPPosition
  ) {
    const cdpCommitment = Poseidon.hash(CDPPosition.toFields(cdpPosition));
    const [computedCDPTreeRoot, computedCDPKey] =
      cdpWitness.computeRootAndKeyV2(cdpCommitment);
    cdpTreeCommitment.assertEquals(computedCDPTreeRoot);

    // Ensure the CDP ID matches
    computedCDPKey.assertEquals(cdpPosition.id);
  }

  // Helper method to validate that the CDP slot is empty when creating a new CDP
  private validateNewCDPSlot(
    cdpWitness: MerkleMapWitness,
    cdpOwnershipWitness: MerkleMapWitness,
    cdpTreeCommitment: Field,
    cdpOwnershipTreeCommitment: Field
  ): Field {
    // The slot should be empty (value zero)
    const emptyValue = Field.from(0);

    // Get the computed root and key from the CDP tree witness
    const [computedCDPTreeCommitment, computedCDPKey] =
      cdpWitness.computeRootAndKeyV2(emptyValue);

    // Get the computed root and key from the CDP Ownership tree witness
    const [computedCDPOwnershipTreeCommitment, computedCDPOwnershipTreeKey] =
      cdpOwnershipWitness.computeRootAndKeyV2(emptyValue);

    // The keys should be the same - i.e., the CDP id
    computedCDPKey.assertEquals(computedCDPOwnershipTreeKey);

    // Assert that the commitments on-chain match the computed commitments
    cdpTreeCommitment.assertEquals(computedCDPTreeCommitment);
    cdpOwnershipTreeCommitment.assertEquals(computedCDPOwnershipTreeCommitment);

    return computedCDPKey;
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
}
