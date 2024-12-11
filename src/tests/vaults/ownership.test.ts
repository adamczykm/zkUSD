import { TestHelper, TestAmounts } from '../test-helper.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { Account, AccountUpdate } from 'o1js';

describe('zkUSD Vault Ownership Test Suite', () => {
  const testHelper = new TestHelper();

  before(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie']);
    await testHelper.createVaults(['alice']);

    // Alice deposits initial collateral
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_100_MINA
      );
    });

    // Alice mints some zkUSD
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_5_ZKUSD
      );
    });
  });

  it('should allow the owner to transfer ownership', async () => {
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.engine.contract.updateVaultOwner(
        testHelper.agents.alice.vault!.publicKey,
        testHelper.agents.bob.account
      );
    });

    // Verify the new owner is set correctly
    const vaultOwner =
      await testHelper.agents.alice.vault?.contract.owner.fetch();
    assert.deepStrictEqual(
      vaultOwner?.toBase58(),
      testHelper.agents.bob.account.toBase58()
    );
  });

  it('should emit the VaultOwnerUpdated event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    assert.strictEqual(latestEvent.type, 'VaultOwnerUpdated');
    assert.deepStrictEqual(
      // @ts-ignore
      latestEvent.event.data.vaultAddress,
      testHelper.agents.alice.vault?.publicKey
    );
    assert.deepStrictEqual(
      // @ts-ignore
      latestEvent.event.data.previousOwner.toBase58(),
      testHelper.agents.alice.account.toBase58()
    );
    assert.deepStrictEqual(
      // @ts-ignore
      latestEvent.event.data.newOwner.toBase58(),
      testHelper.agents.bob.account.toBase58()
    );
  });

  it('should allow the new owner to perform vault operations', async () => {
    // Bob (new owner) should be able to deposit collateral
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_50_MINA
      );
    });

    // Bob should be able to mint zkUSD
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_5_ZKUSD
      );
    });

    const collateralAmount =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();
    const debtAmount =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    assert.deepStrictEqual(
      collateralAmount,
      TestAmounts.COLLATERAL_100_MINA.add(TestAmounts.COLLATERAL_50_MINA)
    );
    assert.deepStrictEqual(
      debtAmount,
      TestAmounts.DEBT_5_ZKUSD.add(TestAmounts.DEBT_5_ZKUSD)
    );
  });

  it('should prevent the previous owner from performing vault operations', async () => {
    // Alice (previous owner) should not be able to deposit collateral
    await assert.rejects(
      async () => {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.engine.contract.depositCollateral(
              testHelper.agents.alice.vault!.publicKey,
              TestAmounts.COLLATERAL_50_MINA
            );
          }
        );
      },
      (err: any) => {
        assert.match(err.message, /Field.assertEquals()/i);
        return true;
      }
    );

    // Alice should not be able to mint zkUSD
    await assert.rejects(
      async () => {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.engine.contract.mintZkUsd(
              testHelper.agents.alice.vault!.publicKey,
              TestAmounts.DEBT_5_ZKUSD
            );
          }
        );
      },
      (err: any) => {
        assert.match(err.message, /Field.assertEquals()/i);
        return true;
      }
    );
  });

  it('should prevent non-owners from transferring ownership', async () => {
    // Charlie (never an owner) should not be able to transfer ownership
    await assert.rejects(
      async () => {
        await testHelper.transaction(
          testHelper.agents.charlie.account,
          async () => {
            await testHelper.engine.contract.updateVaultOwner(
              testHelper.agents.alice.vault!.publicKey,
              testHelper.agents.charlie.account
            );
          }
        );
      },
      (err: any) => {
        assert.match(err.message, /Field.assertEquals()/i);
        return true;
      }
    );

    // Alice (previous owner) should not be able to transfer ownership
    await assert.rejects(
      async () => {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.engine.contract.updateVaultOwner(
              testHelper.agents.alice.vault!.publicKey,
              testHelper.agents.alice.account
            );
          }
        );
      },
      (err: any) => {
        assert.match(err.message, /Field.assertEquals()/i);
        return true;
      }
    );
  });

  it('should allow multiple ownership transfers', async () => {
    // Bob transfers ownership to Charlie
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.bob.account, 1);
      await testHelper.engine.contract.updateVaultOwner(
        testHelper.agents.alice.vault!.publicKey,
        testHelper.agents.charlie.account
      );
    });

    // Verify Charlie is the new owner
    let vaultOwner =
      await testHelper.agents.alice.vault?.contract.owner.fetch();
    assert.deepStrictEqual(
      vaultOwner?.toBase58(),
      testHelper.agents.charlie.account.toBase58()
    );

    // Charlie transfers ownership back to Alice
    await testHelper.transaction(
      testHelper.agents.charlie.account,
      async () => {
        await testHelper.engine.contract.updateVaultOwner(
          testHelper.agents.alice.vault!.publicKey,
          testHelper.agents.alice.account
        );
      }
    );

    // Verify Alice is the owner again
    vaultOwner = await testHelper.agents.alice.vault?.contract.owner.fetch();
    assert.deepStrictEqual(
      vaultOwner?.toBase58(),
      testHelper.agents.alice.account.toBase58()
    );
  });
});
