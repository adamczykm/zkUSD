import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Mina, Permissions, UInt64 } from 'o1js';
import { ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault';
import { ZkUsdPriceFeedOracleErrors } from '../../zkusd-price-feed-oracle';

describe('zkUSD Vault Liquidation Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie', 'rewards']);

    //Deploy a fresh vault
    await testHelper.deployVaults(['alice', 'bob']);

    // Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_100_MINA,
        testHelper.agents.alice.secret
      );
    });

    // Bob deposits 900 Mina
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.bob.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_900_MINA,
        testHelper.agents.bob.secret
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

    //Bob mint 100 zkUSD
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.bob.account, 1);
      await testHelper.agents.bob.vault?.contract.mintZkUsd(
        testHelper.agents.bob.account,
        TestAmounts.DEBT_100_ZKUSD,
        testHelper.agents.bob.secret
      );
    });
  });

  it('should fail if vault is sufficiently collateralized', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.agents.alice.vault?.contract.liquidate();
      })
    ).rejects.toThrow(ZkUsdVaultErrors.HEALTH_FACTOR_TOO_HIGH);
  });

  it('should fail liquidation if liquidator does not have sufficent zkUsd', async () => {
    //Price drops to 0.25
    await testHelper.updateOraclePrice(TestAmounts.PRICE_25_CENT);

    //Bob transfers 1 zkUSD to Charlie
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.bob.account, 1);
      await testHelper.token.contract.transfer(
        testHelper.agents.bob.account,
        testHelper.agents.charlie.account,
        TestAmounts.DEBT_1_ZKUSD
      );
    });

    await expect(
      testHelper.transaction(testHelper.agents.charlie.account, async () => {
        await testHelper.agents.alice.vault?.contract.liquidate();
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
        await testHelper.agents.alice.vault?.contract.liquidate();
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

    //Alice's position is now undercollateralized
    //Compare preliquidation balances to postliquidation balances

    const aliceVaultCollateralPreLiq =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();
    const aliceVaultDebtPreLiq =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
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
      await testHelper.agents.alice.vault?.contract.liquidate();
    });

    const aliceVaultCollateralPostLiq =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();
    const aliceVaultDebtPostLiq =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

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

  it('should let the user redeem rewards after liquidation', async () => {
    await testHelper.sendRewardsToVault('alice', TestAmounts.COLLATERAL_1_MINA);

    const aliceMinaBalanceBefore = Mina.getBalance(
      testHelper.agents.alice.account
    );

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.redeemCollateral(
        TestAmounts.ZERO,
        testHelper.agents.alice.secret
      );
    });

    const currentProtocolFee =
      await testHelper.protocolVault.contract.getProtocolFee();

    const protocolFee = TestAmounts.COLLATERAL_1_MINA.mul(
      currentProtocolFee
    ).div(ZkUsdVault.PROTOCOL_FEE_PRECISION);

    const aliceMinaBalanceAfter = Mina.getBalance(
      testHelper.agents.alice.account
    );

    // Calculate expected rewards
    const expectedRewards = TestAmounts.COLLATERAL_1_MINA.sub(protocolFee);

    expect(aliceMinaBalanceAfter).toEqual(
      aliceMinaBalanceBefore.add(expectedRewards)
    );
  });

  it('Should fail if the price feed is in emergency mode', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.agents.alice.vault?.contract.liquidate();
      })
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.EMERGENCY_HALT);
  });

  it('Should allow liquidation if the price feed is resumed', async () => {
    await testHelper.resumeTheProtocol();

    // Drop price to make vault eligible for liquidation
    await testHelper.updateOraclePrice(TestAmounts.PRICE_2_USD);

    // Set up Alice's vault with collateral and debt
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_1_MINA,
        testHelper.agents.alice.secret
      );
    });

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        testHelper.agents.alice.account,
        TestAmounts.DEBT_50_CENT_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    // Drop price to make vault eligible for liquidation
    await testHelper.updateOraclePrice(TestAmounts.PRICE_25_CENT);

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.alice.vault?.contract.liquidate();
    });
  });
});
