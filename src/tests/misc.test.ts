import { TestHelper } from './test-helper';
import {
  AccountUpdate,
  Bool,
  DeployArgs,
  Field,
  method,
  Permissions,
  PrivateKey,
  PublicKey,
  SmartContract,
  state,
  State,
  UInt64,
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';

class FakeZkUsdVault extends SmartContract {
  @state(PublicKey) zkUsdTokenAddress = State<PublicKey>();
  @state(Bool) mintFlag = State<Bool>(Bool(false));

  async deploy(args: DeployArgs & { zkUsdTokenAddress: PublicKey }) {
    await super.deploy(args);
    // Set permissions to prevent unauthorized updates
    this.zkUsdTokenAddress.set(args.zkUsdTokenAddress);
  }

  @method async mint(amount: UInt64) {
    // Get the zkUSD token contract
    const zkUSD = new FungibleToken(
      this.zkUsdTokenAddress.getAndRequireEquals()
    );

    // Try to mint tokens directly without any assertions
    await zkUSD.mint(this.sender.getUnconstrainedV2(), amount);

    //Set the interaction flag
    this.mintFlag.set(Bool(true));
  }

  // This flag is set so the zkUSD Admin contract can check its permissions
  @method.returns(Bool)
  public async assertInteractionFlag() {
    this.mintFlag.requireEquals(Bool(true));
    this.mintFlag.set(Bool(false));
    return Bool(true);
  }
}

describe('Miscellaneous Security Tests', () => {
  const testHelper = new TestHelper();
  let fakeVault: FakeZkUsdVault;

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice']);

    if (TestHelper.proofsEnabled) {
      await FakeZkUsdVault.compile();
    }

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
        await fakeVault.deploy({ zkUsdTokenAddress });
      },
      {
        extraSigners: [fakeKeyPair.privateKey],
      }
    );
  });

  it('should not allow minting from unauthorized contracts', async () => {
    // Attempt to mint tokens from the fake vault

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        AccountUpdate.fundNewAccount(testHelper.agents.alice.account, 1);
        await fakeVault.mint(UInt64.from(1000e9));
      })
    ).rejects.toThrow(/authorization was not provided or is invalid/i); // This should fail as the token admin should reject unauthorized mints
  });
});
