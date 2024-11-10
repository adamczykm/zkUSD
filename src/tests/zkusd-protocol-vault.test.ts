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
} from 'o1js';

class ZkUsdProtocolVaultV2 extends SmartContract {
  @state(PublicKey) owner = State<PublicKey>();
  // Added new state variable to demonstrate upgrade
  @state(UInt64) protocolFee = State<UInt64>();

  async deploy(args: DeployArgs) {
    await super.deploy(args);
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey: Permissions.VerificationKey.proofOrSignature(),
      setPermissions: Permissions.impossible(),
    });
    this.owner.set(this.sender.getAndRequireSignatureV2());
  }

  private assertOwner() {
    const currentOwner = this.owner.getAndRequireEquals();
    const sender = this.sender.getAndRequireSignatureV2();
    sender.assertEquals(currentOwner);
  }

  @method
  async updateVerificationKey(vk: VerificationKey) {
    this.assertOwner();
    this.account.verificationKey.set(vk);
  }

  @method async withdraw(amount: UInt64) {
    this.assertOwner();
    this.send({ to: this.sender.getUnconstrainedV2(), amount });
  }

  @method async updateOwner(newOwner: PublicKey) {
    this.assertOwner();
    this.owner.set(newOwner);
  }

  // New method to demonstrate upgrade
  @method async setProtocolFee(fee: UInt64) {
    this.assertOwner();
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
    await testHelper.sendRewardsToVault('alice', TestAmounts.MEDIUM_COLLATERAL);

    //Alice redeems the rewards, earning the protocol fee
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.agents.alice.vault?.contract.redeemCollateral(
        TestAmounts.ZERO,
        testHelper.agents.alice.secret,
        testHelper.oracle.getSignedPrice()
      );
    });
  });

  it('should have the correct balance', async () => {
    const balance = Mina.getBalance(testHelper.protocolVault.publicKey);

    const protocolFee = TestAmounts.MEDIUM_COLLATERAL.mul(
      ZkUsdVault.PROTOCOL_FEE
    ).div(ZkUsdVault.PROTOCOL_FEE_PRECISION);

    expect(balance).toEqual(protocolFee);
  });

  it('should allow owner to withdraw funds', async () => {
    const ownerBalanceBefore = Mina.getBalance(testHelper.deployer);
    const vaultBalanceBefore = Mina.getBalance(
      testHelper.protocolVault.publicKey
    );

    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.protocolVault.contract.withdraw(
        TestAmounts.SMALL_COLLATERAL
      );
    });

    const ownerBalanceAfter = Mina.getBalance(testHelper.deployer);
    const vaultBalanceAfter = Mina.getBalance(
      testHelper.protocolVault.publicKey
    );

    expect(vaultBalanceAfter).toEqual(
      vaultBalanceBefore.sub(TestAmounts.SMALL_COLLATERAL)
    );
    expect(ownerBalanceAfter).toEqual(
      ownerBalanceBefore.add(TestAmounts.SMALL_COLLATERAL)
    );
  });

  it('should not allow non-owner to withdraw funds', async () => {
    // First send some funds to the protocol vault

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.protocolVault.contract.withdraw(
          TestAmounts.SMALL_COLLATERAL
        );
      })
    ).rejects.toThrow(/assertEquals/i);
  });

  it('should not allow non-owner to update owner', async () => {
    const newOwner = testHelper.agents.bob.account;

    await expect(
      testHelper.transaction(testHelper.agents.bob.account, async () => {
        await testHelper.protocolVault.contract.updateOwner(newOwner);
      })
    ).rejects.toThrow(/assertEquals/i);
  });

  it('should not allow owner to withdraw more than balance', async () => {
    const vaultBalance = Mina.getBalance(testHelper.protocolVault.publicKey);
    const excessiveAmount = vaultBalance.add(TestAmounts.SMALL_COLLATERAL);

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.protocolVault.contract.withdraw(excessiveAmount);
      })
    ).rejects.toThrow();
  });

  it('should allow owner to update owner', async () => {
    const newOwner = testHelper.agents.bob.account;
    const oldOwner = testHelper.protocolVault.contract.owner.get();

    expect(oldOwner.toBase58()).toEqual(testHelper.deployer.toBase58());

    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.protocolVault.contract.updateOwner(newOwner);
    });

    const updatedOwner = testHelper.protocolVault.contract.owner.get();
    expect(updatedOwner.toBase58()).not.toEqual(oldOwner.toBase58());
    expect(updatedOwner.toBase58()).toEqual(newOwner.toBase58());
  });

  it('should not allow non-owner to update verification key', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.protocolVault.contract.updateVerificationKey(
          newVerificationKey
        );
      })
    ).rejects.toThrow(/assertEquals/i);
  });

  // Update the verification key tests:
  it('should allow owner to update verification key', async () => {
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await testHelper.protocolVault.contract.updateVerificationKey(
        newVerificationKey
      );
    });

    // Verify we can use V2 functionality after upgrade
    const zkAppV2 = new ZkUsdProtocolVaultV2(
      testHelper.protocolVault.publicKey
    );
    await testHelper.transaction(testHelper.agents.bob.account, async () => {
      await zkAppV2.setProtocolFee(UInt64.from(1000));
    });
  });
});
