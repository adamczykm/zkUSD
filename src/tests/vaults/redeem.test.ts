import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Field, Mina, UInt64 } from 'o1js';
import { ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault';
import { ZkUsdEngineErrors } from '../../zkusd-engine';

describe('zkUSD Vault Redeem Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie', 'rewards']);

    //deploy alice's vault
    await testHelper.createVaults(['alice', 'bob']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_100_MINA
      );
    });

    //Alice mints 5 zkUSD
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_5_ZKUSD
      );
    });
  });

  const redeemCollateral = async (amount: UInt64, shouldPrintTx = false) => {
    try {
      const txResult = await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.redeemCollateral(
            testHelper.agents.alice.vault!.publicKey,
            amount
          );
        },
        {
          printTx: shouldPrintTx,
        }
      );
      return txResult;
    } catch (e) {
      throw e;
    }
  };

  it('should allow alice to redeem collateral', async () => {
    const initialCollateral =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();
    const aliceBalanceBefore = Mina.getBalance(testHelper.agents.alice.account);

    await redeemCollateral(TestAmounts.COLLATERAL_1_MINA);

    const finalCollateral =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();
    const aliceBalanceAfter = Mina.getBalance(testHelper.agents.alice.account);

    expect(finalCollateral).toEqual(
      initialCollateral?.sub(TestAmounts.COLLATERAL_1_MINA)
    );
    expect(aliceBalanceAfter).toEqual(
      aliceBalanceBefore.add(TestAmounts.COLLATERAL_1_MINA)
    );
  });

  it('should emit the RedeemCollateral event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('RedeemCollateral');
    // @ts-ignore
    expect(latestEvent.event.data.vaultAddress).toEqual(
      testHelper.agents.alice.vault?.publicKey
    );
    // @ts-ignore
    expect(latestEvent.event.data.amountRedeemed).toEqual(
      TestAmounts.COLLATERAL_1_MINA
    );
    // @ts-ignore
    expect(latestEvent.event.data.vaultCollateralAmount).toEqual(
      TestAmounts.COLLATERAL_100_MINA.sub(TestAmounts.COLLATERAL_1_MINA)
    );
    // @ts-ignore
    expect(latestEvent.event.data.vaultDebtAmount).toEqual(
      TestAmounts.DEBT_5_ZKUSD
    );
  });

  it('should fail if the amount redeemed is zero', async () => {
    const aliceBalanceBefore = Mina.getBalance(testHelper.agents.alice.account);

    await expect(redeemCollateral(TestAmounts.ZERO)).rejects.toThrow(
      ZkUsdVaultErrors.AMOUNT_ZERO
    );

    const aliceBalanceAfter = Mina.getBalance(testHelper.agents.alice.account);

    expect(aliceBalanceAfter).toEqual(aliceBalanceBefore);
  });

  it('should fail if the user tries to send Mina from the engine without proof', async () => {
    const totalDepositedCollateral =
      await testHelper.engine.contract.getTotalDepositedCollateral();

    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          let au = AccountUpdate.createSigned(testHelper.engine.publicKey);
          au.send({
            to: testHelper.agents.alice.account,
            amount: totalDepositedCollateral,
          });
        },
        {
          extraSigners: [testHelper.engine.privateKey],
        }
      )
    ).rejects.toThrow(/Update_not_permitted_balance/i);
  });

  it('should fail if the redeemer is not the owner', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.engine.contract.redeemCollateral(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.COLLATERAL_1_MINA
        );
      })
    ).rejects.toThrow(/Field.assertEquals()/i);
  });

  it('should fail if redemption amount is greater than collateral amount', async () => {
    // Try to redeem too much collateral
    await expect(
      redeemCollateral(TestAmounts.COLLATERAL_100_MINA)
    ).rejects.toThrow(ZkUsdVaultErrors.INSUFFICIENT_COLLATERAL);
  });

  it('should fail if redemption amount would undercollateralize the vault', async () => {
    const currentCollateral =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();

    const currentDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    expect(currentDebt!.toBigInt()).toBeGreaterThan(
      TestAmounts.ZERO.toBigInt()
    );

    // Try to redeem too much collateral
    await expect(redeemCollateral(currentCollateral!)).rejects.toThrow(
      ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW
    );
  });

  it('should track collateral correctly after multiple redemptions', async () => {
    const initialCollateral =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();

    // Perform multiple small redemptions
    for (let i = 0; i < 3; i++) {
      await redeemCollateral(TestAmounts.COLLATERAL_1_MINA);
    }

    const finalCollateral =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();
    expect(finalCollateral).toEqual(
      initialCollateral?.sub(TestAmounts.COLLATERAL_1_MINA.mul(3))
    );
  });

  it('Should fail if the price feed is in emergency mode', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.redeemCollateral(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.COLLATERAL_1_MINA
        );
      })
    ).rejects.toThrow(ZkUsdEngineErrors.EMERGENCY_HALT);
  });

  it('Should allow redeeming if the price feed is resumed', async () => {
    await testHelper.resumeTheProtocol();

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.redeemCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_1_MINA
      );
    });
  });
});
