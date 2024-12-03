import { AccountUpdate, Int64, Mina } from 'o1js';
import { TestAmounts, TestHelper } from './test-helper';

describe('zkUSD Price Feed Engine Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);
    await testHelper.createVaults(['alice', 'bob']);

    //bob deposits collateral
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.bob.vault!.publicKey,
        TestAmounts.COLLATERAL_900_MINA
      );
    });

    //bob mints zkUSD
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.bob.vault!.publicKey,
        TestAmounts.DEBT_100_ZKUSD
      );
    });
  });

  it('should deposit collateral', async () => {
    const aliceBalanceBeforeDeposit = Mina.getBalance(
      testHelper.agents.alice.account
    );

    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.engine.contract.depositCollateral(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.COLLATERAL_100_MINA
        );
      },
      {
        printTx: true,
      }
    );

    const aliceBalanceAfterDeposit = Mina.getBalance(
      testHelper.agents.alice.account
    );

    const collateralDeposited =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();

    console.log('Collateral deposited: ', collateralDeposited!.toString());

    const totalDepositedCollateral =
      await testHelper.engine.contract.getTotalDepositedCollateral();

    const totalEngineBalance = Mina.getBalance(testHelper.engine.publicKey);

    console.log('Total engine balance: ', totalEngineBalance.toString());

    console.log(
      'Total deposited collateral: ',
      totalDepositedCollateral.toString()
    );

    console.log(
      'Alice balance before deposit: ',
      aliceBalanceBeforeDeposit.toString()
    );
    console.log(
      'Alice balance after deposit: ',
      aliceBalanceAfterDeposit.toString()
    );
  });

  it('should mint zkUSD', async () => {
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        // AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_50_ZKUSD
        );
      },
      {
        printTx: true,
      }
    );
    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const debtAmount =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    expect(debtAmount).toEqual(TestAmounts.DEBT_50_ZKUSD);
    expect(aliceBalance).toEqual(TestAmounts.DEBT_50_ZKUSD);
  });

  it('should redeem collateral', async () => {
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.engine.contract.redeemCollateral(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.COLLATERAL_1_MINA
        );
      },
      {
        printTx: true,
      }
    );

    const totalDepositedCollateral =
      await testHelper.engine.contract.getTotalDepositedCollateral();

    console.log(
      'Total deposited collateral: ',
      totalDepositedCollateral.toString()
    );
  });

  it('should burn zkUSD', async () => {
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.engine.contract.burnZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_10_ZKUSD
        );
      },
      {
        printTx: true,
      }
    );

    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const debtAmount =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    expect(debtAmount).toEqual(TestAmounts.DEBT_40_ZKUSD);
    expect(aliceBalance).toEqual(TestAmounts.DEBT_40_ZKUSD);
  });

  it('should liquidate a vault', async () => {
    //price drop
    await testHelper.updateOraclePrice(TestAmounts.PRICE_50_CENT);

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.liquidate(
        testHelper.agents.alice.vault!.publicKey
      );
    });
  });
});
