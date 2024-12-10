import { TestHelper, TestAmounts } from '../test-helper.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import {
  AccountUpdate,
  AccountUpdateForest,
  Bool,
  Field,
  Int64,
  Mina,
  UInt64,
  UInt8,
} from 'o1js';
import { ZkUsdVault } from '../../zkusd-vault.js';
import { FungibleTokenErrors } from '@minatokens/token';

describe('zkUSD Token Test Suite', () => {
  const testHelper = new TestHelper();

  before(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);
    await testHelper.createVaults(['alice', 'bob']);

    // First deposit collateral to allow minting
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.alice.vault!.publicKey,
        TestAmounts.COLLATERAL_900_MINA
      );
    });

    // First deposit collateral to allow minting
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.engine.contract.depositCollateral(
        testHelper.agents.bob.vault!.publicKey,
        TestAmounts.COLLATERAL_900_MINA
      );
    });
  });

  describe('Token Initialization', () => {
    it('should not allow re-initialization of token', async () => {
      await assert.rejects(async () => {
        await testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.initialize(
            TestHelper.engineKeyPair.publicKey,
            UInt8.from(9),
            Bool(false)
          );
        });
      });
    });
  });

  describe('Minting Controls', () => {
    it('should not allow direct minting via token contract', async () => {
      await assert.rejects(async () => {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            const accountUpdate = AccountUpdate.create(
              testHelper.agents.alice.vault!.publicKey
            );
            await testHelper.token.contract.mint(
              testHelper.agents.alice.account,
              TestAmounts.DEBT_1_ZKUSD
            );
          }
        );
      });
    });

    it('should not allow minting with token private key', async () => {
      await assert.rejects(async () => {
        await testHelper.transaction(
          testHelper.deployer,
          async () => {
            const accountUpdate = AccountUpdate.create(
              testHelper.agents.alice.vault!.publicKey
            );
            await testHelper.token.contract.mint(
              testHelper.agents.alice.account,
              TestAmounts.DEBT_1_ZKUSD
            );
          },
          {
            extraSigners: [testHelper.token.privateKey],
          }
        );
      });
    });

    it('should allow minting via vault with correct interaction flag', async () => {
      const flag = await testHelper.engine.contract.interactionFlag.fetch();

      // Then try to mint through the vault
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.mintZkUsd(
            testHelper.agents.alice.vault!.publicKey,
            TestAmounts.DEBT_5_ZKUSD
          );
        }
      );

      const balance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
      assert.deepStrictEqual(balance, TestAmounts.DEBT_5_ZKUSD);
    });

    it('should reset interaction flag after minting', async () => {
      const flag = await testHelper.engine.contract.interactionFlag.fetch();
      assert.deepStrictEqual(flag, Bool(false));
    });
  });

  describe('Burning Controls', () => {
    it('should allow direct burning via token contract', async () => {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.token.contract.burn(
            testHelper.agents.alice.account,
            TestAmounts.DEBT_1_ZKUSD
          );
        }
      );
    });
  });

  describe('Transfer Controls', () => {
    it('should allow transfer between accounts', async () => {
      // First mint some tokens to alice
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.mintZkUsd(
            testHelper.agents.alice.vault!.publicKey,
            TestAmounts.DEBT_5_ZKUSD
          );
        }
      );

      const initialBalanceSender = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
      const initialBalanceReceiver =
        await testHelper.token.contract.getBalanceOf(
          testHelper.agents.bob.account
        );

      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.token.contract.transfer(
            testHelper.agents.alice.account,
            testHelper.agents.bob.account,
            TestAmounts.DEBT_1_ZKUSD
          );
        }
      );

      const finalBalanceSender = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
      const finalBalanceReceiver = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.bob.account
      );

      assert.deepStrictEqual(
        finalBalanceSender,
        initialBalanceSender.sub(TestAmounts.DEBT_1_ZKUSD)
      );
      assert.deepStrictEqual(
        finalBalanceReceiver,
        initialBalanceReceiver.add(TestAmounts.DEBT_1_ZKUSD)
      );
    });

    it('should reject transfer without sender signature', async () => {
      await assert.rejects(async () => {
        await testHelper.transaction(
          testHelper.agents.bob.account,
          async () => {
            await testHelper.token.contract.transfer(
              testHelper.agents.alice.account,
              testHelper.agents.bob.account,
              TestAmounts.DEBT_1_ZKUSD
            );
          }
        );
      });
    });

    it('should reject transfer to/from circulation account', async () => {
      await assert.rejects(async () => {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.token.contract.transfer(
              testHelper.agents.alice.account,
              testHelper.token.publicKey,
              TestAmounts.DEBT_1_ZKUSD
            );
          }
        );
      }, new RegExp(FungibleTokenErrors.noTransferFromCirculation));

      await assert.rejects(async () => {
        await testHelper.transaction(
          testHelper.agents.alice.account,
          async () => {
            await testHelper.token.contract.transfer(
              testHelper.token.publicKey,
              testHelper.agents.alice.account,
              TestAmounts.DEBT_1_ZKUSD
            );
          }
        );
      }, new RegExp(FungibleTokenErrors.noTransferFromCirculation));
    });
  });

  describe('Account Updates', () => {
    it('should reject unbalanced token updates', async () => {
      const updateSend = AccountUpdate.createSigned(
        testHelper.agents.alice.account,
        testHelper.token.contract.deriveTokenId()
      );
      updateSend.balanceChange = Int64.fromUnsigned(
        TestAmounts.DEBT_1_ZKUSD
      ).neg();

      const updateReceive = AccountUpdate.create(
        testHelper.agents.bob.account,
        testHelper.token.contract.deriveTokenId()
      );
      updateReceive.balanceChange = Int64.fromUnsigned(
        TestAmounts.DEBT_5_ZKUSD
      );

      await assert.rejects(async () => {
        await testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.approveBase(
            AccountUpdateForest.fromFlatArray([updateSend, updateReceive])
          );
        });
      }, /Flash-minting or unbalanced transaction detected/i);
    });

    it('should reject flash-minting attempts', async () => {
      const updateReceive = AccountUpdate.create(
        testHelper.agents.bob.account,
        testHelper.token.contract.deriveTokenId()
      );
      updateReceive.balanceChange = Int64.fromUnsigned(
        TestAmounts.DEBT_1_ZKUSD
      );

      const updateSend = AccountUpdate.createSigned(
        testHelper.agents.alice.account,
        testHelper.token.contract.deriveTokenId()
      );
      updateSend.balanceChange = Int64.fromUnsigned(
        TestAmounts.DEBT_1_ZKUSD
      ).neg();

      await assert.rejects(async () => {
        await testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.approveBase(
            AccountUpdateForest.fromFlatArray([updateReceive, updateSend])
          );
        });
      }, new RegExp(FungibleTokenErrors.flashMinting));
    });
  });

  describe('Token State Queries', () => {
    it('should return correct decimals', async () => {
      const decimals = await testHelper.token.contract.getDecimals();
      assert.deepStrictEqual(decimals, UInt8.from(9));
    });

    it('should track circulating supply correctly', async () => {
      // First mint some tokens to alice
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.engine.contract.mintZkUsd(
            testHelper.agents.alice.vault!.publicKey,
            TestAmounts.DEBT_50_ZKUSD
          );
        }
      );

      // Then mint some tokens to bob
      await testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.engine.contract.mintZkUsd(
          testHelper.agents.bob.vault!.publicKey,
          TestAmounts.DEBT_30_ZKUSD
        );
      });

      const aliceBalance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
      const bobBalance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.bob.account
      );

      const circulatingSupply =
        await testHelper.token.contract.getCirculating();

      assert.deepStrictEqual(circulatingSupply, aliceBalance.add(bobBalance));
    });
  });
});
