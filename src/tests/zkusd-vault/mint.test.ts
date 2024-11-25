import { TestHelper, TestAmounts } from '../test-helper';
import {
  AccountUpdate,
  Bool,
  DeployArgs,
  Field,
  method,
  Mina,
  PrivateKey,
  Provable,
  PublicKey,
  Signature,
  SmartContract,
  state,
  State,
  UInt32,
  UInt64,
} from 'o1js';
import { ZkUsdVault, ZkUsdVaultErrors } from '../../zkusd-vault';
import { ZkUsdPriceFeedOracleErrors } from '../../zkusd-price-feed-oracle';
import { ZkUsdToken, ZkUsdTokenErrors } from '../../zkusd-token';

class FakeZkUsdVault extends SmartContract {
  static ZKUSD_TOKEN_ADDRESS = PublicKey.fromBase58(
    'B62qry2wngUSGZqQn9erfnA9rZPn4cMbDG1XPasGdK1EtKQAxmgjDtt'
  );

  async deploy(args: DeployArgs & {}) {
    await super.deploy(args);
    // Set permissions to prevent unauthorized updates
  }

  @method async mint(amount: UInt64) {
    // Get the zkUSD token contract
    const zkUSD = new ZkUsdToken(FakeZkUsdVault.ZKUSD_TOKEN_ADDRESS);

    // Try to mint tokens directly without any assertions
    await zkUSD.mint(this.sender.getUnconstrainedV2(), amount, this.self);
  }

  // This flag is set so the zkUSD Admin contract can check its permissions
  @method.returns(Bool)
  public async assertInteractionFlag() {
    return Bool(true);
  }
}

describe('zkUSD Vault Mint Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);

    if (TestHelper.proofsEnabled) {
      await FakeZkUsdVault.compile();
    }

    //deploy alice's vault
    await testHelper.deployVaults(['alice']);

    //Alice deposits 100 Mina
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_100_MINA,
        testHelper.agents.alice.secret
      );
    });
  });

  it('should allow alice to mint zkUSD', async () => {
    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          testHelper.agents.alice.account,
          TestAmounts.DEBT_5_ZKUSD,
          testHelper.agents.alice.secret
        );
      },
      {
        printTx: true,
      }
    );

    const aliceBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.alice.account
    );

    const debtAmount =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    expect(debtAmount).toEqual(TestAmounts.DEBT_5_ZKUSD);
    expect(aliceBalance).toEqual(TestAmounts.DEBT_5_ZKUSD);
  });

  it('should track total debt correctly across multiple mint operations', async () => {
    const initialDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    // Perform multiple small mints
    for (let i = 0; i < 3; i++) {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.mintZkUsd(
            testHelper.agents.alice.account,
            TestAmounts.DEBT_1_ZKUSD,
            testHelper.agents.alice.secret
          );
        }
      );
    }

    const finalDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    expect(finalDebt).toEqual(
      initialDebt?.add(TestAmounts.DEBT_1_ZKUSD.mul(3))
    );
  });

  it('should fail if mint amount is zero', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          testHelper.agents.alice.account,
          TestAmounts.ZERO,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.AMOUNT_ZERO);
  });

  it('should fail if mint amount is negative', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          testHelper.agents.alice.account,
          UInt64.from(-1),
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow();
  });

  it('should fail if secret is invalid', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          testHelper.agents.alice.account,
          TestAmounts.DEBT_5_ZKUSD,
          Field.random()
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.INVALID_SECRET);
  });

  it('should fail if health factor is too low', async () => {
    const LARGE_ZKUSD_AMOUNT = UInt64.from(1000e9); // Very large amount to ensure health factor violation

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          testHelper.agents.alice.account,
          LARGE_ZKUSD_AMOUNT,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdVaultErrors.HEALTH_FACTOR_TOO_LOW);
  });

  it('should maintain correct health factor after multiple mint operations', async () => {
    const initialCollateral =
      await testHelper.agents.alice.vault?.contract.collateralAmount.fetch();
    let currentDebt =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();

    // Mint multiple times while checking health factor
    for (let i = 0; i < 3; i++) {
      const healthFactor =
        testHelper.agents.alice.vault?.contract.calculateHealthFactor(
          initialCollateral!,
          currentDebt!.add(TestAmounts.DEBT_1_ZKUSD),
          await testHelper.priceFeedOracle.contract.getPrice()
        );

      // Only mint if health factor would remain above minimum
      if (healthFactor!.greaterThanOrEqual(ZkUsdVault.MIN_HEALTH_FACTOR)) {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.agents.alice.vault?.contract.mintZkUsd(
              testHelper.agents.alice.account,
              TestAmounts.DEBT_1_ZKUSD,
              testHelper.agents.alice.secret
            );
          }
        );
        currentDebt = currentDebt?.add(TestAmounts.DEBT_1_ZKUSD);
      }
    }

    const finalHealthFactor =
      testHelper.agents.alice.vault?.contract.calculateHealthFactor(
        initialCollateral!,
        currentDebt!,
        await testHelper.priceFeedOracle.contract.getPrice()
      );

    expect(
      finalHealthFactor!.greaterThanOrEqual(ZkUsdVault.MIN_HEALTH_FACTOR)
    ).toBeTruthy();
  });

  it('should allow bob to mint if he has the correct secret', async () => {
    const debtAmountBefore =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    const bobBalanceBefore = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.bob.account
    );

    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      AccountUpdate.fundNewAccount(testHelper.agents.bob.account, 1);
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        testHelper.agents.bob.account,
        TestAmounts.DEBT_5_ZKUSD,
        testHelper.agents.alice.secret
      );
    });

    const debtAmount =
      await testHelper.agents.alice.vault?.contract.debtAmount.fetch();
    const bobBalance = await testHelper.token.contract.getBalanceOf(
      testHelper.agents.bob.account
    );

    expect(debtAmount).toEqual(debtAmountBefore?.add(TestAmounts.DEBT_5_ZKUSD));
    expect(bobBalance).toEqual(bobBalanceBefore.add(TestAmounts.DEBT_5_ZKUSD));
  });

  /*
   *
   *   IMPORTANT: THIS TEST NEEDS TO BE TRIPLE AND QUADRUPLE CHECKED
   *   IS THE ACCOUNT APP STATE PRECONDITION UNSATISFIED THE RIGHT ERROR
   *   TO EXPECT?
   */
  it('should not allow minting from unauthorized contracts', async () => {
    let fakeVault: FakeZkUsdVault;
    // Deploy the fake vault
    const sender = testHelper.agents.alice.account;
    const zkUsdTokenAddress = testHelper.token.contract.address;

    const fakeKeyPair = PrivateKey.randomKeypair();
    const fakePublicKey = fakeKeyPair.publicKey;

    fakeVault = new FakeZkUsdVault(fakePublicKey);

    await testHelper.transaction(
      sender,
      async () => {
        AccountUpdate.fundNewAccount(sender, 1);
        await fakeVault.deploy({});
      },
      {
        extraSigners: [fakeKeyPair.privateKey],
      }
    );

    // Attempt to mint tokens from the fake vault

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await fakeVault.mint(UInt64.from(1000e9));
      })
    ).rejects.toThrow(ZkUsdTokenErrors.INVALID_VAULT); // This should fail as the token admin should reject unauthorized mints
  });

  it('Should fail if the price feed is in emergency mode', async () => {
    await testHelper.stopTheProtocol();

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.mintZkUsd(
          testHelper.agents.alice.account,
          TestAmounts.DEBT_5_ZKUSD,
          testHelper.agents.alice.secret
        );
      })
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.EMERGENCY_HALT);
  });

  it('Should allow minting if the price feed is resumed', async () => {
    await testHelper.resumeTheProtocol();

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.mintZkUsd(
        testHelper.agents.alice.account,
        TestAmounts.DEBT_5_ZKUSD,
        testHelper.agents.alice.secret
      );
    });
  });
});
