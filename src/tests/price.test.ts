import { AccountUpdate, Int64, Mina } from 'o1js';
import { TestAmounts, TestHelper } from './test-helper';

describe('zkUSD Price Feed Engine Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);
    await testHelper.createVaults(['alice', 'bob']);
  });

  async function printOracleFundsTrackerBalance() {
    const oracleFundsTrackerBalance =
      await testHelper.engine.contract.getAvailableOracleFunds();
    console.log('Available Oracle Funds', oracleFundsTrackerBalance.toString());
  }

  it('should correctly pay the oracle fee', async () => {
    const price = TestAmounts.PRICE_2_USD;

    await printOracleFundsTrackerBalance();
    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.depositOracleFunds(
        TestAmounts.COLLATERAL_2_MINA
      );
    });

    await printOracleFundsTrackerBalance();

    await testHelper.transaction(
      testHelper.agents['initialOracle0'].account,
      async () => {
        await testHelper.engine.contract.submitPrice(
          price,
          testHelper.whitelist
        );
      },
      { printTx: false }
    );
    await printOracleFundsTrackerBalance();

    await testHelper.transaction(
      testHelper.agents['initialOracle1'].account,
      async () => {
        await testHelper.engine.contract.submitPrice(
          price,
          testHelper.whitelist
        );
      },
      { printTx: false }
    );

    await printOracleFundsTrackerBalance();

    await testHelper.transaction(
      testHelper.agents['initialOracle2'].account,
      async () => {
        await testHelper.engine.contract.submitPrice(
          price,
          testHelper.whitelist
        );
      },
      { printTx: false }
    );
  });
});
