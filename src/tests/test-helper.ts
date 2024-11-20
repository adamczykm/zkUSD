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
  Experimental,
} from 'o1js';
import { ZkUsdToken } from '../zkusd-token';
import { ZkUsdVault } from '../zkusd-vault';
import { ZkUsdProtocolVault, OracleWhitelist } from '../zkusd-protocol-vault';
import { ZkUsdPriceFeedOracle } from '../zkusd-price-feed-oracle';

interface TransactionOptions {
  printTx?: boolean;
  extraSigners?: PrivateKey[];
  fee?: number;
  printAccountUpdates?: boolean;
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
  static COLLATERAL_900_MINA = UInt64.from(900e9); // 900 Mina
  static COLLATERAL_100_MINA = UInt64.from(100e9); // 100 Mina
  static COLLATERAL_50_MINA = UInt64.from(50e9); // 50 Mina
  static COLLATERAL_2_MINA = UInt64.from(2e9); // 2 Mina
  static COLLATERAL_1_MINA = UInt64.from(1e9); // 1 Mina

  // zkUSD amounts
  static DEBT_100_ZKUSD = UInt64.from(100e9); // 100 zkUSD
  static DEBT_50_ZKUSD = UInt64.from(50e9); // 50 zkUSD
  static DEBT_30_ZKUSD = UInt64.from(30e9); // 30 zkUSD
  static DEBT_5_ZKUSD = UInt64.from(5e9); // 5 zkUSD
  static DEBT_1_ZKUSD = UInt64.from(1e9); // 1 zkUSD
  static DEBT_50_CENT_ZKUSD = UInt64.from(5e8); // 0.5 zkUSD
  static DEBT_10_CENT_ZKUSD = UInt64.from(1e8); // 0.1 zkUSD

  // Price amounts
  static PRICE_0_USD = UInt64.from(0); // 0 USD
  static PRICE_25_CENT = UInt64.from(0.25e9); // 0.25 USD
  static PRICE_48_CENT = UInt64.from(0.48e9); // 0.48 USD
  static PRICE_49_CENT = UInt64.from(0.49e9); // 0.49 USD
  static PRICE_50_CENT = UInt64.from(0.5e9); // 0.50 USD
  static PRICE_51_CENT = UInt64.from(0.51e9); // 0.51 USD
  static PRICE_52_CENT = UInt64.from(0.52e9); // 0.52 USD
  static PRICE_1_USD = UInt64.from(1e9); // 1 USD
  static PRICE_2_USD = UInt64.from(2e9); // 2 USD
  static PRICE_10_USD = UInt64.from(1e10); // 10 USD
}

export class TestHelper {
  deployer: Mina.TestPublicKey;
  agents: Record<string, Agent> = {};
  token: ContractInstance<ZkUsdToken>;
  protocolVault: ContractInstance<ZkUsdProtocolVault>;
  protocolAdmin: {
    privateKey: PrivateKey;
    publicKey: PublicKey;
  };
  priceFeedOracle: ContractInstance<ZkUsdPriceFeedOracle>;
  whitelist: OracleWhitelist;
  whitelistedOracles: Map<string, number> = new Map();
  currentAccountIndex: number = 0;
  Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;

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
    this.protocolAdmin = PrivateKey.randomKeypair();
    this.currentAccountIndex++;
    this.whitelist = new OracleWhitelist({
      addresses: Array(ZkUsdPriceFeedOracle.MAX_PARTICIPANTS).fill(
        PublicKey.empty()
      ),
    });
  }

  createAgents(names: string[]) {
    if (this.currentAccountIndex >= 10) {
      throw new Error('Max number of agents reached');
    }

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
    const {
      printTx = false,
      extraSigners = [],
      fee,
      printAccountUpdates = false,
    } = options;

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

    if (printAccountUpdates) {
      const auCount: { publicKey: PublicKey; tokenId: Field; count: number }[] =
        [];
      let proofAuthorizationCount = 0;
      for (const au of tx.transaction.accountUpdates) {
        const { publicKey, tokenId, authorizationKind } = au.body;
        if (au.authorization.proof) {
          proofAuthorizationCount++;
          if (authorizationKind.isProved.toBoolean() === false)
            console.error('Proof authorization exists but isProved is false');
        } else if (authorizationKind.isProved.toBoolean() === true)
          console.error('isProved is true but no proof authorization');
        const index = auCount.findIndex(
          (item) =>
            item.publicKey.equals(publicKey).toBoolean() &&
            item.tokenId.equals(tokenId).toBoolean()
        );
        if (index === -1) auCount.push({ publicKey, tokenId, count: 1 });
        else auCount[index].count++;
      }
      console.log(
        `Account updates for tx: ${auCount.length}, proof authorizations: ${proofAuthorizationCount}`
      );
      for (const au of auCount) {
        if (au.count > 1) {
          console.log(
            `DUPLICATE AU: ${au.publicKey.toBase58()} tokenId: ${au.tokenId.toString()} count: ${
              au.count
            }`
          );
        }
      }
      console.log(tx.transaction.accountUpdates);
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
    await ZkUsdToken.compile();
    await ZkUsdVault.compile();
    await ZkUsdProtocolVault.compile();
    await ZkUsdPriceFeedOracle.compile();
  }

  async deployTokenContracts() {
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

    const priceFeedOracleKeyPair = {
      privateKey: PrivateKey.fromBase58(
        'EKEfFkTEhZZi1UrPHKAmSZadmxx16rP8aopMm5XHbyDM96M9kXzD'
      ),
      publicKey: PublicKey.fromBase58(
        'B62qkwLvZ6e5NzRgQwkTaA9m88fTUZLHmpwvmCQEqbp5KcAAfqFAaf9'
      ),
    };

    this.token = {
      contract: new ZkUsdToken(tokenKeyPair.publicKey),
      publicKey: tokenKeyPair.publicKey,
      privateKey: tokenKeyPair.privateKey,
    };
    this.protocolVault = {
      contract: new ZkUsdProtocolVault(protocolVaultKeyPair.publicKey),
      publicKey: protocolVaultKeyPair.publicKey,
      privateKey: protocolVaultKeyPair.privateKey,
    };
    this.priceFeedOracle = {
      contract: new ZkUsdPriceFeedOracle(priceFeedOracleKeyPair.publicKey),
      publicKey: priceFeedOracleKeyPair.publicKey,
      privateKey: priceFeedOracleKeyPair.privateKey,
    };

    //Set the offchain state for the price feed oracle

    if (TestHelper.proofsEnabled) {
      await this.compileContracts();
    }

    //Create the protocol admin
    await this.transaction(
      this.deployer,
      async () => {
        AccountUpdate.fundNewAccount(this.deployer, 1);
        AccountUpdate.createSigned(this.protocolAdmin.publicKey);
      },
      {
        extraSigners: [this.protocolAdmin.privateKey],
      }
    );

    // Deploying zkUSD Token and Admin contracts

    //Initial protocol fee is 50%
    const FIFTY_PERCENT = UInt64.from(50);

    await this.transaction(
      this.deployer,
      async () => {
        AccountUpdate.fundNewAccount(this.deployer, 4);
        await this.token.contract.deploy({
          symbol: 'zkUSD',
          src: 'TBD',
        });
        await this.token.contract.initialize(UInt8.from(9));
        await this.protocolVault.contract.deploy({
          adminPublicKey: this.protocolAdmin.publicKey,
          initialProtocolFee: FIFTY_PERCENT,
        });
        await this.priceFeedOracle.contract.deploy({
          initialPrice: TestAmounts.PRICE_1_USD,
          oracleFee: TestAmounts.COLLATERAL_1_MINA,
        });
      },
      {
        extraSigners: [
          this.token.privateKey,
          this.protocolVault.privateKey,
          this.priceFeedOracle.privateKey,
        ],
      }
    );

    //Lets also add a few trusted oracles to the whitelist
    for (let i = 0; i < 3; i++) {
      const oracleName = 'initialOracle' + i;
      this.createAgents([oracleName]);
      this.whitelist.addresses[i] = this.agents[oracleName].account;
      this.whitelistedOracles.set(oracleName, i);
    }

    await this.transaction(
      this.deployer,
      async () => {
        await this.protocolVault.contract.updateOracleWhitelist(this.whitelist);
      },
      {
        extraSigners: [this.protocolAdmin.privateKey],
      }
    );

    //Transfer Mina to the price feed oracle to pay the oracle fee
    await this.transaction(this.deployer, async () => {
      let transfer = AccountUpdate.createSigned(this.deployer);
      transfer.send({
        to: this.priceFeedOracle.publicKey,
        amount: TestAmounts.COLLATERAL_100_MINA,
      });
    });
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

  async updateOraclePrice(price: UInt64) {
    // Use the map to iterate over whitelisted oracles
    for (const [oracleName] of this.whitelistedOracles) {
      await this.transaction(this.agents[oracleName].account, async () => {
        await this.priceFeedOracle.contract.submitPrice(price, this.whitelist);
      });
    }

    await this.transaction(this.deployer, async () => {
      await this.priceFeedOracle.contract.settlePriceUpdate();
    });

    //Move the blockchain forward
    this.Local.setBlockchainLength(
      this.Local.getNetworkState().blockchainLength.add(1)
    );
  }

  async stopTheProtocol() {
    await this.transaction(
      this.deployer,
      async () => {
        await this.priceFeedOracle.contract.stopTheProtocol();
      },
      {
        extraSigners: [this.protocolAdmin.privateKey],
      }
    );
  }

  async resumeTheProtocol() {
    await this.transaction(
      this.deployer,
      async () => {
        await this.priceFeedOracle.contract.resumeTheProtocol();
      },
      {
        extraSigners: [this.protocolAdmin.privateKey],
      }
    );
  }
}
