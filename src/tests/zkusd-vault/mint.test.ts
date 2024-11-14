import { TestHelper, TestAmounts } from '../test-helper';
import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  Signature,
  UInt32,
  UInt64,
} from 'o1js';
import { OraclePayload, ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Mint Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);

    //deploy alice's vault
    await testHelper.deployVaults(['alice']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_100_MINA,
        testHelper.agents.alice.secret
      );
    });
  });

  it('should allow alice to mint zkUSD', async () => {
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        TestAmounts.DEBT_5_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    const aliceVault = testHelper.agents.alice.vault;
    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      aliceVault!.publicKey
    );
    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const debtAmount = testHelper.agents.alice.vault?.contract.debtAmount.get();

    expect(vaultBalance).toEqual(TestAmounts.DEBT_5_ZKUSD);
    expect(debtAmount).toEqual(TestAmounts.DEBT_5_ZKUSD);
    expect(aliceBalance).toEqual(TestAmounts.ZERO);
  });

  it('should track total debt correctly across multiple mint operations', async () => {
    const initialDebt =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    // Perform multiple small mints
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.mintZkUsd(
            TestAmounts.DEBT_1_ZKUSD,
            testHelper.agents.alice.secret
          );
        }
      );
    }

    const finalDebt = testHelper.agents.alice.vault?.contract.debtAmount.get();
    expect(finalDebt).toEqual(
      initialDebt?.add(TestAmounts.DEBT_1_ZKUSD.mul(3))
    );
  });

  it('should fail if mint amount is zero', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          TestAmounts.ZERO,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
  });

  it('should fail if mint amount is negative', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          UInt64.from(-1),
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });

  it('should fail if secret is invalid', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          TestAmounts.DEBT_5_ZKUSD,
          Field.random()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_SECRET);
  });

  it('should fail if health factor is too low', async () => {
    const LARGE_ZKUSD_AMOUNT = UInt64.from(1000e9); // Very large amount to ensure health factor violation

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          LARGE_ZKUSD_AMOUNT,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW);
  });

  it('should maintain correct health factor after multiple mint operations', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    let currentDebt = testHelper.agents.alice.vault?.contract.debtAmount.get();

    // Mint multiple times while checking health factor
    for (let i = 0; i < 3; i++) {
      const healthFactor =
        testHelper.agents.alice.vault?.contract.calculateHealthFactor(
          initialCollateral!,
          currentDebt!.add(TestAmounts.DEBT_1_ZKUSD),
          await testHelper.priceFeedOracle.contract.getPrice()
        );

      // Only mint if health factor would remain above minimum
      if (healthFactor!.greaterThanOrEqual(ZkUsdVault.MIN_HEALTH_FACTOR)) {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.agents.alice.vault?.contract.mintZkUsd(
              TestAmounts.DEBT_1_ZKUSD,
              testHelper.agents.alice.secret
            );
          }
        );
        currentDebt = currentDebt?.add(TestAmounts.DEBT_1_ZKUSD);
      }
    }

    const finalHealthFactor =
      testHelper.agents.alice.vault?.contract.calculateHealthFactor(
        initialCollateral!,
        currentDebt!,
        await testHelper.priceFeedOracle.contract.getPrice()
      );

    expect(
      finalHealthFactor!.greaterThanOrEqual(ZkUsdVault.MIN_HEALTH_FACTOR)
    ).toBeTruthy();
  });

  it('should allow bob to mint if he has the correct secret', async () => {
    const debtAmountBefore =
      testHelper.agents.alice.vault?.contract.debtAmount.get();
    const vaultBalanceBefore = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        TestAmounts.DEBT_5_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    const debtAmount = testHelper.agents.alice.vault?.contract.debtAmount.get();
    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );

    expect(debtAmount).toEqual(debtAmountBefore?.add(TestAmounts.DEBT_5_ZKUSD));
    expect(vaultBalance).toEqual(
      vaultBalanceBefore.add(TestAmounts.DEBT_5_ZKUSD)
    );
  });
});
