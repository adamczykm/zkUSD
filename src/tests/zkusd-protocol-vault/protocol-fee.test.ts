import { AccountUpdate, Field, Mina, PrivateKey, UInt32, UInt64 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import { ZkUsdPriceFeedOracleErrors } from '../../zkusd-price-feed-oracle';

describe('zkUSD Protocol Fee Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);
  });

  it('should allow changing the protocol fee with admin signature', async () => {
    const newFee = UInt64.from(10); // change the fee

    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.protocolVault.contract.updateProtocolFee(newFee);
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );
  });

  it('should not allow changing the protocol fee without admin signature', async () => {
    const newFee = UInt64.from(10); // change the fee

    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.protocolVault.contract.updateProtocolFee(newFee);
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should fail updating the protocol fee if above 100', async () => {
    const newFee = UInt64.from(101);
    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.protocolVault.contract.updateProtocolFee(newFee);
        },
        {
          extraSigners: [testHelper.protocolAdmin.privateKey],
        }
      )
    ).rejects.toThrow();
  });

  it('should not allow the private key to manually send funds from the oracle', async () => {
    const oracleBalanceBefore = Mina.getBalance(
      testHelper.priceFeedOracle.publicKey
    );

    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          const sendUpdate = AccountUpdate.create(
            testHelper.priceFeedOracle.publicKey
          );
          sendUpdate.send({
            to: testHelper.agents.alice.account,
            amount: oracleBalanceBefore,
          });
        },
        {
          extraSigners: [testHelper.priceFeedOracle.privateKey],
        }
      )
    ).rejects.toThrow(/Update_not_permitted_balance/i);
  });

  it('should pay out the oracle fee correctly', async () => {
    const oracleFee = await testHelper.protocolVault.contract.getOracleFee();

    //get the current balance of the price feed oracle
    const priceFeedOracleBalanceBefore = Mina.getBalance(
      testHelper.priceFeedOracle.publicKey
    );
    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleName = Array.from(whitelistedOracles.keys())[0];
    const oracle = testHelper.agents[oracleName].account;

    // Get oracle's initial balance
    const oracleBalanceBefore = Mina.getBalance(oracle);

    // Submit price from oracle
    await testHelper.transaction(oracle, async () => {
      await testHelper.priceFeedOracle.contract.submitPrice(
        TestAmounts.PRICE_25_CENT,
        testHelper.whitelist
      );
    });

    // Get oracle's balance after submission
    const oracleBalanceAfter = Mina.getBalance(oracle);

    const priceFeedOracleBalanceAfter = Mina.getBalance(
      testHelper.priceFeedOracle.publicKey
    );

    // Verify oracle received the fee
    expect(oracleBalanceAfter.toString()).toBe(
      oracleBalanceBefore.add(oracleFee).toString()
    );

    expect(
      priceFeedOracleBalanceBefore.sub(priceFeedOracleBalanceAfter)
    ).toEqual(oracleFee);
  });
});
