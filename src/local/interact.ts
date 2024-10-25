import {
  AccountUpdate,
  Field,
  MerkleMap,
  Mina,
  Poseidon,
  PrivateKey,
  UInt64,
  Provable,
  UInt8,
  Bool,
  PublicKey,
} from 'o1js';
import {
  ZKUSDOrchestrator,
  CDPPosition,
} from '../contracts/ZKUSDOrchestrator.js';
import { ZKUSDAdmin } from '../contracts/ZKUSDAdmin.js';
import { equal } from 'node:assert';
import { CDPStateManager } from '../utils/CDPLocalStateManager.js';
import { Oracle } from '../utils/Oracle.js';
import { FungibleToken } from 'mina-fungible-token';

// Constants and variables
const fee = 1e9;
const useProof = false;

// Initialize Mina Local Blockchain
const Local = await Mina.LocalBlockchain({ proofsEnabled: useProof });
Mina.setActiveInstance(Local);

// Define accounts
const [deployer, alice, bob] = Local.testAccounts;

// Create the oracle
const oracleKeyPair = PrivateKey.randomKeypair();
const oracle = new Oracle(oracleKeyPair.privateKey);

// Set up FungibleToken AdminContract
FungibleToken.AdminContract = ZKUSDAdmin;

// Create key pairs and contracts
const zkUSDOrchestratorKeyPair = PrivateKey.randomKeypair();
const zkUSDOrchestratorContract = new ZKUSDOrchestrator(
  zkUSDOrchestratorKeyPair.publicKey
);

const zkUSDAdminKeyPair = PrivateKey.randomKeypair();
const zkUSDAdminContract = new ZKUSDAdmin(zkUSDAdminKeyPair.publicKey);

const zkUSDTokenKeyPair = PrivateKey.randomKeypair();
const zkUSDTokenContract = new FungibleToken(zkUSDTokenKeyPair.publicKey);

// Create the CDP State Manager
console.log('Creating CDP State Manager...');
const cdpStateManager = new CDPStateManager(zkUSDOrchestratorKeyPair.publicKey);
await cdpStateManager.initialize();

// Helper function to execute transactions
async function executeTransaction(
  sender: PublicKey,
  signKeys: PrivateKey[],
  transactionCallback: () => Promise<void>
) {
  const tx = await Mina.transaction(
    {
      sender,
    },
    transactionCallback
  );
  await tx.prove();
  tx.sign(signKeys);
  console.log(tx.toPretty());
  const sentTx = await tx.send();
  const txResult = await sentTx.wait();
  if (txResult.status !== 'included') {
    throw new Error(`Transaction failed with status ${txResult.status}`);
  }

  return txResult;
}

// Function to format balances
function formatBalance(balanceBigInt: bigint) {
  const balance = Number(balanceBigInt) / 1e9; // Convert nanomina to MINA
  return balance.toFixed(9); // Display 9 decimal places
}

// Function to print the current state
async function printState() {
  // Get the current price and signature from the oracle
  const { price, signature } = oracle.getSignedPrice();
  const aliceMinaBalance = Mina.getBalance(alice).toBigInt();
  const aliceZKUSDBalance = (
    await zkUSDTokenContract.getBalanceOf(alice)
  ).toBigInt();
  const bobMinaBalance = Mina.getBalance(bob).toBigInt();
  const bobZKUSDBalance = (
    await zkUSDTokenContract.getBalanceOf(bob)
  ).toBigInt();

  const aliceCDP = await cdpStateManager.getCDPPosition(
    Poseidon.hash(alice.toFields())
  );
  const bobCDP = await cdpStateManager.getCDPPosition(
    Poseidon.hash(bob.toFields())
  );

  let aliceHealthFactor = zkUSDOrchestratorContract.calculateHealthFactor(
    aliceCDP.collateralAmount,
    aliceCDP.debtAmount,
    price
  );

  let bobHealthFactor = zkUSDOrchestratorContract.calculateHealthFactor(
    bobCDP.collateralAmount,
    bobCDP.debtAmount,
    price
  );

  if (aliceHealthFactor.toBigInt() === UInt64.MAXINT().toBigInt()) {
    aliceHealthFactor = UInt64.from(0);
  }

  if (bobHealthFactor.toBigInt() === UInt64.MAXINT().toBigInt()) {
    bobHealthFactor = UInt64.from(0);
  }

  console.log('\n--- State ---');
  console.log(`\nAlice's Public Key: ${alice.toBase58()}`);
  console.log(`Alice's Mina Balance: ${formatBalance(aliceMinaBalance)} MINA`);
  console.log(
    `Alice's zkUSD Balance: ${formatBalance(aliceZKUSDBalance)} zkUSD`
  );
  console.log(`Alice's CDP Position:`);
  console.log(
    `  Collateral Amount: ${formatBalance(
      aliceCDP.collateralAmount.toBigInt()
    )} MINA`
  );
  console.log(
    `  Debt Amount: ${formatBalance(aliceCDP.debtAmount.toBigInt())} zkUSD`
  );
  console.log(`Alice's Health Factor: ${aliceHealthFactor}`);
  console.log(`\nBob's Public Key: ${bob.toBase58()}`);
  console.log(`Bob's Mina Balance: ${formatBalance(bobMinaBalance)} MINA`);
  console.log(`Bob's zkUSD Balance: ${formatBalance(bobZKUSDBalance)} zkUSD`);
  console.log(`Bob's CDP Position:`);
  console.log(
    `  Collateral Amount: ${formatBalance(
      bobCDP.collateralAmount.toBigInt()
    )} MINA`
  );
  console.log(
    `  Debt Amount: ${formatBalance(bobCDP.debtAmount.toBigInt())} zkUSD`
  );
  console.log(`Bob's Health Factor: ${bobHealthFactor}`);
  console.log('-------------\n');
}

// Main function to run the interactions
async function main() {
  // Get the initial price and signature from the oracle
  const { price, signature } = oracle.getSignedPrice();

  // Deploy the zkUSDToken and Admin contracts
  console.log('Deploying zkUSD Token and Admin contracts...');
  await executeTransaction(
    deployer,
    [deployer.key, zkUSDAdminKeyPair.privateKey, zkUSDTokenKeyPair.privateKey],
    async () => {
      AccountUpdate.fundNewAccount(deployer, 3);
      await zkUSDAdminContract.deploy({
        orchestratorPublicKey: zkUSDOrchestratorKeyPair.publicKey,
      });
      await zkUSDTokenContract.deploy({
        symbol: 'zkUSD',
        src: 'https://github.com/MinaFoundation/mina-fungible-token/blob/main/FungibleToken.ts',
      });
      await zkUSDTokenContract.initialize(
        zkUSDAdminKeyPair.publicKey,
        UInt8.from(9),
        Bool(false)
      );
    }
  );
  console.log('zkUSD Token and Admin contracts deployed.');
  await printState();

  // Deploy the zkUSD Orchestrator contract
  console.log('Deploying zkUSD Orchestrator contract...');
  await executeTransaction(
    deployer,
    [deployer.key, zkUSDOrchestratorKeyPair.privateKey],
    async () => {
      AccountUpdate.fundNewAccount(deployer, 1);
      await zkUSDOrchestratorContract.deploy({
        oraclePublicKey: oracle.publicKey,
        cdpTreeCommitment: cdpStateManager.getCDPRoot(),
        cdpOwnershipTreeCommitment: cdpStateManager.getCDPOwnershipRoot(),
        zkUSDTokenAddress: zkUSDTokenKeyPair.publicKey,
      });
    }
  );
  console.log('zkUSD Orchestrator contract deployed.');
  await printState();

  // Alice creates a CDP
  console.log('Alice is creating a new CDP...');
  const aliceCDPId = Poseidon.hash(alice.toFields());
  const secret = Field(1234);
  const aliceCDPWitness = cdpStateManager.getCDPWitness(aliceCDPId);
  const aliceCDPOwnershipWitness =
    cdpStateManager.getCDPOwnershipWitness(aliceCDPId);

  await executeTransaction(alice, [alice.key], async () => {
    await zkUSDOrchestratorContract.createCDP(
      aliceCDPWitness,
      aliceCDPOwnershipWitness,
      await cdpStateManager.getCDPPosition(aliceCDPId),
      secret
    );
  });
  console.log('Alice created a CDP.');
  await printState();

  //Update the local CDP Position with ownership
  cdpStateManager.updateCDPPosition(
    aliceCDPId,
    await cdpStateManager.getCDPPosition(aliceCDPId),
    secret
  );

  // Alice deposits collateral
  const depositAmount = UInt64.from(10e9);
  console.log(
    `Alice is depositing ${formatBalance(
      depositAmount.toBigInt()
    )} MINA as collateral...`
  );

  await executeTransaction(alice, [alice.key], async () => {
    await zkUSDOrchestratorContract.depositCollateral(
      aliceCDPWitness,
      aliceCDPOwnershipWitness,
      await cdpStateManager.getCDPPosition(aliceCDPId),
      depositAmount,
      secret
    );
  });

  // Update local CDP position
  cdpStateManager.updateCDPPosition(aliceCDPId, {
    collateralAmount: depositAmount,
  });
  console.log('Alice deposited collateral.');
  await printState();

  // Alice mints zkUSD
  const mintAmount = UInt64.from(6e9);
  console.log(
    `Alice is minting ${formatBalance(mintAmount.toBigInt())} zkUSD...`
  );

  await executeTransaction(alice, [alice.key], async () => {
    AccountUpdate.fundNewAccount(alice, 1);
    await zkUSDOrchestratorContract.mintZKUSD(
      aliceCDPWitness,
      aliceCDPOwnershipWitness,
      await cdpStateManager.getCDPPosition(aliceCDPId),
      mintAmount,
      alice,
      secret,
      price,
      signature
    );
  });

  // Update local CDP position
  cdpStateManager.updateCDPPosition(aliceCDPId, {
    debtAmount: mintAmount,
  });
  console.log('Alice minted zkUSD.');
  await printState();

  // Alice burns zkUSD
  const burnAmount = UInt64.from(1e9);
  console.log(
    `Alice is burning ${formatBalance(burnAmount.toBigInt())} zkUSD...`
  );

  await executeTransaction(alice, [alice.key], async () => {
    await zkUSDOrchestratorContract.burnZKUSD(
      aliceCDPWitness,
      aliceCDPOwnershipWitness,
      await cdpStateManager.getCDPPosition(aliceCDPId),
      burnAmount,
      secret
    );
  });

  // Update local CDP position
  const currentDebt = (await cdpStateManager.getCDPPosition(aliceCDPId))
    .debtAmount;
  cdpStateManager.updateCDPPosition(aliceCDPId, {
    debtAmount: currentDebt.sub(burnAmount),
  });
  console.log('Alice burned zkUSD.');
  await printState();

  // Bob liquidates Alice's CDP
  console.log('Bob creates HUGE position');

  // Bob creates a large CDP position
  const bobCollateralAmount = UInt64.from(750e9); // 500 MINA
  const bobDebtAmount = UInt64.from(20e9); // 250 zkUSD
  const bobSecret = Field.random();
  const bobCDPId = Poseidon.hash(bob.toFields());
  const bobCDPWitness = cdpStateManager.getCDPWitness(bobCDPId);
  const bobCDPOwnershipWitness =
    cdpStateManager.getCDPOwnershipWitness(bobCDPId);

  console.log(
    `Bob is creating a CDP with ${formatBalance(
      bobCollateralAmount.toBigInt()
    )} MINA as collateral...`
  );

  await executeTransaction(bob, [bob.key], async () => {
    await zkUSDOrchestratorContract.createCDP(
      bobCDPWitness,
      bobCDPOwnershipWitness,
      await cdpStateManager.getCDPPosition(bobCDPId),
      bobSecret
    );
  });

  // Update the local CDP Position with ownership
  cdpStateManager.updateCDPPosition(
    bobCDPId,
    await cdpStateManager.getCDPPosition(bobCDPId),
    bobSecret
  );

  await executeTransaction(bob, [bob.key], async () => {
    await zkUSDOrchestratorContract.depositCollateral(
      bobCDPWitness,
      bobCDPOwnershipWitness,
      await cdpStateManager.getCDPPosition(bobCDPId),
      bobCollateralAmount,
      bobSecret
    );
  });

  cdpStateManager.updateCDPPosition(bobCDPId, {
    collateralAmount: bobCollateralAmount,
  });

  await executeTransaction(bob, [bob.key], async () => {
    AccountUpdate.fundNewAccount(bob, 1);
    await zkUSDOrchestratorContract.mintZKUSD(
      bobCDPWitness,
      bobCDPOwnershipWitness,
      await cdpStateManager.getCDPPosition(bobCDPId),
      bobDebtAmount,
      bob,
      bobSecret,
      price,
      signature
    );
  });

  cdpStateManager.updateCDPPosition(bobCDPId, {
    debtAmount: bobDebtAmount,
  });
  console.log('Bob created HUGE Position.');
  await printState();

  //Simulate oracle price drop
  oracle.setPrice(UInt64.from(0.5e9));

  console.log('PRICE DROP BY HALF');
  await printState();

  const { price: newPrice, signature: newSignature } = oracle.getSignedPrice();

  //Bob can now liquidate Alice's CDP
  await executeTransaction(bob, [bob.key], async () => {
    await zkUSDOrchestratorContract.liquidateCDP(
      cdpStateManager.getCDPWitness(aliceCDPId),
      await cdpStateManager.getCDPPosition(aliceCDPId),
      newPrice,
      newSignature
    );
  });

  console.log('Alice CDP liquidated by Bob');

  //update our local state
  cdpStateManager.updateCDPPosition(aliceCDPId, {
    collateralAmount: UInt64.from(0),
    debtAmount: UInt64.from(0),
  });

  await printState();
}

// Run the main function
main().catch((error) => {
  console.error('Error during execution:', error);
});
