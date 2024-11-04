import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Field, UInt64 } from 'o1js';
import { ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Burn Test Suite', () => {
  const proofsEnabled = false;
  const testHelper = new TestHelper(proofsEnabled);

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie']);

    //deploy alice's vault
    await testHelper.deployVaults(['alice']);

    // Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.LARGE_COLLATERAL,
        testHelper.agents.alice.secret
      );
    });

    // Alice mint 30 zkUSD
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        TestAmounts.LARGE_ZKUSD,
        testHelper.agents.alice.secret,
        testHelper.oracle.getSignedPrice()
      );
    });

    // Withdraw zkUSD to Alice's account for burning
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
        await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
          TestAmounts.LARGE_ZKUSD,
          testHelper.agents.alice.secret
        );
      },
      {
        extraSigners: [testHelper.agents.alice.vault!.privateKey],
      }
    );
  });

  it('should allow alice to burn zkUSD', async () => {
    const aliceStartingBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const vaultStartingDebt =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.burnZkUsd(
        TestAmounts.SMALL_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    const vaultFinalDebt =
      testHelper.agents.alice.vault?.contract.debtAmount.get();
    const aliceFinalBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    expect(vaultFinalDebt).toEqual(
      vaultStartingDebt?.sub(TestAmounts.SMALL_ZKUSD)
    );
    expect(aliceFinalBalance).toEqual(
      aliceStartingBalance.sub(TestAmounts.SMALL_ZKUSD)
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
          TestAmounts.SMALL_ZKUSD,
          Field.random()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_SECRET);
  });

  it('should fail if burn amount exceeds debt', async () => {
    const currentDebt =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

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
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    // First transfer some zkUSD to Bob
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.token.contract.transfer(
        testHelper.agents.alice.account,
        testHelper.agents.bob.account,
        TestAmounts.SMALL_ZKUSD
      );
    });

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.alice.vault?.contract.burnZkUsd(
        TestAmounts.SMALL_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    const finalDebt = testHelper.agents.alice.vault?.contract.debtAmount.get();
    expect(finalDebt).toEqual(startingDebt?.sub(TestAmounts.SMALL_ZKUSD));
  });

  it('should track debt correctly after multiple burns', async () => {
    const initialDebt =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    // Perform multiple small burns
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.burnZkUsd(
            TestAmounts.TINY_ZKUSD,
            testHelper.agents.alice.secret
          );
        }
      );
    }

    const finalDebt = testHelper.agents.alice.vault?.contract.debtAmount.get();
    expect(finalDebt).toEqual(initialDebt?.sub(TestAmounts.TINY_ZKUSD.mul(3)));
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
          TestAmounts.TINY_ZKUSD,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });
});
