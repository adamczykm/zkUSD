import { AccountUpdate, Bool, Field, Mina, PrivateKey, UInt32 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import {
  ZkUsdPriceFeedOracle,
  ZkUsdPriceFeedOracleErrors,
} from '../../zkusd-price-feed-oracle';
import { OracleWhitelist } from '../../zkusd-protocol-vault';

describe('zkUSD Price Feed Emergency Stop Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice']);

    await testHelper.deployVaults(['alice']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_100_MINA,
        testHelper.agents.alice.secret
      );
    });
  });

  beforeEach(async () => {
    await testHelper.resumeTheProtocol();
  });

  it('should allow the protocol to be stopped with the admin key', async () => {
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.priceFeedOracle.contract.stopTheProtocol();
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    const emergencyStopFlag =
      await testHelper.priceFeedOracle.contract.protocolEmergencyStop.fetch();
    expect(emergencyStopFlag).toEqual(Bool(true));
  });

  it('should not allow the protocol to be stopped without the admin key', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.priceFeedOracle.contract.stopTheProtocol();
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should allow the protocol to be resumed with the admin key', async () => {
    await testHelper.stopTheProtocol();

    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.priceFeedOracle.contract.resumeTheProtocol();
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    const emergencyStopFlag =
      await testHelper.priceFeedOracle.contract.protocolEmergencyStop.fetch();
    expect(emergencyStopFlag).toEqual(Bool(false));
  });

  it('should not allow the protocol to be resumed without the admin key', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.priceFeedOracle.contract.resumeTheProtocol();
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should not allow vault actions when the protocol is stopped', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          testHelper.agents.alice.account,
          TestAmounts.DEBT_5_ZKUSD,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.EMERGENCY_HALT);
  });

  it('should allow vault actions when the protocol is resumed', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          testHelper.agents.alice.account,
          TestAmounts.DEBT_5_ZKUSD,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.EMERGENCY_HALT);

    await testHelper.resumeTheProtocol();

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        testHelper.agents.alice.account,
        TestAmounts.DEBT_5_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    expect(vaultBalance).toEqual(TestAmounts.DEBT_5_ZKUSD);
  });
});
