import { AccountUpdate, Bool, Field, Mina, PrivateKey, UInt32 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper.js';
import { ProtocolData } from '../../types.js';
import { ZkUsdEngine, ZkUsdEngineErrors } from '../../zkusd-engine.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('zkUSD Price Feed Emergency Stop Test Suite', () => {
  const testHelper = new TestHelper();

  before(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice']);

    await testHelper.createVaults(['alice']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.keys, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_100_MINA
      );
    });
  });

  it('should allow the protocol to be stopped with the admin key', async () => {
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.stopTheProtocol();
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const protocolDataPacked =
      await testHelper.engine.contract.protocolDataPacked.fetch();

    const protocolData = ProtocolData.unpack(protocolDataPacked!);

    const emergencyStopFlag = protocolData.emergencyStop;

    assert.deepStrictEqual(emergencyStopFlag, Bool(true));

    await testHelper.resumeTheProtocol();
  });

  it('should emit the emergency stop event', async () => {
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.stopTheProtocol();
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    assert.strictEqual(latestEvent.type, 'EmergencyStop');

    await testHelper.resumeTheProtocol();
  });

  it('should not allow the protocol to be stopped without the admin key', async () => {
    await assert.rejects(async () => {
      await testHelper.transaction(testHelper.agents.alice.keys, async () => {
        await testHelper.engine.contract.stopTheProtocol();
      });
    }, /Transaction verification failed/i);
  });

  it('should allow the protocol to be resumed with the admin key', async () => {
    await testHelper.stopTheProtocol();

    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.resumeTheProtocol();
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const emergencyStopFlag =
      await testHelper.engine.contract.protocolDataPacked.fetch();

    const protocolData = ProtocolData.unpack(emergencyStopFlag!);

    assert.deepStrictEqual(protocolData.emergencyStop, Bool(false));
  });

  it('should emit the emergency resume event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    assert.strictEqual(latestEvent.type, 'EmergencyResume');
  });

  it('should not allow the protocol to be resumed without the admin key', async () => {
    await testHelper.stopTheProtocol();

    await assert.rejects(async () => {
      await testHelper.transaction(testHelper.agents.alice.keys, async () => {
        await testHelper.engine.contract.resumeTheProtocol();
      });
    }, /Transaction verification failed/i);

    await testHelper.resumeTheProtocol();
  });

  it('should not allow vault actions when the protocol is stopped', async () => {
    await testHelper.stopTheProtocol();

    await assert.rejects(async () => {
      await testHelper.transaction(testHelper.agents.alice.keys, async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.alice.keys.publicKey, 1);
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_5_ZKUSD
        );
      });
    }, new RegExp(ZkUsdEngineErrors.EMERGENCY_HALT));

    await testHelper.resumeTheProtocol();
  });

  it('should allow vault actions when the protocol is resumed', async () => {
    await testHelper.stopTheProtocol();

    await assert.rejects(async () => {
      await testHelper.transaction(testHelper.agents.alice.keys, async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_5_ZKUSD
        );
      });
    }, new RegExp(ZkUsdEngineErrors.EMERGENCY_HALT));

    await testHelper.resumeTheProtocol();

    await testHelper.transaction(testHelper.agents.alice.keys, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_5_ZKUSD
      );
    });

    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.keys.publicKey
    );

    assert.deepStrictEqual(vaultBalance, TestAmounts.DEBT_5_ZKUSD);
  });
});
