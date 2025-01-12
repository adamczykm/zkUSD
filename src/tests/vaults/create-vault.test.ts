import {
  AccountUpdate,
  fetchEvents,
  Field,
  Mina,
  PublicKey,
  TokenId,
  UInt64,
} from 'o1js';
import { ZkUsdEngineErrors } from '../../zkusd-engine.js';
import { TestHelper, TestAmounts } from '../test-helper.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('zkUSD Deployment Test Suite', () => {
  const testHelper = new TestHelper();

  before(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie', 'david', 'eve']);

    const contractEvents = await testHelper.engine.contract.fetchEvents();
    console.log('Contract events after deployment', contractEvents);
  });

  it('should create vaults', async () => {
    await testHelper.createVaults(['alice']);

    const aliceVault = testHelper.Local.getAccount(
      testHelper.agents.alice.vault?.publicKey!,
      testHelper.engine.contract.deriveTokenId()
    );

    assert.notStrictEqual(aliceVault, null);
  });

  it('should emit the NewVault event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    assert.strictEqual(latestEvent.type, 'NewVault');
    assert.deepStrictEqual(
      // @ts-ignore
      latestEvent.event.data.vaultAddress,
      testHelper.agents.alice.vault?.publicKey
    );
  });

  it('should fail to deploy the same vault twice', async () => {
    await assert.rejects(async () => {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.createVault(
            testHelper.agents.alice.vault!.publicKey
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      );
    }, new RegExp(ZkUsdEngineErrors.VAULT_EXISTS));
  });

  it('should create a new vault vault with empty state', async () => {
    const aliceVault = testHelper.agents.alice.vault;

    const collateralAmount =
      await aliceVault?.contract.collateralAmount.fetch();
    const debtAmount = await aliceVault?.contract.debtAmount.fetch();

    assert.deepStrictEqual(collateralAmount, TestAmounts.ZERO);
    assert.deepStrictEqual(debtAmount, TestAmounts.ZERO);
  });

  it('should create a new vault vault with the correct owner', async () => {
    const aliceVault = testHelper.agents.alice.vault;

    const owner = await aliceVault?.contract.owner.fetch();

    assert.strictEqual(
      owner?.toBase58(),
      testHelper.agents.alice.account.toBase58()
    );
  });

  it('should create multiple vaults', async () => {
    await testHelper.createVaults(['bob', 'charlie', 'david', 'eve']);

    const bobVault = testHelper.Local.getAccount(
      testHelper.agents.bob.vault?.publicKey!,
      testHelper.engine.contract.deriveTokenId()
    );
    const charlieVault = testHelper.Local.getAccount(
      testHelper.agents.charlie.vault?.publicKey!,
      testHelper.engine.contract.deriveTokenId()
    );
    const davidVault = testHelper.Local.getAccount(
      testHelper.agents.david.vault?.publicKey!,
      testHelper.engine.contract.deriveTokenId()
    );
    const eveVault = testHelper.Local.getAccount(
      testHelper.agents.eve.vault?.publicKey!,
      testHelper.engine.contract.deriveTokenId()
    );

    assert.notStrictEqual(bobVault, null);
    assert.notStrictEqual(charlieVault, null);
    assert.notStrictEqual(davidVault, null);
    assert.notStrictEqual(eveVault, null);
  });
});
