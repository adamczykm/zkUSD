import { TestHelper, TestAmounts } from './test-helper';
import { AccountUpdate, Bool, Mina, UInt64 } from 'o1js';
import { FungibleTokenErrors } from 'mina-fungible-token';
import { ZkUsdVault } from '../zkusd-vault';

describe('zkUSD Token Admin Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);
    await testHelper.deployVaults(['alice']);
  });

  describe('Minting Controls', () => {
    it('should not allow direct minting via token contract', async () => {
      await expect(
        testHelper.transaction(testHelper.agents.alice.account, async () => {
          await testHelper.token.contract.mint(
            testHelper.agents.alice.account,
            TestAmounts.SMALL_ZKUSD
          );
        })
      ).rejects.toThrow();
    });

    it('should not allow minting with token admin key', async () => {
      await expect(
        testHelper.transaction(
          testHelper.deployer,
          async () => {
            await testHelper.token.contract.mint(
              testHelper.agents.alice.account,
              TestAmounts.SMALL_ZKUSD
            );
          },
          {
            extraSigners: [testHelper.tokenAdmin.privateKey],
          }
        )
      ).rejects.toThrow();
    });

    it('should allow minting via vault with correct interaction flag', async () => {
      const flag = testHelper.agents.alice.vault?.contract.mintFlag.get();

      // First deposit collateral to allow minting
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.depositCollateral(
            TestAmounts.LARGE_COLLATERAL,
            testHelper.agents.alice.secret
          );
        }
      );

      // Then try to mint through the vault
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
          await testHelper.agents.alice.vault?.contract.mintZkUsd(
            TestAmounts.MEDIUM_ZKUSD,
            testHelper.agents.alice.secret,
            testHelper.oracle.getSignedPrice()
          );
        },
        {
          printTx: true,
        }
      );

      const balance = await testHelper.token.contract.getBalanceOf(
        testHelper.agents.alice.vault!.publicKey
      );
      expect(balance).toEqual(TestAmounts.MEDIUM_ZKUSD);
    });

    it('should reset interaction flag after minting', async () => {
      const flag = testHelper.agents.alice.vault?.contract.mintFlag.get();

      expect(flag).toEqual(Bool(false));
    });
  });

  describe('Burning Controls', () => {
    beforeAll(async () => {
      //withdraw the zkUsd we have in the vault from the previous test
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
          await testHelper.agents.alice.vault?.contract.withdrawZkUsd(
            TestAmounts.MEDIUM_ZKUSD,
            testHelper.agents.alice.secret
          );
        },
        {
          extraSigners: [testHelper.agents.alice.vault!.privateKey],
        }
      );
    });

    it('should allow direct burning via token contract', async () => {
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.token.contract.burn(
            testHelper.agents.alice.account,
            TestAmounts.SMALL_ZKUSD
          );
        },
        {
          printTx: true,
        }
      );
    });
  });

  describe('Admin Controls', () => {
    it('should not allow changing admin', async () => {
      await expect(
        testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.setAdmin(
            testHelper.agents.bob.account
          );
        })
      ).rejects.toThrow(FungibleTokenErrors.noPermissionToChangeAdmin);
    });

    it('should not allow pausing', async () => {
      await expect(
        testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.pause();
        })
      ).rejects.toThrow(FungibleTokenErrors.noPermissionToPause);
    });

    it('should not allow resuming', async () => {
      await expect(
        testHelper.transaction(testHelper.deployer, async () => {
          await testHelper.token.contract.resume();
        })
      ).rejects.toThrow(FungibleTokenErrors.noPermissionToResume);
    });
  });
});
