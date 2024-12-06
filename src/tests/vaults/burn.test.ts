import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Field, UInt64 } from 'o1js';
import { ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Burn Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie']);

    //deploy alice's vault
    await testHelper.createVaults(['alice']);

    // Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_100_MINA
      );
    });

    // Alice mint 30 zkUSD
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_30_ZKUSD
      );
    });
  });

  it('should allow alice to burn zkUSD', async () => {
    const aliceStartingBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const vaultStartingDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.burnZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_1_ZKUSD
      );
    });

    const vaultFinalDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    const aliceFinalBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    expect(vaultFinalDebt).toEqual(
      vaultStartingDebt?.sub(TestAmounts.DEBT_1_ZKUSD)
    );
    expect(aliceFinalBalance).toEqual(
      aliceStartingBalance.sub(TestAmounts.DEBT_1_ZKUSD)
    );
  });

  it('should emit the BurnZkUsd event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('BurnZkUsd');
    // @ts-ignore
    expect(latestEvent.event.data.vaultAddress).toEqual(
      testHelper.agents.alice.vault?.publicKey
    );
    // @ts-ignore
    expect(latestEvent.event.data.amountBurned).toEqual(
      TestAmounts.DEBT_1_ZKUSD
    );
    // @ts-ignore
    expect(latestEvent.event.data.vaultCollateralAmount).toEqual(
      TestAmounts.COLLATERAL_100_MINA
    );
    // @ts-ignore
    expect(latestEvent.event.data.vaultDebtAmount).toEqual(
      TestAmounts.DEBT_30_ZKUSD.sub(TestAmounts.DEBT_1_ZKUSD)
    );
  });

  it('should fail if burn amount is zero', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.burnZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.ZERO
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
  });

  it('should fail if burn amount exceeds debt', async () => {
    const currentDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.burnZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          currentDebt!.add(1)
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_EXCEEDS_DEBT);
  });

  it('should fail if burn amount is negative', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.burnZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          UInt64.from(-1)
        );
      })
    ).rejects.toThrow();
  });

  it('should track debt correctly after multiple burns', async () => {
    const initialDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    // Perform multiple small burns
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.burnZkUsd(
            testHelper.agents.alice.vault!.publicKey,
            TestAmounts.DEBT_10_CENT_ZKUSD
          );
        }
      );
    }

    const finalDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    expect(finalDebt).toEqual(
      initialDebt?.sub(TestAmounts.DEBT_10_CENT_ZKUSD.mul(3))
    );
  });

  it('should fail if trying to burn without sufficient zkUSD balance', async () => {
    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    //Alice transfers all her zkUSD to Bob
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.token.contract.transfer(
        testHelper.agents.alice.account,
        testHelper.agents.bob.account,
        aliceBalance
      );
    });

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.burnZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_10_CENT_ZKUSD
        );
      })
    ).rejects.toThrow();
  });
});
