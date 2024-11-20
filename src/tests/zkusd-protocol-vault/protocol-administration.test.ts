import {
  AccountUpdate,
  Bool,
  DeployArgs,
  Field,
  method,
  Poseidon,
  PrivateKey,
  Provable,
  PublicKey,
  SmartContract,
  state,
  State,
  UInt64,
  VerificationKey,
  Permissions,
  assert,
  fetchAccount,
  Mina,
} from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import {
  OracleWhitelist,
  ZkUsdProtocolVaultErrors,
} from '../../zkusd-protocol-vault';
import { ZkUsdPriceFeedOracleErrors } from '../../zkusd-price-feed-oracle';

describe('zkUSD Protocol Vault Administration Test Suite', () => {
  const testHelper = new TestHelper();
  let newVerificationKey: VerificationKey;

  const newAdmin = PrivateKey.randomKeypair();

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
        await testHelper.protocolVault.contract.updateAdmin(newAdmin.publicKey);
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    //Verify the admin key is updated
    const adminKey = await testHelper.protocolVault.contract.admin.fetch();
    expect(adminKey).toEqual(newAdmin.publicKey);
  });

  it('should allow the new admin key to make updates to the protocol vault', async () => {
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.priceFeedOracle.contract.stopTheProtocol();
      },
      {
        extraSigners: [newAdmin.privateKey],
      }
    );

    let isHalted =
      await testHelper.priceFeedOracle.contract.protocolEmergencyStop.fetch();
    expect(isHalted).toEqual(Bool(true));

    //Resume the protocol
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.priceFeedOracle.contract.resumeTheProtocol();
      },
      { extraSigners: [newAdmin.privateKey] }
    );

    isHalted =
      await testHelper.priceFeedOracle.contract.protocolEmergencyStop.fetch();
    expect(isHalted).toEqual(Bool(false));
  });

  it('should not allow the admin key to be updated without the current admin key', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.protocolVault.contract.updateAdmin(newAdmin.publicKey);
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should not allow the admin contract to be upgraded in the current version', async () => {
    const oldAccount = Mina.getAccount(testHelper.protocolVault.publicKey);

    const verificationKey = oldAccount.zkapp?.verificationKey;

    await expect(
      testHelper.transaction(
        testHelper.deployer,
        async () => {
          await testHelper.protocolVault.contract.updateVerificationKey(
            verificationKey!
          );
        },
        {
          extraSigners: [newAdmin.privateKey],
        }
      )
    ).rejects.toThrow(
      /Transaction verification failed: Cannot update field 'verificationKey' because permission for this field is 'Impossible'/i
    );
  });
});
