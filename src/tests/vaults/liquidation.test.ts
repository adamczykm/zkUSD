import { TestHelper, TestAmounts } from '../test-helper.js';
import { AccountUpdate, Mina, Permissions, UInt64 } from 'o1js';
import { ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault.js';
import { ZkUsdEngine, ZkUsdEngineErrors } from '../../zkusd-engine.js';
import { ProtocolData } from '../../types.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('zkUSD Vault Liquidation Test Suite', () => {
  const testHelper = new TestHelper();

  before(async () => {
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
    await assert.rejects(
      async () => {
        await testHelper.transaction(
          testHelper.agents.bob.account,
          async () => {
            await testHelper.engine.contract.liquidate(
              testHelper.agents.alice.vault!.publicKey
            );
          }
        );
      },
      {
        message: ZkUsdVaultErrors.HEALTH_FACTOR_TOO_HIGH,
      }
    );
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

    await assert.rejects(async () => {
      await testHelper.transaction(
        testHelper.agents.charlie.account,
        async () => {
          await testHelper.engine.contract.liquidate(
            testHelper.agents.alice.vault!.publicKey
          );
        }
      );
    }, /Overflow/i);
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

    await assert.rejects(async () => {
      await testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.engine.contract.liquidate(
          testHelper.agents.alice.vault!.publicKey
        );
      });
    });
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

    assert.deepStrictEqual(aliceVaultCollateralPostLiq, TestAmounts.ZERO);
    assert.deepStrictEqual(aliceVaultDebtPostLiq, TestAmounts.ZERO);
    assert.deepStrictEqual(
      bobZkUsdBalancePostLiq,
      bobZkUsdBalancePreLiq.sub(aliceVaultDebtPreLiq!)
    );
    assert.deepStrictEqual(
      bobMinaBalancePostLiq,
      bobMinaBalancePreLiq.add(aliceVaultCollateralPreLiq!)
    );
    assert.deepStrictEqual(aliceZkUsdBalancePostLiq, aliceZkUsdBalancePreLiq);
    assert.deepStrictEqual(aliceMinaBalancePostLiq, aliceMinaBalancePreLiq);
  });

  it('should emit the Liquidate event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    assert.strictEqual(latestEvent.type, 'Liquidate');
    assert.deepStrictEqual(
      // @ts-ignore
      latestEvent.event.data.vaultAddress,
      testHelper.agents.alice.vault?.publicKey
    );
    assert.strictEqual(
      // @ts-ignore
      latestEvent.event.data.liquidator.toBase58(),
      testHelper.agents.bob.account.toBase58()
    );
    assert.deepStrictEqual(
      // @ts-ignore
      latestEvent.event.data.vaultCollateralLiquidated,
      TestAmounts.COLLATERAL_100_MINA
    );
    assert.deepStrictEqual(
      // @ts-ignore
      latestEvent.event.data.vaultDebtRepaid,
      TestAmounts.DEBT_30_ZKUSD
    );
    assert.deepStrictEqual(
      // @ts-ignore
      latestEvent.event.data.price,
      TestAmounts.PRICE_25_CENT
    );
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

    await assert.rejects(async () => {
      await testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.engine.contract.liquidate(
          testHelper.agents.charlie.vault!.publicKey
        );
      });
    }, new RegExp(ZkUsdEngineErrors.EMERGENCY_HALT));
  });
});
