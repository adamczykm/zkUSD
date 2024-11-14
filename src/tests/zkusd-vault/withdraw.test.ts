import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Field, UInt64 } from 'o1js';
import { ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Withdraw Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie']);

    //deploy alice's vault
    await testHelper.deployVaults(['alice']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_100_MINA,
        testHelper.agents.alice.secret
      );
    });

    //Alice mints 5 zkUSD
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        TestAmounts.DEBT_5_ZKUSD,
        testHelper.agents.alice.secret
      );
    });
  });
  it('should allow alice to withdraw zkUsd', async () => {
    //We need to sign this one with the vault private key

    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
        await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
          TestAmounts.DEBT_1_ZKUSD,
          testHelper.agents.alice.secret
        );
      },
      {
        extraSigners: [testHelper.agents.alice.vault!.privateKey],
      }
    );

    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );

    const debtAmount = testHelper.agents.alice.vault?.contract.debtAmount.get();

    expect(aliceBalance).toEqual(TestAmounts.DEBT_1_ZKUSD);
    expect(vaultBalance).toEqual(
      TestAmounts.DEBT_5_ZKUSD.sub(TestAmounts.DEBT_1_ZKUSD)
    );
    expect(debtAmount).toEqual(TestAmounts.DEBT_5_ZKUSD); // Debt should remain the same
  });

  it('should fail if we dont sign with the vault private key', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
          TestAmounts.DEBT_1_ZKUSD,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });

  it('should fail if withdrawal amount is greater than vault balance', async () => {
    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );

    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
            vaultBalance.add(1),
            testHelper.agents.alice.secret
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      )
    ).rejects.toThrow(ZkUsdVaultErrors.INSUFFICIENT_BALANCE);
  });

  it('should fail if withdrawal amount is zero', async () => {
    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
            TestAmounts.ZERO,
            testHelper.agents.alice.secret
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      )
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
  });

  it('should fail if secret is incorrect', async () => {
    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
            TestAmounts.DEBT_1_ZKUSD,
            Field.random()
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      )
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_SECRET);
  });

  it('should allow bob to withdraw if he has the correct secret and vault key', async () => {
    const debtAmountBefore =
      testHelper.agents.alice.vault?.contract.debtAmount.get();
    const vaultBalanceBefore = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );

    await testHelper.transaction(
      testHelper.agents.bob.account,
      async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.bob.account, 1);
        await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
          TestAmounts.DEBT_1_ZKUSD,
          testHelper.agents.alice.secret
        );
      },
      {
        extraSigners: [testHelper.agents.alice.vault!.privateKey],
      }
    );

    const debtAmount = testHelper.agents.alice.vault?.contract.debtAmount.get();
    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );
    const bobBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.bob.account
    );

    expect(debtAmount).toEqual(debtAmountBefore);
    expect(vaultBalance).toEqual(
      vaultBalanceBefore.sub(TestAmounts.DEBT_1_ZKUSD)
    );
    expect(bobBalance).toEqual(TestAmounts.DEBT_1_ZKUSD);
  });

  it('should fail if withdrawal amount is negative', async () => {
    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
            UInt64.from(-1),
            testHelper.agents.alice.secret
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      )
    ).rejects.toThrow();
  });

  it('should allow multiple partial withdrawals up to the vault balance', async () => {
    const aliceBalanceBefore = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    // First withdrawal
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
          TestAmounts.DEBT_10_CENT_ZKUSD,
          testHelper.agents.alice.secret
        );
      },
      {
        extraSigners: [testHelper.agents.alice.vault!.privateKey],
      }
    );

    // Second withdrawal
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
          TestAmounts.DEBT_10_CENT_ZKUSD,
          testHelper.agents.alice.secret
        );
      },
      {
        extraSigners: [testHelper.agents.alice.vault!.privateKey],
      }
    );

    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    expect(aliceBalance).toEqual(
      aliceBalanceBefore.add(TestAmounts.DEBT_10_CENT_ZKUSD.mul(2))
    );
  });

  it('should fail if trying to withdraw to an unfunded account', async () => {
    await expect(
      testHelper.transaction(
        testHelper.agents.charlie.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
            TestAmounts.DEBT_1_ZKUSD,
            testHelper.agents.alice.secret
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      )
    ).rejects.toThrow();
  });

  it('should maintain correct vault state after multiple withdrawals', async () => {
    const initialVaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );
    const initialDebtAmount =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    // Perform multiple withdrawals
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
            TestAmounts.DEBT_10_CENT_ZKUSD,
            testHelper.agents.alice.secret
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      );
    }

    const finalVaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );
    const finalDebtAmount =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    // Vault balance should decrease by total withdrawn amount
    expect(finalVaultBalance).toEqual(
      initialVaultBalance.sub(TestAmounts.DEBT_10_CENT_ZKUSD.mul(3))
    );
    // Debt amount should remain unchanged
    expect(finalDebtAmount).toEqual(initialDebtAmount);
  });
});
