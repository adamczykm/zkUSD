import { AccountUpdate, Bool, Field, Mina, PrivateKey, UInt32 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import { ProtocolData } from '../../types';
import { ZkUsdEngine, ZkUsdEngineErrors } from '../../zkusd-engine';

describe('zkUSD Price Feed Emergency Stop Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice']);

    await testHelper.createVaults(['alice']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_100_MINA
      );
    });
  });

  // beforeEach(async () => {
  //   await testHelper.resumeTheProtocol();
  // });

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

    expect(emergencyStopFlag).toEqual(Bool(true));

    await testHelper.resumeTheProtocol();
  });

  it('should not allow the protocol to be stopped without the admin key', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.stopTheProtocol();
      })
    ).rejects.toThrow(/Transaction verification failed/i);
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

    expect(protocolData.emergencyStop).toEqual(Bool(false));
  });

  it('should not allow the protocol to be resumed without the admin key', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.resumeTheProtocol();
      })
    ).rejects.toThrow(/Transaction verification failed/i);

    await testHelper.resumeTheProtocol();
  });

  it('should not allow vault actions when the protocol is stopped', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_5_ZKUSD
        );
      })
    ).rejects.toThrow(ZkUsdEngineErrors.EMERGENCY_HALT);

    await testHelper.resumeTheProtocol();
  });

  it('should allow vault actions when the protocol is resumed', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.alice.vault!.publicKey,
          TestAmounts.DEBT_5_ZKUSD
        );
      })
    ).rejects.toThrow(ZkUsdEngineErrors.EMERGENCY_HALT);

    await testHelper.resumeTheProtocol();

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.mintZkUsd(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.DEBT_5_ZKUSD
      );
    });

    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    expect(vaultBalance).toEqual(TestAmounts.DEBT_5_ZKUSD);
  });
});
