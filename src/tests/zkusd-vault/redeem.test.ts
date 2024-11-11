import { TestHelper, TestAmounts } from '../test-helper';
import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  Signature,
  UInt64,
} from 'o1js';
import { OraclePayload, ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Redeem Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie', 'rewards']);

    //deploy alice's vault
    await testHelper.deployVaults(['alice', 'bob']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.LARGE_COLLATERAL,
        testHelper.agents.alice.secret
      );
    });

    //Alice mints 5 zkUSD
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        TestAmounts.MEDIUM_ZKUSD,
        testHelper.agents.alice.secret,
        testHelper.oracle.getSignedPrice()
      );
    });
  });

  const redeemCollateral = async (amount: UInt64) => {
    try {
      const txResult = await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.redeemCollateral(
            amount,
            testHelper.agents.alice.secret,
            testHelper.oracle.getSignedPrice()
          );
        }
      );
      return txResult;
    } catch (e) {
      throw e;
    }
  };

  it('should allow alice to redeem collateral', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    const aliceBalanceBefore = Mina.getBalance(testHelper.agents.alice.account);

    await redeemCollateral(TestAmounts.SMALL_COLLATERAL);

    const finalCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    const aliceBalanceAfter = Mina.getBalance(testHelper.agents.alice.account);

    expect(finalCollateral).toEqual(
      initialCollateral?.sub(TestAmounts.SMALL_COLLATERAL)
    );
    expect(aliceBalanceAfter).toEqual(
      aliceBalanceBefore.add(TestAmounts.SMALL_COLLATERAL)
    );
  });

  it('should redeem nothing if the amount redeemed is zero', async () => {
    const aliceBalanceBefore = Mina.getBalance(testHelper.agents.alice.account);

    await redeemCollateral(TestAmounts.ZERO);

    const aliceBalanceAfter = Mina.getBalance(testHelper.agents.alice.account);

    expect(aliceBalanceAfter).toEqual(aliceBalanceBefore);
  });

  it('should fail if the user tries to send Mina from the vault without proof', async () => {
    const vaultBalance = Mina.getBalance(
      testHelper.agents.alice.vault!.publicKey!
    );

    await expect(
      testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          let au = AccountUpdate.createSigned(
            testHelper.agents.alice.vault!.publicKey!
          );
          au.send({
            to: testHelper.agents.alice.account,
            amount: vaultBalance,
          });
        },
        {
          extraSigners: [testHelper.agents.alice.vault?.privateKey!],
        }
      )
    ).rejects.toThrow(/Update_not_permitted_balance/i);
  });

  it('should fail if secret is incorrect', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.redeemCollateral(
          TestAmounts.SMALL_ZKUSD,
          Field.random(),
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_SECRET);
  });

  it('should fail if oracle payload is invalid', async () => {
    const wrongKeyPair = PrivateKey.randomKeypair();
    const wrongSignature = Signature.create(wrongKeyPair.privateKey, [
      ...testHelper.oracle.getSignedPrice().price.toFields(),
      ...testHelper.oracle.getSignedPrice().blockchainLength.toFields(),
    ]);

    const invalidPayload = new OraclePayload({
      ...testHelper.oracle.getSignedPrice(),
      signature: wrongSignature,
    });

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.redeemCollateral(
          TestAmounts.SMALL_COLLATERAL,
          testHelper.agents.alice.secret,
          invalidPayload
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_ORACLE_SIG);
  });

  it('should fail if redemption amount is greater than collateral amount', async () => {
    // Try to redeem too much collateral
    await expect(
      redeemCollateral(TestAmounts.LARGE_COLLATERAL)
    ).rejects.toThrow(ZkUsdVaultErrors.INSUFFICIENT_COLLATERAL);
  });

  it('should fail if redemption amount would undercollateralize the vault', async () => {
    const currentCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();

    const currentDebt =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    expect(currentDebt!.toBigInt()).toBeGreaterThan(
      TestAmounts.ZERO.toBigInt()
    );

    // Try to redeem too much collateral
    await expect(redeemCollateral(currentCollateral!)).rejects.toThrow(
      ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW
    );
  });

  it('should allow bob to redeem if he has the correct secret', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    const bobBalanceBefore = Mina.getBalance(testHelper.agents.bob.account);

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.alice.vault?.contract.redeemCollateral(
        TestAmounts.SMALL_COLLATERAL,
        testHelper.agents.alice.secret,
        testHelper.oracle.getSignedPrice()
      );
    });

    const finalCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    const bobBalanceAfter = Mina.getBalance(testHelper.agents.bob.account);

    expect(finalCollateral).toEqual(
      initialCollateral?.sub(TestAmounts.SMALL_COLLATERAL)
    );
    expect(bobBalanceAfter).toEqual(
      bobBalanceBefore.add(TestAmounts.SMALL_COLLATERAL)
    );
  });

  it('should track collateral correctly after multiple redemptions', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();

    // Perform multiple small redemptions
    for (let i = 0; i < 3; i++) {
      await redeemCollateral(TestAmounts.SMALL_COLLATERAL);
    }

    const finalCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    expect(finalCollateral).toEqual(
      initialCollateral?.sub(TestAmounts.SMALL_COLLATERAL.mul(3))
    );
  });

  it('should not create the protocol fee account update if there are no staking rewards', async () => {
    const txResult = await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.agents.alice.vault?.contract.redeemCollateral(
          TestAmounts.SMALL_COLLATERAL,
          testHelper.agents.alice.secret,
          testHelper.oracle.getSignedPrice()
        );
      }
    );

    // Check that no account update has a label containing 'ZkUsdProtocolVault'
    const hasProtocolVaultUpdate = txResult.transaction.accountUpdates.some(
      (update) => update.publicKey === testHelper.protocolVault.publicKey
    );
    expect(hasProtocolVaultUpdate).toBe(false);
  });

  it('should not increase the collateral amount with a normal send', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();

    await testHelper.sendRewardsToVault('alice', TestAmounts.SMALL_COLLATERAL);

    const finalCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();

    const vaultBalance = Mina.getBalance(
      testHelper.agents.alice.vault!.publicKey!
    );

    expect(finalCollateral).toEqual(initialCollateral);
    expect(vaultBalance).toEqual(
      initialCollateral?.add(TestAmounts.SMALL_COLLATERAL)
    );
  });

  it('should create the protocol vault account update if there are staking rewards', async () => {
    const txResult = await redeemCollateral(TestAmounts.SMALL_COLLATERAL);

    // Check that no account update has a label containing 'ZkUsdProtocolVault'
    const hasProtocolVaultUpdate = txResult.transaction.accountUpdates.some(
      (update) => update.publicKey.equals(testHelper.protocolVault.publicKey)
    );
    expect(hasProtocolVaultUpdate).toBe(true);
  });

  it('should send the correct fee to the protocol vault', async () => {
    //Send some more rewards to the vault
    await testHelper.sendRewardsToVault('alice', TestAmounts.SMALL_COLLATERAL);

    const collateralAmount =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();

    const aliceVaultBalance = Mina.getBalance(
      testHelper.agents.alice.vault!.publicKey!
    );

    const stakingRewards = aliceVaultBalance.sub(collateralAmount!);

    const protocolFee = stakingRewards
      .mul(ZkUsdVault.PROTOCOL_FEE)
      .div(ZkUsdVault.PROTOCOL_FEE_PRECISION);

    const protocolVaultBalanceBefore = Mina.getBalance(
      testHelper.protocolVault.publicKey
    );

    // Redeem some collateral
    await redeemCollateral(TestAmounts.SMALL_COLLATERAL);

    const protocolVaultBalanceAfter = Mina.getBalance(
      testHelper.protocolVault.publicKey
    );

    expect(protocolVaultBalanceAfter).toEqual(
      protocolFee.add(protocolVaultBalanceBefore)
    );
  });

  it('should send the correct accured staking rewards to the user minus the fee', async () => {
    // Send some rewards to the vault
    await testHelper.sendRewardsToVault('alice', TestAmounts.SMALL_COLLATERAL);

    const collateralAmount =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    const aliceBalanceBefore = Mina.getBalance(testHelper.agents.alice.account);
    const vaultBalanceBefore = Mina.getBalance(
      testHelper.agents.alice.vault!.publicKey!
    );

    // Calculate staking rewards and expected fee
    const stakingRewards = vaultBalanceBefore.sub(collateralAmount!);
    const protocolFee = stakingRewards
      .mul(ZkUsdVault.PROTOCOL_FEE)
      .div(ZkUsdVault.PROTOCOL_FEE_PRECISION);
    const expectedRewardsPayment = stakingRewards.sub(protocolFee);

    // Redeem a small amount of collateral
    await redeemCollateral(TestAmounts.SMALL_COLLATERAL);

    const aliceBalanceAfter = Mina.getBalance(testHelper.agents.alice.account);

    // Alice should receive:
    // 1. The redeemed collateral amount
    // 2. The staking rewards minus the protocol fee
    const expectedBalance = aliceBalanceBefore
      .add(TestAmounts.SMALL_COLLATERAL)
      .add(expectedRewardsPayment);

    expect(aliceBalanceAfter).toEqual(expectedBalance);
  });

  it('should fail redeeming if vault balance is zero', async () => {
    const vaultBalance = Mina.getBalance(
      testHelper.agents.bob.vault!.publicKey!
    );

    expect(vaultBalance).toEqual(TestAmounts.ZERO);

    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.agents.bob.vault?.contract.redeemCollateral(
          TestAmounts.ZERO,
          testHelper.agents.bob.secret,
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.BALANCE_ZERO);
  });
});
