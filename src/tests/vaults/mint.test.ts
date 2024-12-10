import { TestHelper, TestAmounts } from '../test-helper';
import { UInt64 } from 'o1js';
import { ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault';
import { ZkUsdEngineErrors } from '../../zkusd-engine';

describe('zkUSD Vault Mint Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);

    //deploy alice's vault
    await testHelper.createVaults(['alice']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_100_MINA
      );
    });
  });

  it('should allow alice to mint zkUSD', async () => {
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_5_ZKUSD
      );
    });

    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const debtAmount =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    expect(debtAmount).toEqual(TestAmounts.DEBT_5_ZKUSD);
    expect(aliceBalance).toEqual(TestAmounts.DEBT_5_ZKUSD);
  });

  it('should emit the MintZkUsd event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('MintZkUsd');
    // @ts-ignore
    expect(latestEvent.event.data.vaultAddress).toEqual(
      testHelper.agents.alice.vault?.publicKey
    );
    // @ts-ignore
    expect(latestEvent.event.data.amountMinted).toEqual(
      TestAmounts.DEBT_5_ZKUSD
    );
    // @ts-ignore
    expect(latestEvent.event.data.vaultCollateralAmount).toEqual(
      TestAmounts.COLLATERAL_100_MINA
    );
    // @ts-ignore
    expect(latestEvent.event.data.vaultDebtAmount).toEqual(
      TestAmounts.DEBT_5_ZKUSD
    );
  });

  it('should track total debt correctly across multiple mint operations', async () => {
    const initialDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    // Perform multiple small mints
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.mintZkUsd(
            testHelper.agents.alice.vault!.publicKey,
            TestAmounts.DEBT_1_ZKUSD
          );
        }
      );
    }

    const finalDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    expect(finalDebt).toEqual(
      initialDebt?.add(TestAmounts.DEBT_1_ZKUSD.mul(3))
    );
  });

  it('should fail if mint amount is zero', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.ZERO
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
  });

  it('should fail if mint amount is negative', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          UInt64.from(-1)
        );
      })
    ).rejects.toThrow();
  });

  it('should fail if the minter is not the owner of the vault', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_5_ZKUSD
        );
      })
    ).rejects.toThrow(/Field.assertEquals()/i);
  });

  it('should fail if the health factor is too low', async () => {
    const LARGE_ZKUSD_AMOUNT = UInt64.from(1000e9); // Very large amount to ensure health factor violation

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          LARGE_ZKUSD_AMOUNT
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW);
  });

  it('should maintain correct health factor after multiple mint operations', async () => {
    const initialCollateral =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();
    let currentDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    // Mint multiple times while checking health factor
    for (let i = 0; i < 3; i++) {
      const healthFactor =
        testHelper.agents.alice.vault?.contract.calculateHealthFactor(
          initialCollateral!,
          currentDebt!.add(TestAmounts.DEBT_1_ZKUSD),
          await testHelper.engine.contract.getPrice()
        );

      // Only mint if health factor would remain above minimum
      if (healthFactor!.greaterThanOrEqual(ZkUsdVault.MIN_HEALTH_FACTOR)) {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.engine.contract.mintZkUsd(
              testHelper.agents.alice.vault!.publicKey,
              TestAmounts.DEBT_1_ZKUSD
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
        await testHelper.engine.contract.getPrice()
      );

    expect(
      finalHealthFactor!.greaterThanOrEqual(ZkUsdVault.MIN_HEALTH_FACTOR)
    ).toBeTruthy();
  });

  it('should not allow minting from calling the token contract directly', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.token.contract.mint(
          testHelper.agents.alice.account,
          TestAmounts.DEBT_5_ZKUSD
        );
      })
    ).rejects.toThrow(/Account_app_state_precondition_unsatisfied/i);
  });

  it('Should fail if the engine is halted', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_5_ZKUSD
        );
      })
    ).rejects.toThrow(ZkUsdEngineErrors.EMERGENCY_HALT);
  });

  it('Should allow minting if the price feed is resumed', async () => {
    await testHelper.resumeTheProtocol();

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_5_ZKUSD
      );
    });
  });
});
