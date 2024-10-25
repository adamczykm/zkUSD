// import {
//   Struct,
//   Field,
//   UInt64,
//   Bool,
//   MerkleMapWitness,
//   Poseidon,
//   SmartContract,
//   state,
//   State,
//   method,
//   AccountUpdate,
//   PublicKey,
//   DeployArgs,
//   Signature,
//   Provable,
//   Experimental,
//   MerkleMap,
// } from 'o1js';
// import { FungibleToken } from 'mina-fungible-token';

// const { BatchReducer } = Experimental;

// export class CDPPosition extends Struct({
//   id: Field,
//   collateralAmount: UInt64,
//   debtAmount: UInt64,
//   ownershipHash: Field,
// }) {}

// // Define a struct for the possible actions a user might take on a CDP
// export class CDPAction extends Struct({
//   actionType: Field, // E.g., 0 for deposit, 1 for withdrawal, etc.
//   cdpId: Field,
//   cdpPosition: CDPPosition,
//   cdpWitness: MerkleMapWitness,
//   actionAmount: UInt64, // The amount involved in the action (e.g., collateral, debt)
// }) {}

// // Define constants for action types
// export const ACTION_TYPE = {
//   CREATE: Field(0),
//   DEPOSIT: Field(1),
//   REDEEM: Field(2),
//   MINT: Field(3),
//   BURN: Field(4),
// };

// // set up reducer
// let batchReducer = new BatchReducer({
//   actionType: CDPAction,

//   // artificially low batch size to test batch splitting more easily
//   batchSize: 3,

//   // artificially low max pending action lists we process per proof, to test recursive proofs
//   // the default is 100 in the final (zkApp) proof, and 300 per recursive proof
//   // these could be set even higher (at the cost of larger proof times in the case of few actions)
//   maxUpdatesFinalProof: 4,
//   maxUpdatesPerProof: 4,
// });

// class Batch extends batchReducer.Batch {}
// class BatchProof extends batchReducer.BatchProof {}

// export class ZKUSDOrchestrator extends SmartContract {
//   @state(Field) cdpTreeCommitment = State<Field>();
//   @state(UInt64) totalCollateral = State<UInt64>();
//   @state(PublicKey) oraclePublicKey = State<PublicKey>();
//   @state(PublicKey) zkUSDTokenAddress = State<PublicKey>();

//   async deploy(
//     args: DeployArgs & {
//       oraclePublicKey: PublicKey;
//       cdpTreeCommitment: Field;
//       cdpOwnershipTreeCommitment: Field;
//       zkUSDTokenAddress: PublicKey;
//     }
//   ) {
//     await super.deploy(args);
//     this.oraclePublicKey.set(args.oraclePublicKey);
//     this.cdpTreeCommitment.set(args.cdpTreeCommitment);
//     this.totalCollateral.set(UInt64.from(0));
//     this.zkUSDTokenAddress.set(args.zkUSDTokenAddress);
//   }

//   @method async createCDP(cdpId: Field, secret: Field) {
//     const cdpOwnershipHash = Poseidon.hash([cdpId, secret]);

//     const cdpPosition = new CDPPosition({
//       id: cdpId,
//       collateralAmount: UInt64.from(0),
//       debtAmount: UInt64.from(0),
//       ownershipHash: cdpOwnershipHash,
//     });

//     const cdpAction = new CDPAction({
//       actionType: ACTION_TYPE.CREATE,
//       cdpId,
//       cdpPosition,
//       actionAmount: UInt64.from(0),
//     });

//     batchReducer.dispatch(cdpAction);
//   }

//   @method async settleActions(
//     batch: Batch,
//     proof: BatchProof,
//     cdpMap: MerkleMap
//   ) {
//     const cdpTreeCommitment = this.cdpTreeCommitment.getAndRequireEquals();

//     batchReducer.processBatch({ batch, proof }, (action, isDummy) => {
//       const isCreate = action.actionType.equals(ACTION_TYPE.CREATE);
//       const isDeposit = action.actionType.equals(ACTION_TYPE.DEPOSIT);
//       const isRedeem = action.actionType.equals(ACTION_TYPE.REDEEM);
//       const isMint = action.actionType.equals(ACTION_TYPE.MINT);
//       const isBurn = action.actionType.equals(ACTION_TYPE.BURN);

//       const mask = [isCreate, isDeposit, isRedeem, isMint, isBurn];

//       Provable.switch(
//         mask,
//         Field as any,
//         [
//           () => this.handleCreate(action, cdpTreeCommitment),
//           () => this.handleDeposit(action),
//           () => this.handleRedeem(action),
//           () => this.handleMint(action),
//           () => this.handleBurn(action),
//         ],
//         { allowNonExclusive: false }
//       );
//     });
//   }

//   private handleCreate(action: CDPAction, cdpTreeCommitment: Field) {
//     const { cdpId, cdpPosition, cdpWitness } = action;

//     //To create a new CDP, the slot must be empty
//     const emptyValue = Field.from(0);

//     // Get the computed root and key from the CDP tree witness
//     const [computedCDPTreeCommitment, computedCDPKey] =
//       cdpWitness.computeRootAndKeyV2(emptyValue);

//     computedCDPKey.assertEquals(cdpId);
//     cdpTreeCommitment.assertEquals(computedCDPTreeCommitment);

//     const newCDPCommitment = Poseidon.hash(CDPPosition.toFields(cdpPosition));
//     const [newCDPTreeRoot] = cdpWitness.computeRootAndKeyV2(newCDPCommitment);
//     this.cdpTreeCommitment.set(newCDPTreeRoot);
//   }
//   @method async handleDeposit(action: CDPAction) {}
//   @method async handleRedeem(action: CDPAction) {}
//   @method async handleMint(action: CDPAction) {}
//   @method async handleBurn(action: CDPAction) {}
// }
