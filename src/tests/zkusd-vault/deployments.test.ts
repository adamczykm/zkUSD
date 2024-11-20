import { TestHelper, TestAmounts } from '../test-helper';

describe('zkUSD Deployment Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob', 'charlie', 'david', 'eve']);
  });

  it('should deploy token contracts', async () => {
    const tokenAccount = testHelper.Local.getAccount(
      testHelper.token.publicKey
    );

    expect(tokenAccount.tokenSymbol).toEqual('zkUSD');
  });

  it('should deploy vaults', async () => {
    await testHelper.deployVaults(['alice']);

    const aliceVault = testHelper.Local.getAccount(
      testHelper.agents.alice.vault?.publicKey!
    );

    expect(aliceVault).not.toBeNull();
  });

  it('should fail to deploy the same vault twice', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.agents.alice.vault?.contract.deploy({
          secret: testHelper.agents.alice.secret,
        });
      })
    ).rejects.toThrow(
      /Transaction verification failed: Cannot update field 'verificationKey' because permission for this field is 'Impossible'/i
    );
  });

  it('should deploy vault with empty state', async () => {
    const aliceVault = testHelper.agents.alice.vault;

    const collateralAmount =
      await aliceVault?.contract.collateralAmount.fetch();
    const debtAmount = await aliceVault?.contract.debtAmount.fetch();

    expect(collateralAmount).toEqual(TestAmounts.ZERO);
    expect(debtAmount).toEqual(TestAmounts.ZERO);
  });

  it('should deploy multiple vaults', async () => {
    await testHelper.deployVaults(['bob', 'charlie', 'david', 'eve']);

    const bobVault = testHelper.agents.bob.vault;
    const charlieVault = testHelper.agents.charlie.vault;
    const davidVault = testHelper.agents.david.vault;
    const eveVault = testHelper.agents.eve.vault;

    expect(bobVault).not.toBeNull();
    expect(charlieVault).not.toBeNull();
    expect(davidVault).not.toBeNull();
    expect(eveVault).not.toBeNull();
  });
});
