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
  Experimental,
} from 'o1js';
import { ZkUsdVault } from '../zkusd-vault.js';
import { ZkUsdAdmin } from '../zkusd-token-admin.js';
import { equal } from 'node:assert';
import { Oracle } from '../oracle.js';
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
const oracle = new Oracle(Local);

// Set up FungibleToken AdminContract
FungibleToken.AdminContract = ZkUsdAdmin;

// Create key pairs and contracts

const aliceCDPKeyPair = {
  privateKey: PrivateKey.fromBase58(
    'EKEoFYyHic5tuKE5GMNWbQFxrKLXMrazbxJqwrtw3dTLV9auQanM'
  ),
  publicKey: PublicKey.fromBase58(
    'B62qqjGxQbMpQTbStgN8nM7C1wXvUfQYqM3kXc34hLqnBH2WanCDd49'
  ),
};

const bobCDPKeyPair = {
  privateKey: PrivateKey.fromBase58(
    'EKF8rqoK5WvhUQZCzeDVKsJFUJpmXEZpykQ8H6LGKkcuFhnCb7jm'
  ),
  publicKey: PublicKey.fromBase58(
    'B62qj3WKvDP1brqZsMeNxBWZ324bDmkbiVqkYa7dMzHhm2oXdB2yuYV'
  ),
};

const adminKeyPair = {
  privateKey: PrivateKey.fromBase58(
    'EKFPts6KALweqsniSsnq3eCWRskWtMaZdBjoyJ8AZuX2yuZPbmEg'
  ),
  publicKey: PublicKey.fromBase58(
    'B62qmrVkuYGu3NU4apAALjxcZVLGN5n2hdPSpfJghhHpjyjQbMWDtbM'
  ),
};

const tokenKeyPair = {
  privateKey: PrivateKey.fromBase58(
    'EKDveJ7bFB2SEFU52rgob94xa9NV5fVwarpDKGSQ6TPkmtb9MNd9'
  ),
  publicKey: PublicKey.fromBase58(
    'B62qry2wngUSGZqQn9erfnA9rZPn4cMbDG1XPasGdK1EtKQAxmgjDtt'
  ),
};

const adminContract = new ZkUsdAdmin(adminKeyPair.publicKey);
const tokenContract = new FungibleToken(tokenKeyPair.publicKey);
const aliceCDPContract = new ZkUsdVault(aliceCDPKeyPair.publicKey);
const bobCDPContract = new ZkUsdVault(bobCDPKeyPair.publicKey);

const aliceSecret = Field.random();
const bobSecret = Field.random();

if (useProof) {
  //compile the contracts
  await ZkUsdVault.compile();
  await ZkUsdAdmin.compile();
  await FungibleToken.compile();
}

// Helper function to execute transactions
async function executeTransaction(
  sender: PublicKey,
  signKeys: PrivateKey[],
  transactionCallback: () => Promise<void>,
  printTx: boolean = false
) {
  const tx = await Mina.transaction(
    {
      sender,
    },
    transactionCallback
  );

  if (printTx) {
    console.log(tx.toPretty());
  }

  try {
    await tx.prove();
    tx.sign(signKeys);
    const sentTx = await tx.send();
    const txResult = await sentTx.wait();
    if (txResult.status !== 'included') {
      console.log('Transaction failed with status', txResult.toPretty());
      throw new Error(`Transaction failed with status ${txResult.status}`);
    }

    return txResult;
  } catch (error) {
    console.log(tx.toPretty());
    console.log('With transaction:', error);
    process.exit(1);
  }
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
    await tokenContract.getBalanceOf(alice)
  ).toBigInt();
  const aliceCDPZKUSDBalance = (
    await tokenContract.getBalanceOf(aliceCDPContract.address)
  ).toBigInt();

  const bobMinaBalance = Mina.getBalance(bob).toBigInt();
  const bobZKUSDBalance = (await tokenContract.getBalanceOf(bob)).toBigInt();
  const bobCDPZKUSDBalance = (
    await tokenContract.getBalanceOf(bobCDPContract.address)
  ).toBigInt();

  //Get the health factor
  let aliceHealthFactor = aliceCDPContract.calculateHealthFactor(
    aliceCDPContract.collateralAmount.get(),
    aliceCDPContract.debtAmount.get(),
    price
  );

  if (aliceHealthFactor.toBigInt() === UInt64.MAXINT().toBigInt()) {
    aliceHealthFactor = UInt64.from(0);
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
      aliceCDPContract.collateralAmount.get().toBigInt()
    )} MINA`
  );
  console.log(
    `  Debt Amount: ${formatBalance(
      aliceCDPContract.debtAmount.get().toBigInt()
    )} zkUSD`
  );
  console.log(
    `  CDP zkUSD Balance: ${formatBalance(aliceCDPZKUSDBalance)} zkUSD`
  );
  console.log(`  Health Factor: ${aliceHealthFactor}`);

  // Only show Bob's details if his CDP exists (has collateral)
  try {
    let bobHealthFactor = bobCDPContract.calculateHealthFactor(
      bobCDPContract.collateralAmount.get(),
      bobCDPContract.debtAmount.get(),
      price
    );

    if (bobHealthFactor.toBigInt() === UInt64.MAXINT().toBigInt()) {
      bobHealthFactor = UInt64.from(0);
    }

    const bobCollateral = bobCDPContract.collateralAmount.get();

    console.log(`\nBob's Public Key: ${bob.toBase58()}`);
    console.log(`Bob's Mina Balance: ${formatBalance(bobMinaBalance)} MINA`);
    console.log(`Bob's zkUSD Balance: ${formatBalance(bobZKUSDBalance)} zkUSD`);
    console.log(`Bob's CDP Position:`);
    console.log(
      `  Collateral Amount: ${formatBalance(bobCollateral.toBigInt())} MINA`
    );
    console.log(
      `  Debt Amount: ${formatBalance(
        bobCDPContract.debtAmount.get().toBigInt()
      )} zkUSD`
    );
    console.log(
      `  CDP zkUSD Balance: ${formatBalance(bobCDPZKUSDBalance)} zkUSD`
    );
    console.log(`  Health Factor: ${bobHealthFactor}`);
  } catch (error) {
    // If Bob's CDP doesn't exist yet, we'll skip printing his details
  }

  console.log('-------------\n');
}

// Main function to run the interactions
async function main() {
  // Deploy the zkUSDToken and Admin contracts
  console.log('Deploying zkUSD Token and Admin contracts...');
  await executeTransaction(
    deployer,
    [deployer.key, adminKeyPair.privateKey, tokenKeyPair.privateKey],
    async () => {
      AccountUpdate.fundNewAccount(deployer, 3);
      await adminContract.deploy({});
      await tokenContract.deploy({
        symbol: 'zkUSD',
        src: 'https://github.com/MinaFoundation/mina-fungible-token/blob/main/FungibleToken.ts',
      });
      await tokenContract.initialize(
        adminKeyPair.publicKey,
        UInt8.from(9),
        Bool(false)
      );
    }
  );
  console.log('zkUSD Token and Admin contracts deployed.');
  console.log('--------------------------------');

  // Deploy the zkUSD Orchestrator contract
  console.log("Deploying Alice's CDP contract...");

  await executeTransaction(
    alice,
    [alice.key, aliceCDPKeyPair.privateKey],
    async () => {
      AccountUpdate.fundNewAccount(alice, 1);
      await aliceCDPContract.deploy({
        secret: aliceSecret,
      });
    }
  );
  console.log('zkUSD Orchestrator contract deployed.');

  console.log(await Mina.getAccount(aliceCDPContract.address).delegate);

  console.log('Depositing collateral...');
  await executeTransaction(alice, [alice.key], async () => {
    await aliceCDPContract.depositCollateral(UInt64.from(10e9), aliceSecret);
  });

  console.log('Minting zkUSD...');

  await executeTransaction(alice, [alice.key], async () => {
    AccountUpdate.fundNewAccount(alice, 1);
    await aliceCDPContract.mintZkUsd(
      UInt64.from(5e9),
      aliceSecret,
      oracle.getSignedPrice()
    );
  });

  await printState();

  await executeTransaction(
    alice,
    [alice.key, aliceCDPKeyPair.privateKey],
    async () => {
      AccountUpdate.fundNewAccount(alice, 1);
      await aliceCDPContract.withdrawZkUsd(UInt64.from(5e9), aliceSecret);
    }
  );

  await printState();

  console.log('Burning zkUSD...');
  await executeTransaction(alice, [alice.key], async () => {
    await aliceCDPContract.burnZkUsd(UInt64.from(1e9), aliceSecret);
  });

  await printState();

  //Now to test the liquidation Bob needs to create a position and mint some zkUSD

  console.log('Bob deploying CDP contract...');
  await executeTransaction(
    bob,
    [bob.key, bobCDPKeyPair.privateKey],
    async () => {
      AccountUpdate.fundNewAccount(bob, 1);
      await bobCDPContract.deploy({
        secret: bobSecret,
      });
    }
  );

  console.log('Bob depositing collateral...');
  await executeTransaction(bob, [bob.key], async () => {
    await bobCDPContract.depositCollateral(UInt64.from(500e9), bobSecret);
  });

  console.log('Bob minting zkUSD...');
  await executeTransaction(bob, [bob.key], async () => {
    AccountUpdate.fundNewAccount(bob, 1);
    await bobCDPContract.mintZkUsd(
      UInt64.from(100e9),
      bobSecret,
      oracle.getSignedPrice()
    );
  });

  //Bob withdraws his zkUSD
  console.log('Bob withdrawing zkUSD...');
  await executeTransaction(
    bob,
    [bob.key, bobCDPKeyPair.privateKey],
    async () => {
      AccountUpdate.fundNewAccount(bob, 1);
      await bobCDPContract.withdrawZkUsd(UInt64.from(100e9), bobSecret);
    }
  );

  await printState();

  //MARKET CRASH

  oracle.setPrice(UInt64.from(0.5e9));

  await printState();

  //Bob liquidates Alice's position
  console.log("Bob liquidating Alice's position...");
  await executeTransaction(bob, [bob.key], async () => {
    await aliceCDPContract.liquidate(oracle.getSignedPrice());
  });

  await printState();
}

// Run the main function
main().catch((error) => {
  console.error('Error during execution:', error);
});
