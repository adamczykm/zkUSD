import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Mina, Permissions, UInt64 } from 'o1js';
import { ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Liquidation Test Suite', () => {
  const proofsEnabled = false;
  const testHelper = new TestHelper(proofsEnabled);

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie']);

    //Deploy a fresh vault
    await testHelper.deployVaults(['alice', 'bob']);

    // Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.LARGE_COLLATERAL,
        testHelper.agents.alice.secret
      );
    });

    // Bob deposits 900 Mina
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.bob.vault?.contract.depositCollateral(
        TestAmounts.EXTRA_LARGE_COLLATERAL,
        testHelper.agents.bob.secret
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

    //Bob mint 100 zkUSD
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.bob.account, 1);
      await testHelper.agents.bob.vault?.contract.mintZkUsd(
        TestAmounts.EXTRA_LARGE_ZKUSD,
        testHelper.agents.bob.secret,
        testHelper.oracle.getSignedPrice()
      );
    });

    //Alice withdraws 30 zkUSD
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

    //Bob withdraws 100 zkUSD
    await testHelper.transaction(
      testHelper.agents.bob.account,
      async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.bob.account, 1);
        await testHelper.agents.bob.vault?.contract.withdrawZkUsd(
          TestAmounts.EXTRA_LARGE_ZKUSD,
          testHelper.agents.bob.secret
        );
      },
      {
        extraSigners: [testHelper.agents.bob.vault!.privateKey],
      }
    );
  });

  it('should fail if vault is sufficiently collateralized', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.agents.alice.vault?.contract.liquidate(
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.HEALTH_FACTOR_TOO_HIGH);
  });

  it('should fail liquidation if liquidator does not have sufficent zkUsd', async () => {
    //Price drops to 0.25
    testHelper.oracle.setPrice(new UInt64(0.25e9));

    //Bob transfers 1 zkUSD to Charlie
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.bob.account, 1);
      await testHelper.token.contract.transfer(
        testHelper.agents.bob.account,
        testHelper.agents.charlie.account,
        TestAmounts.SMALL_ZKUSD
      );
    });

    await expect(
      testHelper.transaction(testHelper.agents.charlie.account, async () => {
        await testHelper.agents.alice.vault?.contract.liquidate(
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow();
  });

  it('should fail liquidation if liquidator does not have receive permissions', async () => {
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      let au = AccountUpdate.create(testHelper.agents.bob.account);
      let permissions = Permissions.default();
      permissions.receive = Permissions.impossible();
      au.account.permissions.set(permissions);
      AccountUpdate.attachToTransaction(au);
      au.requireSignature();
    });

    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.agents.alice.vault?.contract.liquidate(
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow();
  });

  it('should allow liquidation of vault if it is undercollateralized', async () => {
    //Reset bobs permissions
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      let au = AccountUpdate.create(testHelper.agents.bob.account);
      let permissions = Permissions.default();
      au.account.permissions.set(permissions);
      AccountUpdate.attachToTransaction(au);
      au.requireSignature();
    });

    //Price drops to 0.25
    testHelper.oracle.setPrice(new UInt64(0.25e9));

    //Alice's position is now undercollateralized
    //Compare preliquidation balances to postliquidation balances

    const aliceVaultCollateralPreLiq =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    const aliceVaultDebtPreLiq =
      testHelper.agents.alice.vault?.contract.debtAmount.get();
    const bobZkUsdBalancePreLiq = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.bob.account
    );
    const bobMinaBalancePreLiq = Mina.getBalance(testHelper.agents.bob.account);
    const aliceZkUsdBalancePreLiq =
      await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
    const aliceMinaBalancePreLiq = Mina.getBalance(
      testHelper.agents.alice.account
    );

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.alice.vault?.contract.liquidate(
        testHelper.oracle.getSignedPrice()
      );
    });

    const aliceVaultCollateralPostLiq =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    const aliceVaultDebtPostLiq =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    const bobZkUsdBalancePostLiq = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.bob.account
    );
    const bobMinaBalancePostLiq = Mina.getBalance(
      testHelper.agents.bob.account
    );
    const aliceZkUsdBalancePostLiq =
      await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
    const aliceMinaBalancePostLiq = Mina.getBalance(
      testHelper.agents.alice.account
    );

    expect(aliceVaultCollateralPostLiq).toEqual(TestAmounts.ZERO);
    expect(aliceVaultDebtPostLiq).toEqual(TestAmounts.ZERO);
    expect(bobZkUsdBalancePostLiq).toEqual(
      bobZkUsdBalancePreLiq.sub(aliceVaultDebtPreLiq!)
    );
    expect(bobMinaBalancePostLiq).toEqual(
      bobMinaBalancePreLiq.add(aliceVaultCollateralPreLiq!)
    );
    expect(aliceZkUsdBalancePostLiq).toEqual(aliceZkUsdBalancePreLiq);
    expect(aliceMinaBalancePostLiq).toEqual(aliceMinaBalancePreLiq);
  });
});
