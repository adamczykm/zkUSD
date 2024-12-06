import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Mina, Permissions, UInt64 } from 'o1js';
import { ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault';
import { ZkUsdEngine, ZkUsdEngineErrors } from '../../zkusd-engine';
import { ProtocolData } from '../../types';

describe('zkUSD Vault Liquidation Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie', 'dave', 'rewards']);

    //Deploy a fresh vault
    await testHelper.createVaults(['alice', 'bob', 'charlie', 'dave']);

    // Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_100_MINA
      );
    });

    // Bob deposits 900 Mina
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.bob.vault!.publicKey,
        TestAmounts.COLLATERAL_900_MINA
      );
    });

    // Alice mint 30 zkUSD
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_30_ZKUSD
      );
    });

    //Bob mint 100 zkUSD
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.bob.vault!.publicKey,
        TestAmounts.DEBT_100_ZKUSD
      );
    });
  });

  it('should fail if vault is sufficiently collateralized', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.engine.contract.liquidate(
          testHelper.agents.alice.vault!.publicKey
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.HEALTH_FACTOR_TOO_HIGH);
  });

  it('should fail liquidation if liquidator does not have sufficent zkUsd', async () => {
    //Price drops to 0.25
    await testHelper.updateOraclePrice(TestAmounts.PRICE_25_CENT);

    //Bob transfers 1 zkUSD to Charlie
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.token.contract.transfer(
        testHelper.agents.bob.account,
        testHelper.agents.charlie.account,
        TestAmounts.DEBT_1_ZKUSD
      );
    });

    await expect(
      testHelper.transaction(testHelper.agents.charlie.account, async () => {
        await testHelper.engine.contract.liquidate(
          testHelper.agents.alice.vault!.publicKey
        );
      })
    ).rejects.toThrow(/Overflow/i);
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
        await testHelper.engine.contract.liquidate(
          testHelper.agents.alice.vault!.publicKey
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
      await testHelper.engine.contract.liquidate(
        testHelper.agents.alice.vault!.publicKey
      );
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

  it('should emit the Liquidate event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('Liquidate');
    // @ts-ignore
    expect(latestEvent.event.data.vaultAddress).toEqual(
      testHelper.agents.alice.vault?.publicKey
    );
    // @ts-ignore
    expect(latestEvent.event.data.liquidator.toBase58()).toEqual(
      testHelper.agents.bob.account.toBase58()
    );
    // @ts-ignore
    expect(latestEvent.event.data.vaultCollateralLiquidated).toEqual(
      TestAmounts.COLLATERAL_100_MINA
    );
    // @ts-ignore
    expect(latestEvent.event.data.vaultDebtRepaid).toEqual(
      TestAmounts.DEBT_30_ZKUSD
    );
    // @ts-ignore
    expect(latestEvent.event.data.price).toEqual(TestAmounts.PRICE_25_CENT);
  });

  it('Should fail if the price feed is in emergency mode', async () => {
    // Drop price to make vault eligible for liquidation
    await testHelper.updateOraclePrice(TestAmounts.PRICE_2_USD);

    // Set up Alice's vault with collateral and debt
    await testHelper.transaction(
      testHelper.agents.charlie.account,
      async () => {
        await testHelper.engine.contract.depositCollateral(
          testHelper.agents.charlie.vault!.publicKey,
          TestAmounts.COLLATERAL_1_MINA
        );
      }
    );

    await testHelper.transaction(
      testHelper.agents.charlie.account,
      async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.charlie.vault!.publicKey,
          TestAmounts.DEBT_50_CENT_ZKUSD
        );
      }
    );

    // Drop price to make vault eligible for liquidation
    await testHelper.updateOraclePrice(TestAmounts.PRICE_25_CENT);

    await testHelper.stopTheProtocol();

    const protocolDataPacked =
      await testHelper.engine.contract.protocolDataPacked.fetch();
    const protocolData = ProtocolData.unpack(protocolDataPacked!);
    console.log('Stopped', protocolData.emergencyStop.toString());

    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.engine.contract.liquidate(
          testHelper.agents.charlie.vault!.publicKey
        );
      })
    ).rejects.toThrow(ZkUsdEngineErrors.EMERGENCY_HALT);
  });

  it('Should allow liquidation if the price feed is resumed', async () => {
    await testHelper.resumeTheProtocol();

    // Drop price to make vault eligible for liquidation
    await testHelper.updateOraclePrice(TestAmounts.PRICE_2_USD);

    // Set up Alice's vault with collateral and debt
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_1_MINA
      );
    });

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_50_CENT_ZKUSD
      );
    });

    // Drop price to make vault eligible for liquidation
    await testHelper.updateOraclePrice(TestAmounts.PRICE_25_CENT);

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.liquidate(
        testHelper.agents.alice.vault!.publicKey
      );
    });
  });
});
