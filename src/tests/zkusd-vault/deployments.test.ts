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

  it('should deploy vault with empty state', async () => {
    await testHelper.deployVaults(['alice']);

    const aliceVault = testHelper.agents.alice.vault;

    const collateralAmount = aliceVault?.contract.collateralAmount.get();
    const debtAmount = aliceVault?.contract.debtAmount.get();

    expect(collateralAmount).toEqual(TestAmounts.ZERO);
    expect(debtAmount).toEqual(TestAmounts.ZERO);
  });

  it('should deploy multiple vaults', async () => {
    await testHelper.deployVaults(['alice', 'bob', 'charlie', 'david', 'eve']);

    const aliceVault = testHelper.agents.alice.vault;
    const bobVault = testHelper.agents.bob.vault;
    const charlieVault = testHelper.agents.charlie.vault;
    const davidVault = testHelper.agents.david.vault;
    const eveVault = testHelper.agents.eve.vault;

    expect(aliceVault).not.toBeNull();
    expect(bobVault).not.toBeNull();
    expect(charlieVault).not.toBeNull();
    expect(davidVault).not.toBeNull();
    expect(eveVault).not.toBeNull();
  });
});
