import { TestHelper, TestAmounts } from '../test-helper';
import {
  AccountUpdate,
  AccountUpdateForest,
  Bool,
  Int64,
  Mina,
  UInt64,
  UInt8,
} from 'o1js';
import { ZkUsdVault } from '../../zkusd-vault';
import { ZkUsdTokenErrors } from '../../zkusd-token';

describe('zkUSD Token Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);
    await testHelper.deployVaults(['alice', 'bob']);

    // First deposit collateral to allow minting
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_900_MINA,
        testHelper.agents.alice.secret
      );
    });

    // First deposit collateral to allow minting
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.agents.bob.vault?.contract.depositCollateral(
        TestAmounts.COLLATERAL_900_MINA,
        testHelper.agents.bob.secret
      );
    });
  });

  describe('Token Initialization', () => {
    it('should not allow re-initialization of token', async () => {
      await expect(
        testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.initialize(UInt8.from(9));
        })
      ).rejects.toThrow();
    });
  });

  describe('Minting Controls', () => {
    it('should not allow direct minting via token contract', async () => {
      await expect(
        testHelper.transaction(testHelper.agents.alice.account, async () => {
          const accountUpdate = AccountUpdate.create(
            testHelper.agents.alice.vault!.publicKey
          );
          await testHelper.token.contract.mint(
            testHelper.agents.alice.account,
            TestAmounts.DEBT_1_ZKUSD,
            accountUpdate
          );
        })
      ).rejects.toThrow();
    });

    it('should not allow minting with token private key', async () => {
      await expect(
        testHelper.transaction(
          testHelper.deployer,
          async () => {
            const accountUpdate = AccountUpdate.create(
              testHelper.agents.alice.vault!.publicKey
            );
            await testHelper.token.contract.mint(
              testHelper.agents.alice.account,
              TestAmounts.DEBT_1_ZKUSD,
              accountUpdate
            );
          },
          {
            extraSigners: [testHelper.token.privateKey],
          }
        )
      ).rejects.toThrow();
    });

    it('should allow minting via vault with correct interaction flag', async () => {
      const flag =
        await testHelper.agents.alice.vault?.contract.interactionFlag.fetch();

      // Then try to mint through the vault
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
          await testHelper.agents.alice.vault?.contract.mintZkUsd(
            testHelper.agents.alice.account,
            TestAmounts.DEBT_5_ZKUSD,
            testHelper.agents.alice.secret
          );
        }
      );

      const balance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
      expect(balance).toEqual(TestAmounts.DEBT_5_ZKUSD);
    });

    it('should reset interaction flag after minting', async () => {
      const flag =
        await testHelper.agents.alice.vault?.contract.interactionFlag.fetch();

      expect(flag).toEqual(Bool(false));
    });
  });

  describe('Burning Controls', () => {
    it('should  allow direct burning via token contract', async () => {
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
          await testHelper.agents.alice.vault?.contract.mintZkUsd(
            testHelper.agents.alice.account,
            TestAmounts.DEBT_5_ZKUSD,
            testHelper.agents.alice.secret
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
          AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
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

      expect(finalBalanceSender).toEqual(
        initialBalanceSender.sub(TestAmounts.DEBT_1_ZKUSD)
      );
      expect(finalBalanceReceiver).toEqual(
        initialBalanceReceiver.add(TestAmounts.DEBT_1_ZKUSD)
      );
    });

    it('should reject transfer without sender signature', async () => {
      await expect(
        testHelper.transaction(testHelper.agents.bob.account, async () => {
          await testHelper.token.contract.transfer(
            testHelper.agents.alice.account,
            testHelper.agents.bob.account,
            TestAmounts.DEBT_1_ZKUSD
          );
        })
      ).rejects.toThrow();
    });

    it('should reject transfer to/from circulation account', async () => {
      await expect(
        testHelper.transaction(testHelper.agents.alice.account, async () => {
          await testHelper.token.contract.transfer(
            testHelper.agents.alice.account,
            testHelper.token.publicKey,
            TestAmounts.DEBT_1_ZKUSD
          );
        })
      ).rejects.toThrow(ZkUsdTokenErrors.NO_XFER_FROM_CIRC);

      await expect(
        testHelper.transaction(testHelper.agents.alice.account, async () => {
          await testHelper.token.contract.transfer(
            testHelper.token.publicKey,
            testHelper.agents.alice.account,
            TestAmounts.DEBT_1_ZKUSD
          );
        })
      ).rejects.toThrow(ZkUsdTokenErrors.NO_XFER_FROM_CIRC);
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
      ).negV2();

      const updateReceive = AccountUpdate.create(
        testHelper.agents.bob.account,
        testHelper.token.contract.deriveTokenId()
      );
      updateReceive.balanceChange = Int64.fromUnsigned(
        TestAmounts.DEBT_5_ZKUSD
      );

      await expect(
        testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.approveBase(
            AccountUpdateForest.fromFlatArray([updateSend, updateReceive])
          );
        })
      ).rejects.toThrow(/Flash-minting or unbalanced transaction detected/i);
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

      await expect(
        testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.approveBase(
            AccountUpdateForest.fromFlatArray([updateReceive, updateSend])
          );
        })
      ).rejects.toThrow(ZkUsdTokenErrors.FLASH_MINTING);
    });
  });

  describe('Token State Queries', () => {
    it('should return correct decimals', async () => {
      const decimals = await testHelper.token.contract.getDecimals();
      expect(decimals).toEqual(UInt8.from(9));
    });

    it('should track circulating supply correctly', async () => {
      // First mint some tokens to alice
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.mintZkUsd(
            testHelper.agents.alice.account,
            TestAmounts.DEBT_50_ZKUSD,
            testHelper.agents.alice.secret
          );
        }
      );

      // Then mint some tokens to bob
      await testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.agents.bob.vault?.contract.mintZkUsd(
          testHelper.agents.bob.account,
          TestAmounts.DEBT_30_ZKUSD,
          testHelper.agents.bob.secret
        );
      });

      // Get individual balances
      const aliceBalance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
      const bobBalance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.bob.account
      );

      // Get total circulating supply
      const circulatingSupply =
        await testHelper.token.contract.getCirculating();

      // Verify individual balances add up to total supply
      expect(circulatingSupply).toEqual(aliceBalance.add(bobBalance));

      // Burn some tokens from alice
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.token.contract.burn(
            testHelper.agents.alice.account,
            TestAmounts.DEBT_10_ZKUSD
          );
        }
      );

      // Get updated circulating supply
      const updatedCirculatingSupply =
        await testHelper.token.contract.getCirculating();

      // Verify supply decreased by burned amount
      expect(updatedCirculatingSupply).toEqual(
        circulatingSupply.sub(TestAmounts.DEBT_10_ZKUSD)
      );
    });

    it('should track circulating supply correctly after transfers', async () => {
      const initialSupply = await testHelper.token.contract.getCirculating();

      // Transfer from alice to bob
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.token.contract.transfer(
            testHelper.agents.alice.account,
            testHelper.agents.bob.account,
            TestAmounts.DEBT_5_ZKUSD
          );
        }
      );

      const supplyAfterTransfer =
        await testHelper.token.contract.getCirculating();

      // Verify supply remains unchanged after transfer
      expect(supplyAfterTransfer).toEqual(initialSupply);

      // Get individual balances and verify they add up to total supply
      const aliceBalance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.account
      );
      const bobBalance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.bob.account
      );

      expect(supplyAfterTransfer).toEqual(aliceBalance.add(bobBalance));
    });
  });
});
