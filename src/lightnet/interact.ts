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
  Lightnet,
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
import { KeyManager } from '../utils/KeyManager.js';

const fee = 1e8;
const networkType = 'lightnet';

const network = await Mina.Network({
  mina: 'http://127.0.0.1:8080/graphql',
  archive: 'http://127.0.0.1:8282',
  lightnetAccountManager: 'http://127.0.0.1:8181',
});

Mina.setActiveInstance(network);

const keyManager = new KeyManager(networkType);

const zkUSDOrchestratorKeys = keyManager.readKeys('zkUSDOrchestrator');
const zkUSDAdminKeys = keyManager.readKeys('zkUSDAdmin');
const zkUSDTokenKeys = keyManager.readKeys('zkUSDToken');
const oracleKeys = keyManager.readKeys('oracle');

if (
  !zkUSDOrchestratorKeys ||
  !zkUSDAdminKeys ||
  !zkUSDTokenKeys ||
  !oracleKeys
) {
  throw new Error(
    'One or more required key pairs are missing. Please run the deploy script first.'
  );
}

const zkUSDOrchestratorContract = new ZKUSDOrchestrator(
  zkUSDOrchestratorKeys.publicKey
);
const zkUSDAdminContract = new ZKUSDAdmin(zkUSDAdminKeys.publicKey);
const zkUSDTokenContract = new FungibleToken(zkUSDTokenKeys.publicKey);
const oracle = new Oracle(oracleKeys.privateKey);

// alice setup
const alicePrivateKey = (await Lightnet.acquireKeyPair()).privateKey;
const aliceAccount = alicePrivateKey.toPublicKey();

console.log('Alice account:', aliceAccount.toBase58());
console.log(
  'ZKUSDOrchestrator address:',
  zkUSDOrchestratorKeys.publicKey.toBase58()
);
console.log('ZKUSDAdmin address:', zkUSDAdminKeys.publicKey.toBase58());
console.log('ZKUSDToken address:', zkUSDTokenKeys.publicKey.toBase58());
console.log('Oracle address:', oracleKeys.publicKey.toBase58());
