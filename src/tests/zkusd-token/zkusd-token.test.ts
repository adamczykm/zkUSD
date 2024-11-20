import { TestHelper, TestAmounts } from '../test-helper';
import { AccountUpdate, Bool, Mina, UInt64 } from 'o1js';
import { FungibleTokenErrors } from 'mina-fungible-token';
import { ZkUsdVault } from '../../zkusd-vault';

describe('zkUSD Token Test Suite', () => {
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

      // First deposit collateral to allow minting
      await testHelper.transaction(
        testHelper.agents.alice.account,
        async () => {
          await testHelper.agents.alice.vault?.contract.depositCollateral(
            TestAmounts.COLLATERAL_100_MINA,
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
});
