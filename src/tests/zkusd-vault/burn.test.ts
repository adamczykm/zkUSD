import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Field, UInt64 } from 'o1js';
import { ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Burn Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie']);

    //deploy alice's vault
    await testHelper.deployVaults(['alice']);

    // Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_100_MINA,
        testHelper.agents.alice.secret
      );
    });

    // Alice mint 30 zkUSD
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        testHelper.agents.alice.account,
        TestAmounts.DEBT_30_ZKUSD,
        testHelper.agents.alice.secret
      );
    });
  });

  it('should allow alice to burn zkUSD', async () => {
    const aliceStartingBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const vaultStartingDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.burnZkUsd(
        TestAmounts.DEBT_1_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    const vaultFinalDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    const aliceFinalBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    expect(vaultFinalDebt).toEqual(
      vaultStartingDebt?.sub(TestAmounts.DEBT_1_ZKUSD)
    );
    expect(aliceFinalBalance).toEqual(
      aliceStartingBalance.sub(TestAmounts.DEBT_1_ZKUSD)
    );
  });

  it('should fail if burn amount is zero', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.burnZkUsd(
          TestAmounts.ZERO,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
  });

  it('should fail if secret is incorrect', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.burnZkUsd(
          TestAmounts.DEBT_1_ZKUSD,
          Field.random()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_SECRET);
  });

  it('should fail if burn amount exceeds debt', async () => {
    const currentDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.burnZkUsd(
          currentDebt!.add(1),
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_EXCEEDS_DEBT);
  });

  it('should fail if burn amount is negative', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.burnZkUsd(
          UInt64.from(-1),
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });

  it('should allow bob to burn if he has the correct secret', async () => {
    const startingDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    // First transfer some zkUSD to Bob
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.token.contract.transfer(
        testHelper.agents.alice.account,
        testHelper.agents.bob.account,
        TestAmounts.DEBT_1_ZKUSD
      );
    });

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.alice.vault?.contract.burnZkUsd(
        TestAmounts.DEBT_1_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    const finalDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    expect(finalDebt).toEqual(startingDebt?.sub(TestAmounts.DEBT_1_ZKUSD));
  });

  it('should track debt correctly after multiple burns', async () => {
    const initialDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    // Perform multiple small burns
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.burnZkUsd(
            TestAmounts.DEBT_10_CENT_ZKUSD,
            testHelper.agents.alice.secret
          );
        }
      );
    }

    const finalDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    expect(finalDebt).toEqual(
      initialDebt?.sub(TestAmounts.DEBT_10_CENT_ZKUSD.mul(3))
    );
  });

  it('should fail if trying to burn without sufficient zkUSD balance', async () => {
    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    //Alice transfers all her zkUSD to Bob
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.token.contract.transfer(
        testHelper.agents.alice.account,
        testHelper.agents.bob.account,
        aliceBalance
      );
    });

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.burnZkUsd(
          TestAmounts.DEBT_10_CENT_ZKUSD,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });
});
