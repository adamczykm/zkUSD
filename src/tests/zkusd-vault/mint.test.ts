import { TestHelper, TestAmounts } from '../test-helper';
import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  Signature,
  UInt32,
  UInt64,
} from 'o1js';
import { OraclePayload, ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault';

describe('zkUSD Vault Mint Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);

    //deploy alice's vault
    await testHelper.deployVaults(['alice']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.LARGE_COLLATERAL,
        testHelper.agents.alice.secret
      );
    });
  });

  it('should allow alice to mint zkUSD', async () => {
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        TestAmounts.MEDIUM_ZKUSD,
        testHelper.agents.alice.secret,
        testHelper.oracle.getSignedPrice()
      );
    });

    const aliceVault = testHelper.agents.alice.vault;
    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      aliceVault!.publicKey
    );
    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const debtAmount = testHelper.agents.alice.vault?.contract.debtAmount.get();

    expect(vaultBalance).toEqual(TestAmounts.MEDIUM_ZKUSD);
    expect(debtAmount).toEqual(TestAmounts.MEDIUM_ZKUSD);
    expect(aliceBalance).toEqual(TestAmounts.ZERO);
  });

  it('should track total debt correctly across multiple mint operations', async () => {
    const initialDebt =
      testHelper.agents.alice.vault?.contract.debtAmount.get();

    // Perform multiple small mints
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.mintZkUsd(
            TestAmounts.SMALL_ZKUSD,
            testHelper.agents.alice.secret,
            testHelper.oracle.getSignedPrice()
          );
        }
      );
    }

    const finalDebt = testHelper.agents.alice.vault?.contract.debtAmount.get();
    expect(finalDebt).toEqual(initialDebt?.add(TestAmounts.SMALL_ZKUSD.mul(3)));
  });

  it('should fail if oracle payload is signed with wrong private key', async () => {
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
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          TestAmounts.MEDIUM_ZKUSD,
          testHelper.agents.alice.secret,
          invalidPayload
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_ORACLE_SIG);
  });

  it('should fail if oracle payload is no longer valid', async () => {
    const LONG_BLOCKCHAIN_LENGTH = UInt32.from(999);

    const validPayload = testHelper.oracle.getSignedPrice();
    testHelper.Local.setBlockchainLength(LONG_BLOCKCHAIN_LENGTH);

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          TestAmounts.MEDIUM_ZKUSD,
          testHelper.agents.alice.secret,
          validPayload
        );
      })
    ).rejects.toThrow();
  });

  it('should fail if mint amount is zero', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          TestAmounts.ZERO,
          testHelper.agents.alice.secret,
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
  });

  it('should fail if mint amount is negative', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          UInt64.from(-1),
          testHelper.agents.alice.secret,
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow();
  });

  it('should fail if secret is invalid', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          TestAmounts.MEDIUM_ZKUSD,
          Field.random(),
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_SECRET);
  });

  it('should fail if health factor is too low', async () => {
    const LARGE_ZKUSD_AMOUNT = UInt64.from(1000e9); // Very large amount to ensure health factor violation

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          LARGE_ZKUSD_AMOUNT,
          testHelper.agents.alice.secret,
          testHelper.oracle.getSignedPrice()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW);
  });

  it('should maintain correct health factor after multiple mint operations', async () => {
    const initialCollateral =
      testHelper.agents.alice.vault?.contract.collateralAmount.get();
    let currentDebt = testHelper.agents.alice.vault?.contract.debtAmount.get();

    // Mint multiple times while checking health factor
    for (let i = 0; i < 3; i++) {
      const healthFactor =
        testHelper.agents.alice.vault?.contract.calculateHealthFactor(
          initialCollateral!,
          currentDebt!.add(TestAmounts.SMALL_ZKUSD),
          testHelper.oracle.getSignedPrice().price
        );

      // Only mint if health factor would remain above minimum
      if (healthFactor!.greaterThanOrEqual(ZkUsdVault.MIN_HEALTH_FACTOR)) {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.agents.alice.vault?.contract.mintZkUsd(
              TestAmounts.SMALL_ZKUSD,
              testHelper.agents.alice.secret,
              testHelper.oracle.getSignedPrice()
            );
          }
        );
        currentDebt = currentDebt?.add(TestAmounts.SMALL_ZKUSD);
      }
    }

    const finalHealthFactor =
      testHelper.agents.alice.vault?.contract.calculateHealthFactor(
        initialCollateral!,
        currentDebt!,
        testHelper.oracle.getSignedPrice().price
      );

    expect(
      finalHealthFactor!.greaterThanOrEqual(ZkUsdVault.MIN_HEALTH_FACTOR)
    ).toBeTruthy();
  });

  it('should allow bob to mint if he has the correct secret', async () => {
    console.log('Bobs publicKey', testHelper.agents.bob.account);

    const debtAmountBefore =
      testHelper.agents.alice.vault?.contract.debtAmount.get();
    const vaultBalanceBefore = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        TestAmounts.MEDIUM_ZKUSD,
        testHelper.agents.alice.secret,
        testHelper.oracle.getSignedPrice()
      );
    });

    const debtAmount = testHelper.agents.alice.vault?.contract.debtAmount.get();
    const vaultBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.vault!.publicKey
    );

    expect(debtAmount).toEqual(debtAmountBefore?.add(TestAmounts.MEDIUM_ZKUSD));
    expect(vaultBalance).toEqual(
      vaultBalanceBefore.add(TestAmounts.MEDIUM_ZKUSD)
    );
  });
});
