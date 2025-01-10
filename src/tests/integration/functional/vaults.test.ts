import { deploy } from '../../../deploy.js';
import { MinaChain } from '../../../mina.js';
import { TestHelper } from '../../test-helper.js';

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { PrivateKey } from 'o1js';
import { transaction } from '../../../utils/transaction.js';

// before(async () => {
//   await MinaChain.initLightnet();
//   const deployer = await MinaChain.newAccount()
//   await deploy(MinaChain, deployer);
// });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// describe('zkUSD Lightnet - Functional Integration Test Suite', () => {
//   const testHelper = new TestHelper();

//   before(async () => {
//     await testHelper.initLightnetChain();
//     // await testHelper.deployTokenContracts();
//     // await testHelper.createAgents(['alice', 'bob', 'charlie', 'david', 'eve']);
//   });

//   it('should create vaults', async () => {

//     await testHelper.createAgents(['alice']);
//     const alice = testHelper.agents.alice;

//     const privateKey = PrivateKey.random();
//     // const publickKey = privateKey.toPublicKey();

//     let i = 0;
//     let a = [];
//     console.log('alice: ', alice.keys.publicKey.toBase58());
//     while (true) {
//       await sleep(3333);
//       const sentTx = await transaction(alice.keys, async () => {
//       },
//         {
//           nonce: i,
//         fee: 10*testHelper.chain.fee+i
//         });
//       a.push(sentTx);
//       i++;
//       break;
//     }

//     // wait for all transactions to be included
//     const txResults = await Promise.all(a.map(async (tx) => {
//       return await tx.wait();
//     }));

//     for (const txResult of txResults) {
//       if (txResult.status !== 'included') {
//         console.log('Transaction failed with status', txResult.toPretty());
//       }
//       else {
//         console.log(txResult.toPretty());
//       }
//     }

//   });
// });


describe('zkUSD Lightnet - Functional Integration Test Suite', () => {
  const testHelper = new TestHelper();

  before(async () => {
    await testHelper.initLightnetChain();
    await testHelper.deployTokenContracts();
    await testHelper.createAgents(['alice', 'bob', 'charlie', 'david', 'eve']);
  });

  it('should create vaults', async () => {
    await testHelper.createVaults(['alice']);

    const aliceVault = testHelper.chain.getAccount(
      testHelper.agents.alice.vault?.publicKey!,
      testHelper.engine.contract.deriveTokenId()
    );

    assert.notStrictEqual(aliceVault, null);
  });
});
