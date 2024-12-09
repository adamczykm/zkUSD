import { AccountUpdate, Field, Mina, PrivateKey, UInt32 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import { ProtocolData } from '../../types';

describe('zkUSD Protocol Oracle Fee Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice']);
  });

  it('should allow the fee to be changed with the admin key', async () => {
    const newFee = TestAmounts.COLLATERAL_2_MINA;

    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateOracleFee(newFee);
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const packedData =
      await testHelper.engine.contract.protocolDataPacked.fetch();

    const protocolData = ProtocolData.unpack(packedData!);

    expect(protocolData.oracleFlatFee).toEqual(newFee);
  });

  it('should emit the oracle fee update event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('OracleFeeUpdated');

    // @ts-ignore
    expect(latestEvent.event.data.newFee).toEqual(
      TestAmounts.COLLATERAL_2_MINA
    );
    // @ts-ignore
    expect(latestEvent.event.data.previousFee).toEqual(
      TestAmounts.COLLATERAL_1_MINA
    );
  });

  it('should not allow the fee to be changed without the admin key', async () => {
    const newFee = TestAmounts.COLLATERAL_1_MINA;

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.updateOracleFee(newFee);
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should not allow the private key to manually send funds from the engine', async () => {
    const oracleBalanceBefore = Mina.getBalance(testHelper.engine.publicKey);

    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          const sendUpdate = AccountUpdate.create(testHelper.engine.publicKey);
          sendUpdate.send({
            to: testHelper.agents.alice.account,
            amount: oracleBalanceBefore,
          });
        },
        {
          extraSigners: [TestHelper.engineKeyPair.privateKey],
        }
      )
    ).rejects.toThrow(/Update_not_permitted_balance/i);
  });

  it('should pay out the oracle fee correctly', async () => {
    const packedData =
      await testHelper.engine.contract.protocolDataPacked.fetch();
    const protocolData = ProtocolData.unpack(packedData!);
    const oracleFee = protocolData.oracleFlatFee;

    //get the current balance of the price feed oracle
    const priceFeedOracleBalanceBefore = Mina.getBalance(
      testHelper.engine.publicKey
    );
    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleName = Array.from(whitelistedOracles.keys())[0];
    const oracle = testHelper.agents[oracleName].account;

    // Get oracle's initial balance
    const oracleBalanceBefore = Mina.getBalance(oracle);

    // Submit price from oracle
    await testHelper.transaction(oracle, async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_25_CENT,
        testHelper.whitelist
      );
    });

    // Get oracle's balance after submission
    const oracleBalanceAfter = Mina.getBalance(oracle);

    const priceFeedOracleBalanceAfter = Mina.getBalance(
      testHelper.engine.publicKey
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
