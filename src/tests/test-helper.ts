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
  UInt32,
} from 'o1js';
import { OracleWhitelist, ProtocolData } from '../types';
import { ZkUsdEngine, ZkUsdEngineDeployProps } from '../zkusd-engine';
import { ZkUsdVault } from '../zkusd-vault-n';
import { FungibleToken, FungibleTokenAdminBase } from 'mina-fungible-token';

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
  vault?: {
    contract: ZkUsdVault;
    publicKey: PublicKey;
    privateKey: PrivateKey;
  };
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
  static DEBT_40_ZKUSD = UInt64.from(40e9); // 40 zkUSD
  static DEBT_30_ZKUSD = UInt64.from(30e9); // 30 zkUSD
  static DEBT_10_ZKUSD = UInt64.from(10e9); // 10 zkUSD
  static DEBT_5_ZKUSD = UInt64.from(5e9); // 5 zkUSD
  static DEBT_4_ZKUSD = UInt64.from(4e9); // 4 zkUSD
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
  token: ContractInstance<FungibleToken>;
  engine: ContractInstance<ZkUsdEngine>;
  vaultVerificationKeyHash?: Field;
  protocolAdmin: {
    privateKey: PrivateKey;
    publicKey: PublicKey;
  };
  whitelist: OracleWhitelist;
  whitelistedOracles: Map<string, number> = new Map();
  currentAccountIndex: number = 0;
  Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;

  static proofsEnabled = false;

  createVaultKeyPair(): { publicKey: PublicKey; privateKey: PrivateKey } {
    return PrivateKey.randomKeypair();
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
      addresses: Array(ZkUsdEngine.MAX_PARTICIPANTS).fill(PublicKey.empty()),
    });
  }

  createAgents(names: string[]) {
    if (this.currentAccountIndex >= 10) {
      throw new Error('Max number of agents reached');
    }

    names.forEach((name) => {
      this.agents[name] = {
        account: this.Local.testAccounts[this.currentAccountIndex],
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
    await FungibleToken.compile();
    await ZkUsdEngine.compile();
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

    const engineKeyPair = {
      privateKey: PrivateKey.fromBase58(
        'EKEfFkTEhZZi1UrPHKAmSZadmxx16rP8aopMm5XHbyDM96M9kXzD'
      ),
      publicKey: PublicKey.fromBase58(
        'B62qkwLvZ6e5NzRgQwkTaA9m88fTUZLHmpwvmCQEqbp5KcAAfqFAaf9'
      ),
    };

    FungibleToken.AdminContract = ZkUsdEngine;

    this.token = {
      contract: new FungibleToken(tokenKeyPair.publicKey),
      publicKey: tokenKeyPair.publicKey,
      privateKey: tokenKeyPair.privateKey,
    };
    this.engine = {
      contract: new ZkUsdEngine(engineKeyPair.publicKey),
      publicKey: engineKeyPair.publicKey,
      privateKey: engineKeyPair.privateKey,
    };

    if (TestHelper.proofsEnabled) {
      await this.compileContracts();
    }

    const verification = await ZkUsdVault.compile();
    this.vaultVerificationKeyHash = verification.verificationKey.hash;

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

    //50% protocol fee
    const FIFTY_PERCENT = UInt32.from(50);

    //Create deploy props for the engine
    const engineDeployProps: ZkUsdEngineDeployProps = {
      initialPrice: TestAmounts.PRICE_1_USD,
      admin: this.protocolAdmin.publicKey,
      oracleFlatFee: TestAmounts.COLLATERAL_1_MINA,
      protocolPercentageFee: FIFTY_PERCENT,
      emergencyStop: Bool(false),
      vaultVerificationKeyHash: this.vaultVerificationKeyHash!,
    };

    await this.transaction(
      this.deployer,
      async () => {
        AccountUpdate.fundNewAccount(this.deployer, 4);
        await this.token.contract.deploy({
          symbol: 'zkUSD',
          src: 'TBD',
        });
        await this.token.contract.initialize(
          this.engine.publicKey,
          UInt8.from(9),
          Bool(false)
        );
        await this.engine.contract.deploy(engineDeployProps);
        await this.engine.contract.initialize();
      },
      {
        extraSigners: [this.token.privateKey, this.engine.privateKey],
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
        await this.engine.contract.updateOracleWhitelist(this.whitelist);
      },
      {
        extraSigners: [this.protocolAdmin.privateKey],
      }
    );

    //Transfer Mina to the price feed oracle to pay the oracle fee
    await this.transaction(this.deployer, async () => {
      let transfer = AccountUpdate.createSigned(this.deployer);
      transfer.send({
        to: this.engine.publicKey,
        amount: TestAmounts.COLLATERAL_100_MINA,
      });
    });
  }

  async createVaults(names: string[]) {
    for (const name of names) {
      if (!this.agents[name]) {
        throw new Error(`Agent ${name} not found`);
      }

      const vaultKeyPair = this.createVaultKeyPair();

      console.log('Token Id of engine', this.engine.contract.deriveTokenId());

      this.agents[name].vault = {
        contract: new ZkUsdVault(
          vaultKeyPair.publicKey,
          this.engine.contract.deriveTokenId()
        ),
        publicKey: vaultKeyPair.publicKey,
        privateKey: vaultKeyPair.privateKey,
      };

      const packedProtocolData =
        await this.engine.contract.protocolDataPacked.fetch();

      const protocolData = ProtocolData.unpack(packedProtocolData!);

      await this.transaction(
        this.agents[name].account,
        async () => {
          AccountUpdate.fundNewAccount(this.agents[name].account, 2);
          await this.engine.contract.createVault(
            this.agents[name].vault!.publicKey
          );
        },
        {
          extraSigners: [this.agents[name].vault.privateKey],
        }
      );
    }
  }

  async updateOraclePrice(price: UInt64) {
    console.log('Number of whitelisted oracles', this.whitelistedOracles.size);

    // Use the map to iterate over whitelisted oracles
    for (const [oracleName] of this.whitelistedOracles) {
      await this.transaction(this.agents[oracleName].account, async () => {
        await this.engine.contract.submitPrice(price, this.whitelist);
      });
    }

    await this.transaction(this.deployer, async () => {
      await this.engine.contract.settlePriceUpdate();
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
        await this.engine.contract.stopTheProtocol();
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
        await this.engine.contract.resumeTheProtocol();
      },
      {
        extraSigners: [this.protocolAdmin.privateKey],
      }
    );
  }
}
