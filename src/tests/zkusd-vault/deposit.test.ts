import { TestHelper, TestAmounts } from '../test-helper';
import { Field, Mina, UInt64 } from 'o1js';
import { ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Deposit Test Suite', () => {
  const proofsEnabled = false;
  const testHelper = new TestHelper(proofsEnabled);

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);

    //deploy alice's vault
    await testHelper.deployVaults(['alice']);
  });

  it('should allow deposits', async () => {
    const aliceBalanceBeforeDeposit = Mina.getBalance(
      testHelper.agents.alice.account
    );

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.LARGE_COLLATERAL,
        testHelper.agents.alice.secret
      );
    });

    const aliceVault = testHelper.agents.alice.vault;

    const collateralAmount = aliceVault?.contract.collateralAmount.get();
    const debtAmount = aliceVault?.contract.debtAmount.get();

    const aliceBalanceAfterDeposit = Mina.getBalance(
      testHelper.agents.alice.account
    );

    expect(collateralAmount).toEqual(TestAmounts.LARGE_COLLATERAL);
    expect(debtAmount).toEqual(TestAmounts.ZERO);
    expect(aliceBalanceAfterDeposit).toEqual(
      aliceBalanceBeforeDeposit.sub(TestAmounts.LARGE_COLLATERAL)
    );
  });

  it('should fail if deposit amount is 0', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.depositCollateral(
          TestAmounts.ZERO,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
  });

  it('should fail if deposit amount is greater than balance', async () => {
    const aliceBalance = Mina.getBalance(testHelper.agents.alice.account);

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.depositCollateral(
          aliceBalance.add(1),
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });

  it('should fail if deposit amount is negative', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.depositCollateral(
          UInt64.from(-1),
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });

  it('should fail if secret is incorrect', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.depositCollateral(
          TestAmounts.LARGE_COLLATERAL,
          Field.random()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_SECRET);
  });

  it('should allow bob to deposit if he has the correct secret', async () => {
    const aliceVault = testHelper.agents.alice.vault;

    const initialCollateralAmount = aliceVault?.contract.collateralAmount.get();

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.LARGE_COLLATERAL,
        testHelper.agents.alice.secret
      );
    });

    const collateralAmount = aliceVault?.contract.collateralAmount.get();
    const debtAmount = aliceVault?.contract.debtAmount.get();

    expect(collateralAmount).toEqual(
      initialCollateralAmount?.add(TestAmounts.LARGE_COLLATERAL)
    );
    expect(debtAmount).toEqual(TestAmounts.ZERO);
  });

  it('should track total deposits correctly across multiple transactions', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();

    // Make multiple deposits
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.depositCollateral(
            TestAmounts.SMALL_COLLATERAL,
            testHelper.agents.alice.secret
          );
        }
      );
    }

    const finalCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    expect(finalCollateral).toEqual(
      initialCollateral?.add(TestAmounts.SMALL_COLLATERAL.mul(3))
    );
  });

  it('should allow deposits from multiple accounts to the same vault', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();

    for (const agent of Object.values(testHelper.agents)) {
      await testHelper.transaction(agent.account, async () => {
        await testHelper.agents.alice.vault?.contract.depositCollateral(
          TestAmounts.SMALL_COLLATERAL,
          testHelper.agents.alice.secret
        );
      });
    }

    const finalCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    expect(finalCollateral).toEqual(
      initialCollateral?.add(
        TestAmounts.SMALL_COLLATERAL.mul(Object.keys(testHelper.agents).length)
      )
    );
  });

  it('should fail when trying to deposit with insufficient balance', async () => {
    const aliceBalance = Mina.getBalance(testHelper.agents.alice.account);

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.depositCollateral(
          aliceBalance.add(1), // Trying to deposit entire balance
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });
});
