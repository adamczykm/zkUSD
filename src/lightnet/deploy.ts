import {
  AccountUpdate,
  Bool,
  fetchAccount,
  Lightnet,
  Mina,
  PrivateKey,
  PublicKey,
  UInt8,
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';
import fs from 'fs';
import path, { dirname } from 'path';
import { ZKUSDOrchestrator } from '../contracts/ZKUSDOrchestrator.js';
import { ZKUSDAdmin } from '../contracts/ZKUSDAdmin.js';
import { CDPStateManager } from '../utils/CDPLocalStateManager.js';
import { Oracle } from '../utils/Oracle.js';
import { fileURLToPath } from 'url';
import { KeyManager } from '../utils/KeyManager.js';

const networkType = 'lightnet';
const fee = 1e8;

const keyManager = new KeyManager(networkType);

// Replace the writeKeysToFile function with:
const writeKeys = (
  name: string,
  keyPair: { privateKey: PrivateKey; publicKey: PublicKey }
) => {
  keyManager.writeKeys(name, keyPair);
};

async function main() {
  try {
    // Initialize Mina Local Blockchain
    const network = await Mina.Network({
      mina: 'http://127.0.0.1:8080/graphql',
      archive: 'http://127.0.0.1:8282',
      lightnetAccountManager: 'http://127.0.0.1:8181',
    });

    Mina.setActiveInstance(network);

    // deployer setup
    const deployerPrivateKey = (await Lightnet.acquireKeyPair()).privateKey;
    const deployerAccount = deployerPrivateKey.toPublicKey();

    // Create the oracle
    const oracleKeyPair = PrivateKey.randomKeypair();
    const oracle = new Oracle(oracleKeyPair.privateKey);

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

    // Write keys to files
    writeKeys('zkUSDOrchestrator', zkUSDOrchestratorKeyPair);
    writeKeys('zkUSDAdmin', zkUSDAdminKeyPair);
    writeKeys('zkUSDToken', zkUSDTokenKeyPair);
    writeKeys('oracle', oracleKeyPair);

    // Create the CDP State Manager
    const cdpStateManager = new CDPStateManager(
      zkUSDOrchestratorKeyPair.publicKey
    );

    console.log(`Fetching the fee payer account information.`);
    const accountDetails = (await fetchAccount({ publicKey: deployerAccount }))
      .account;
    console.log(
      `Using the fee payer account ${deployerAccount.toBase58()} with nonce: ${
        accountDetails?.nonce
      } and balance: ${accountDetails?.balance}.`
    );
    console.log('');

    console.log('Compiling the smart contract.');
    const { verificationKey: zkUSDOrchestratorVerificationKey } =
      await ZKUSDOrchestrator.compile();
    const { verificationKey: zkUSDAdminVerificationKey } =
      await ZKUSDAdmin.compile();
    const { verificationKey: zkUSDTokenVerificationKey } =
      await FungibleToken.compile();

    console.log('Compiling done. Deploying the contracts.');

    const deploy = await Mina.transaction(
      {
        sender: deployerAccount,
        fee: fee,
      },
      async () => {
        AccountUpdate.fundNewAccount(deployerAccount, 4);
        await zkUSDAdminContract.deploy({
          verificationKey: zkUSDAdminVerificationKey,
          orchestratorPublicKey: zkUSDOrchestratorKeyPair.publicKey,
        });
        await zkUSDTokenContract.deploy({
          symbol: 'zkUSD',
          src: 'https://github.com/MinaFoundation/mina-fungible-token/blob/main/FungibleToken.ts',
          verificationKey: zkUSDTokenVerificationKey,
        });
        await zkUSDTokenContract.initialize(
          zkUSDAdminKeyPair.publicKey,
          UInt8.from(9),
          Bool(false)
        );
        await zkUSDOrchestratorContract.deploy({
          verificationKey: zkUSDOrchestratorVerificationKey,
          oraclePublicKey: oracle.publicKey,
          cdpTreeCommitment: cdpStateManager.getCDPRoot(),
          cdpOwnershipTreeCommitment: cdpStateManager.getCDPOwnershipRoot(),
          zkUSDTokenAddress: zkUSDTokenKeyPair.publicKey,
        });
      }
    );
    await deploy.prove();
    deploy.sign([
      deployerPrivateKey,
      zkUSDAdminKeyPair.privateKey,
      zkUSDTokenKeyPair.privateKey,
      zkUSDOrchestratorKeyPair.privateKey,
    ]);
    console.log(deploy.toPretty());
    let pendingTx = await deploy.send();
    if (pendingTx.status === 'pending') {
      console.log(
        `Success! Deploy transaction sent. Pending inclusion: ${pendingTx.hash}`
      );
    }
    console.log('Waiting for transaction inclusion in a block.');
    await pendingTx.wait({ maxAttempts: 90 });
    console.log('');

    // Log public keys
    console.log('\nDeployed Contract Public Keys:');
    console.log(
      `ZKUSDOrchestrator: ${zkUSDOrchestratorKeyPair.publicKey.toBase58()}`
    );
    console.log(`ZKUSDAdmin: ${zkUSDAdminKeyPair.publicKey.toBase58()}`);
    console.log(`ZKUSDToken: ${zkUSDTokenKeyPair.publicKey.toBase58()}`);
    console.log(`Oracle: ${oracleKeyPair.publicKey.toBase58()}`);
  } catch (error) {
    console.error('An error occurred during deployment:');
    console.error(error);
  }
}

// Run the main function
main().catch((error) => {
  console.error('An unexpected error occurred:');
  console.error(error);
  process.exit(1);
});
