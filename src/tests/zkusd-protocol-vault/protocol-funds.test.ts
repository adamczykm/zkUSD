import { AccountUpdate, Field, Mina, PrivateKey, UInt32 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';

import { ZkUsdVault } from '../../zkusd-vault';

describe('zkUSD Protocol Oracle Fee Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice']);
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
      await testHelper.protocolVault.contract.getProtocolFee();

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

  it('should not allow the private key to manually send funds from the protocol vault', async () => {
    const vaultBalanceBefore = Mina.getBalance(
      testHelper.protocolVault.publicKey
    );

    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          const sendUpdate = AccountUpdate.create(
            testHelper.protocolVault.publicKey
          );
          sendUpdate.send({
            to: testHelper.agents.alice.account,
            amount: TestAmounts.COLLATERAL_1_MINA,
          });
        },
        {
          extraSigners: [testHelper.priceFeedOracle.privateKey],
        }
      )
    ).rejects.toThrow(/Update_not_permitted_balance/i);

    const vaultBalanceAfter = Mina.getBalance(
      testHelper.protocolVault.publicKey
    );

    expect(vaultBalanceAfter).toEqual(vaultBalanceBefore);
  });
});
