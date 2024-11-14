import { ZkUsdProtocolVault } from '../zkusd-protocol-vault';
import { ZkUsdVault } from '../zkusd-vault';
import { TestHelper, TestAmounts } from './test-helper';
import {
  AccountUpdate,
  Permissions,
  DeployArgs,
  method,
  Mina,
  PublicKey,
  SmartContract,
  state,
  State,
  UInt64,
  VerificationKey,
  Int64,
} from 'o1js';

class ZkUsdProtocolVaultV2 extends SmartContract {
  @state(UInt64) protocolFee = State<UInt64>();

  async deploy(args: DeployArgs) {
    await super.deploy(args);
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey: Permissions.VerificationKey.proofOrSignature(),
      setPermissions: Permissions.impossible(),
    });
  }

  @method
  async updateVerificationKey(vk: VerificationKey) {
    this.account.verificationKey.set(vk);
  }

  @method async withdraw(amount: UInt64) {
    this.send({ to: this.sender.getUnconstrainedV2(), amount });
  }

  @method async setProtocolFee(fee: UInt64) {
    this.protocolFee.set(fee);
  }
}

describe('zkUSD Protocol Vault Test Suite', () => {
  const testHelper = new TestHelper();
  let newVerificationKey: VerificationKey;

  beforeAll(async () => {
    const compiledZkApp = await ZkUsdProtocolVaultV2.compile();
    newVerificationKey = compiledZkApp.verificationKey;
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);

    await testHelper.deployVaults(['alice']);

    // Send some rewards to the vault
    await testHelper.sendRewardsToVault(
      'alice',
      TestAmounts.COLLATERAL_50_MINA
    );

    //Alice redeems the rewards, earning the protocol fee
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.redeemCollateral(
        TestAmounts.ZERO,
        testHelper.agents.alice.secret
      );
    });
  });

  it('should have the correct balance', async () => {
    const balance = Mina.getBalance(testHelper.protocolVault.publicKey);

    const currentProtocolFee =
      testHelper.protocolVault.contract.protocolFee.get();

    const protocolFee = TestAmounts.COLLATERAL_50_MINA.mul(
      currentProtocolFee
    ).div(ZkUsdVault.PROTOCOL_FEE_PRECISION);

    expect(balance).toEqual(protocolFee);
  });

  it('should allow withdrawal of protocol funds with admin signature', async () => {
    const adminBalanceBefore = Mina.getBalance(testHelper.deployer);
    const vaultBalanceBefore = Mina.getBalance(
      testHelper.protocolVault.publicKey
    );

    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.protocolVault.contract.withdrawProtocolFunds(
          testHelper.deployer,
          TestAmounts.COLLATERAL_1_MINA
        );
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    const adminBalanceAfter = Mina.getBalance(testHelper.deployer);
    const vaultBalanceAfter = Mina.getBalance(
      testHelper.protocolVault.publicKey
    );

    expect(vaultBalanceAfter).toEqual(
      vaultBalanceBefore.sub(TestAmounts.COLLATERAL_1_MINA)
    );
    expect(adminBalanceAfter).toEqual(
      adminBalanceBefore.add(TestAmounts.COLLATERAL_1_MINA)
    );
  });

  it('should allow changing the protocol fee with admin signature', async () => {
    const newFee = UInt64.from(10); // change the fee

    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.protocolVault.contract.setProtocolFee(newFee);
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );
  });

  it('should not allow the withdrawal of protocol funds without admin signature', async () => {
    // First send some funds to the protocol vault

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.protocolVault.contract.withdrawProtocolFunds(
          testHelper.agents.alice.account,
          TestAmounts.COLLATERAL_1_MINA
        );
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should not allow changing the protocol fee without admin signature', async () => {
    const newFee = UInt64.from(10); // change the fee

    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.protocolVault.contract.setProtocolFee(newFee);
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should fail updating the protocol fee if above 100', async () => {
    const newFee = UInt64.from(101);
    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.protocolVault.contract.setProtocolFee(newFee);
        },
        {
          extraSigners: [testHelper.protocolAdmin.privateKey],
        }
      )
    ).rejects.toThrow();
  });

  it('should not allow admin to withdraw more than balance', async () => {
    const vaultBalance = Mina.getBalance(testHelper.protocolVault.publicKey);
    const excessiveAmount = vaultBalance.add(TestAmounts.COLLATERAL_1_MINA);

    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.protocolVault.contract.withdrawProtocolFunds(
            testHelper.agents.alice.account,
            excessiveAmount
          );
        },
        {
          extraSigners: [testHelper.protocolAdmin.privateKey],
        }
      )
    ).rejects.toThrow();
  });

  it('should not allow non-admin to update verification key', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.protocolVault.contract.updateVerificationKey(
          newVerificationKey
        );
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  // Update the verification key tests:
  it('should allow updating the verification key with admin signature', async () => {
    await testHelper.transaction(
      testHelper.agents.bob.account,
      async () => {
        await testHelper.protocolVault.contract.updateVerificationKey(
          newVerificationKey
        );
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    // Verify we can use V2 functionality after upgrade
    const zkAppV2 = new ZkUsdProtocolVaultV2(
      testHelper.protocolVault.publicKey
    );
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await zkAppV2.setProtocolFee(UInt64.from(1000));
    });
  });
});
