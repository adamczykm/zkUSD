import {
  Mina,
  PrivateKey,
  SmartContract,
  PublicKey,
  AccountUpdate,
  UInt8,
  Bool,
  Field,
  UInt64,
} from 'o1js';
import { ZkUsdAdmin } from '../zkusd-token-admin';
import { ZkUsdVault } from '../zkusd-vault';
import { ZkUsdProtocolVault } from '../zkusd-protocol-vault';
import { FungibleToken } from 'mina-fungible-token';
import { Oracle } from '../oracle';

interface TransactionOptions {
  printTx?: boolean;
  extraSigners?: PrivateKey[];
  fee?: number;
}

interface ContractInstance<T extends SmartContract> {
  contract: T;
  publicKey: PublicKey;
  privateKey: PrivateKey;
}

interface Agent {
  account: Mina.TestPublicKey;
  secret: Field;
  vault?: ContractInstance<ZkUsdVault>;
}

export class TestAmounts {
  //ZERO
  static ZERO = UInt64.from(0);

  // Collateral amounts
  static EXTRA_LARGE_COLLATERAL = UInt64.from(900e9); // 900 Mina
  static LARGE_COLLATERAL = UInt64.from(100e9); // 100 Mina
  static MEDIUM_COLLATERAL = UInt64.from(50e9); // 50 Mina
  static SMALL_COLLATERAL = UInt64.from(1e9); // 1 Mina

  // zkUSD amounts
  static EXTRA_LARGE_ZKUSD = UInt64.from(100e9); // 100 zkUSD
  static LARGE_ZKUSD = UInt64.from(30e9); // 30 zkUSD
  static MEDIUM_ZKUSD = UInt64.from(5e9); // 5 zkUSD
  static SMALL_ZKUSD = UInt64.from(1e9); // 1 zkUSD
  static TINY_ZKUSD = UInt64.from(1e8); // 0.1 zkUSD
}

export class TestHelper {
  deployer: Mina.TestPublicKey;
  agents: Record<string, Agent> = {};
  token: ContractInstance<FungibleToken>;
  admin: ContractInstance<ZkUsdAdmin>;
  protocolVault: ContractInstance<ZkUsdProtocolVault>;
  currentAccountIndex: number = 0;
  Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  oracle: Oracle;

  static proofsEnabled = false;

  createContractInstance<T extends SmartContract>(
    ContractClass: new (publicKey: PublicKey) => T
  ): ContractInstance<T> {
    const keyPair = PrivateKey.randomKeypair();
    return {
      contract: new ContractClass(keyPair.publicKey),
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    };
  }

  async initChain() {
    this.Local = await Mina.LocalBlockchain({
      proofsEnabled: TestHelper.proofsEnabled,
    });
    Mina.setActiveInstance(this.Local);
    this.deployer = this.Local.testAccounts[this.currentAccountIndex];
    this.currentAccountIndex++;
    this.oracle = new Oracle(this.Local);
  }

  createAgents(names: string[]) {
    names.forEach((name) => {
      this.agents[name] = {
        account: this.Local.testAccounts[this.currentAccountIndex],
        secret: Field.random(),
      };
      this.currentAccountIndex++;
    });
  }

  async transaction(
    sender: Mina.TestPublicKey,
    callback: () => Promise<void>,
    options: TransactionOptions = {}
  ) {
    const { printTx = false, extraSigners = [], fee } = options;

    const tx = await Mina.transaction(
      {
        sender,
        ...(fee && { fee }),
      },
      callback
    );

    if (printTx) {
      console.log(tx.toPretty());
    }

    await tx.prove();
    tx.sign([sender.key, ...extraSigners]);
    const sentTx = await tx.send();
    const txResult = await sentTx.wait();
    if (txResult.status !== 'included') {
      console.log('Transaction failed with status', txResult.toPretty());
      throw new Error(`Transaction failed with status ${txResult.status}`);
    }

    return txResult;
  }

  async compileContracts() {
    await ZkUsdAdmin.compile();
    await ZkUsdVault.compile();
    await FungibleToken.compile();
  }

  async deployTokenContracts() {
    FungibleToken.AdminContract = ZkUsdAdmin;

    const adminKeyPair = {
      privateKey: PrivateKey.fromBase58(
        'EKFPts6KALweqsniSsnq3eCWRskWtMaZdBjoyJ8AZuX2yuZPbmEg'
      ),
      publicKey: PublicKey.fromBase58(
        'B62qmrVkuYGu3NU4apAALjxcZVLGN5n2hdPSpfJghhHpjyjQbMWDtbM'
      ),
    };

    const tokenKeyPair = {
      privateKey: PrivateKey.fromBase58(
        'EKDveJ7bFB2SEFU52rgob94xa9NV5fVwarpDKGSQ6TPkmtb9MNd9'
      ),
      publicKey: PublicKey.fromBase58(
        'B62qry2wngUSGZqQn9erfnA9rZPn4cMbDG1XPasGdK1EtKQAxmgjDtt'
      ),
    };

    const protocolVaultKeyPair = {
      privateKey: PrivateKey.fromBase58(
        'EKEV3QoVY8oUAuiuR8AvVkfS4BBNLz4zwuoS5FjXCjW2EZfDzssF'
      ),
      publicKey: PublicKey.fromBase58(
        'B62qkJvkDUiw1c7kKn3PBa9YjNFiBgSA6nbXUJiVuSU128mKH4DiSih'
      ),
    };

    this.admin = {
      contract: new ZkUsdAdmin(adminKeyPair.publicKey),
      publicKey: adminKeyPair.publicKey,
      privateKey: adminKeyPair.privateKey,
    };
    this.token = {
      contract: new FungibleToken(tokenKeyPair.publicKey),
      publicKey: tokenKeyPair.publicKey,
      privateKey: tokenKeyPair.privateKey,
    };
    this.protocolVault = {
      contract: new ZkUsdProtocolVault(protocolVaultKeyPair.publicKey),
      publicKey: protocolVaultKeyPair.publicKey,
      privateKey: protocolVaultKeyPair.privateKey,
    };

    if (TestHelper.proofsEnabled) {
      await this.compileContracts();
    }

    // Deploying zkUSD Token and Admin contracts

    await this.transaction(
      this.deployer,
      async () => {
        AccountUpdate.fundNewAccount(this.deployer, 4);
        await this.admin.contract.deploy({});
        await this.token.contract.deploy({
          symbol: 'zkUSD',
          src: 'https://github.com/MinaFoundation/mina-fungible-token/blob/main/FungibleToken.ts',
        });
        await this.token.contract.initialize(
          this.admin.publicKey,
          UInt8.from(9),
          Bool(false)
        );
        await this.protocolVault.contract.deploy({});
      },
      {
        extraSigners: [
          this.admin.privateKey,
          this.token.privateKey,
          this.protocolVault.privateKey,
        ],
      }
    );
  }

  async deployVaults(names: string[]) {
    for (const name of names) {
      if (!this.agents[name]) {
        throw new Error(`Agent ${name} not found`);
      }

      this.agents[name].vault = this.createContractInstance(ZkUsdVault);

      await this.transaction(
        this.agents[name].account,
        async () => {
          AccountUpdate.fundNewAccount(this.agents[name].account, 1);
          await this.agents[name].vault?.contract.deploy({
            secret: this.agents[name].secret,
          });
        },
        {
          extraSigners: [this.agents[name].vault?.privateKey],
        }
      );
    }
  }

  async sendRewardsToVault(name: string, amount: UInt64) {
    if (!this.agents.rewards) {
      this.createAgents(['rewards']);
    }

    if (!this.agents[name]) {
      throw new Error(`Agent ${name} not found`);
    }

    await this.transaction(this.agents.rewards.account, async () => {
      let rewardsDistribution = AccountUpdate.createSigned(
        this.agents.rewards.account
      );
      rewardsDistribution.send({
        to: this.agents[name].vault!.publicKey!,
        amount,
      });
    });
  }
}
