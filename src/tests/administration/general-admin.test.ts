import { AccountUpdate, Bool, PrivateKey, VerificationKey, Mina } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper.js';
import { ProtocolData } from '../../types.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('zkUSD Protocol Vault Administration Test Suite', () => {
  const testHelper = new TestHelper();
  let newVerificationKey: VerificationKey;

  const newAdmin = PrivateKey.randomKeypair();

  before(async () => {
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

    //Fund the creation of the new admin account
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      AccountUpdate.create(newAdmin.publicKey);
    });
  });

  it('should allow the admin key to be changed with the current admin key', async () => {
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.engine.contract.updateAdmin(newAdmin.publicKey);
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    //Verify the admin key is updated
    const packedData =
      await testHelper.engine.contract.protocolDataPacked.fetch();
    const protocolData = ProtocolData.unpack(packedData!);

    assert.deepStrictEqual(protocolData.admin, newAdmin.publicKey);
  });

  it('should emit the admin update event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    assert.strictEqual(latestEvent.type, 'AdminUpdated');
    // @ts-ignore
    assert.deepStrictEqual(latestEvent.event.data.newAdmin, newAdmin.publicKey);
    assert.deepStrictEqual(
      // @ts-ignore

      latestEvent.event.data.previousAdmin,
      TestHelper.protocolAdminKeyPair.publicKey
    );
  });

  it('should allow the new admin key to make updates to the protocol vault', async () => {
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.engine.contract.stopTheProtocol();
      },
      {
        extraSigners: [newAdmin.privateKey],
      }
    );

    let packedData =
      await testHelper.engine.contract.protocolDataPacked.fetch();
    let protocolData = ProtocolData.unpack(packedData!);

    assert.deepStrictEqual(protocolData.emergencyStop, Bool(true));

    //Resume the protocol
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.engine.contract.resumeTheProtocol();
      },
      { extraSigners: [newAdmin.privateKey] }
    );

    packedData = await testHelper.engine.contract.protocolDataPacked.fetch();
    protocolData = ProtocolData.unpack(packedData!);

    assert.deepStrictEqual(protocolData.emergencyStop, Bool(false));
  });

  it('should not allow the admin key to be updated without the current admin key', async () => {
    await assert.rejects(async () => {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.updateAdmin(newAdmin.publicKey);
        }
      );
    }, /Transaction verification failed/i);
  });

  it('should not allow the admin contract to be upgraded in the current version', async () => {
    const oldAccount = Mina.getAccount(testHelper.engine.publicKey);
    const verificationKey = oldAccount.zkapp?.verificationKey;

    await assert.rejects(async () => {
      await testHelper.transaction(
        testHelper.deployer,
        async () => {
          await testHelper.engine.contract.updateVerificationKey(
            verificationKey!
          );
        },
        {
          extraSigners: [newAdmin.privateKey],
        }
      );
    }, /Transaction verification failed: Cannot update field 'verificationKey' because permission for this field is 'Impossible'/i);
  });
});
