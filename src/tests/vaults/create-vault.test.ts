import {
  AccountUpdate,
  fetchEvents,
  Field,
  Mina,
  PublicKey,
  TokenId,
  UInt64,
} from 'o1js';
import { NewVaultEvent, ZkUsdEngineErrors } from '../../zkusd-engine';
import { ZkUsdVault } from '../../zkusd-vault';
import { TestHelper, TestAmounts } from '../test-helper';

describe('zkUSD Deployment Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
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

    expect(aliceVault).not.toBeNull();
  });

  it('should emit the NewVault event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('NewVault');
    // @ts-ignore
    expect(latestEvent.event.data.vaultAddress).toEqual(
      testHelper.agents.alice.vault?.publicKey
    );
  });

  it('should fail to deploy the same vault twice', async () => {
    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.createVault(
            testHelper.agents.alice.vault!.publicKey
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      )
    ).rejects.toThrow(ZkUsdEngineErrors.VAULT_EXISTS);
  });

  it('should create a new vault vault with empty state', async () => {
    const aliceVault = testHelper.agents.alice.vault;

    const collateralAmount =
      await aliceVault?.contract.collateralAmount.fetch();
    const debtAmount = await aliceVault?.contract.debtAmount.fetch();

    expect(collateralAmount).toEqual(TestAmounts.ZERO);
    expect(debtAmount).toEqual(TestAmounts.ZERO);
  });

  it('should create a new vault vault with the correct owner', async () => {
    const aliceVault = testHelper.agents.alice.vault;

    const owner = await aliceVault?.contract.owner.fetch();

    expect(owner?.toBase58()).toEqual(
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

    expect(bobVault).not.toBeNull();
    expect(charlieVault).not.toBeNull();
    expect(davidVault).not.toBeNull();
    expect(eveVault).not.toBeNull();
  });
});
