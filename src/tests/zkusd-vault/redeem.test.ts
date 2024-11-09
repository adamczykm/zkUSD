import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Field, Mina, PrivateKey, Signature } from 'o1js';
import { OraclePayload, ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Redeem Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie', 'rewards']);

    //deploy alice's vault
    await testHelper.deployVaults(['alice']);

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

  it('should allow alice to redeem collateral', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    const aliceBalanceBefore = Mina.getBalance(testHelper.agents.alice.account);

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.redeemCollateral(
        TestAmounts.SMALL_COLLATERAL,
        testHelper.agents.alice.secret,
        testHelper.oracle.getSignedPrice()
      );
    });

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

  it('should fail if redemption amount is zero', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.redeemCollateral(
          TestAmounts.ZERO,
          testHelper.agents.alice.secret,
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
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
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.redeemCollateral(
          TestAmounts.LARGE_COLLATERAL, // Try to withdraw all collateral
          testHelper.agents.alice.secret,
          testHelper.oracle.getSignedPrice()
        );
      })
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
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.redeemCollateral(
          currentCollateral!, // Try to withdraw all collateral
          testHelper.agents.alice.secret,
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW);
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
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.redeemCollateral(
            TestAmounts.SMALL_COLLATERAL,
            testHelper.agents.alice.secret,
            testHelper.oracle.getSignedPrice()
          );
        }
      );
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

    await testHelper.transaction(
      testHelper.agents.rewards.account,
      async () => {
        let rewardsDistribution = AccountUpdate.createSigned(
          testHelper.agents.rewards.account
        );

        rewardsDistribution.send({
          to: testHelper.agents.alice.vault!.publicKey!,
          amount: TestAmounts.SMALL_COLLATERAL,
        });
      }
    );

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

  it('should create the protocol fee account update if there are staking rewards', async () => {
    const txResult = await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.agents.alice.vault?.contract.redeemCollateral(
          TestAmounts.SMALL_COLLATERAL,
          testHelper.agents.alice.secret,
          testHelper.oracle.getSignedPrice()
        );
        //Does the Protocol Vault have to approve this?
      },
      {
        printTx: true,
      }
    );

    // Check that no account update has a label containing 'ZkUsdProtocolVault'
    const hasProtocolVaultUpdate = txResult.transaction.accountUpdates.some(
      (update) => update.publicKey.equals(testHelper.protocolVault.publicKey)
    );
    expect(hasProtocolVaultUpdate).toBe(true);
  });
});
