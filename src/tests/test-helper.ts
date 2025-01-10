import { AccountUpdate, Bool, Field, PrivateKey, PublicKey, UInt64, fetchAccount } from "o1js";
import { ZkUsdVault } from "../contracts/zkusd-vault.js";
import { ZkUsdEngineContract } from "../contracts/zkusd-engine.js";
import { ZkUsdMasterOracle } from "../contracts/zkusd-master-oracle.js";
import { ContractInstance, KeyPair, OracleWhitelist } from "../types.js";
import { FungibleTokenContract } from "@minatokens/token";
import { MinaChain } from "../mina.js";
import { NetworkKeyPairs, getNetworkKeys } from "../config/keys.js";
import { transaction } from "../utils/transaction.js";
import { deploy } from "../deploy.js";

export class TestAmounts {
  //ZERO
  static ZERO = UInt64.from(0);

  // Collateral amounts
  static COLLATERAL_900_MINA = UInt64.from(900e9); // 900 Mina
  static COLLATERAL_200_MINA = UInt64.from(200e9); // 200 Mina
  static COLLATERAL_105_MINA = UInt64.from(105e9); // 105 Mina
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
  static PRICE_40_CENT = UInt64.from(0.4e9); // 0.40 USD
  static PRICE_48_CENT = UInt64.from(0.48e9); // 0.48 USD
  static PRICE_49_CENT = UInt64.from(0.49e9); // 0.49 USD
  static PRICE_50_CENT = UInt64.from(0.5e9); // 0.50 USD
  static PRICE_51_CENT = UInt64.from(0.51e9); // 0.51 USD
  static PRICE_52_CENT = UInt64.from(0.52e9); // 0.52 USD
  static PRICE_1_USD = UInt64.from(1e9); // 1 USD
  static PRICE_2_USD = UInt64.from(2e9); // 2 USD
  static PRICE_10_USD = UInt64.from(1e10); // 10 USD
}

interface Agent {
  keys: KeyPair;
  vault?: {
    contract: ZkUsdVault;
    publicKey: PublicKey;
    privateKey: PrivateKey;
  };
}

export class TestHelper {
  chain = MinaChain;

  deployer: KeyPair;
  agents: Record<string, Agent> = {};
  oracles: Record<string, KeyPair> = {};

  token: ContractInstance<ReturnType<typeof FungibleTokenContract>>;
  engine: ContractInstance<ReturnType<typeof ZkUsdEngineContract>>;
  masterOracle: ContractInstance<ZkUsdMasterOracle>;

  vaultVerificationKeyHash?: Field;
  whitelist: OracleWhitelist = new OracleWhitelist({
    addresses: Array(OracleWhitelist.MAX_PARTICIPANTS).fill(
      PublicKey.empty()
    ),
  });

  whitelistedOracles: Map<string, number> = new Map();

  get networkKeys(): NetworkKeyPairs {
    return getNetworkKeys(this.chain.network().chainId);
  }

  createVaultKeyPair(): { publicKey: PublicKey; privateKey: PrivateKey } {
    return PrivateKey.randomKeypair();
  }

  async initLocalChain(opts?: { proofsEnabled?: boolean | undefined; enforceTransactionLimits?: boolean | undefined; }) {
    await this.chain.initLocal(opts);
    this.deployer = await this.chain.newAccount();
  }

  async initLightnetChain() {
    await this.chain.initLightnet();
    this.deployer = await this.chain.newAccount();
  }


  async deployTokenContracts() {
    let nonce = await this.chain.getAccountNonce(this.deployer.publicKey);
    console.log(`Deploying token contracts.\nDeployer: ${this.deployer.publicKey.toBase58()}\nDeployer nonce: ${nonce}`);
    const deployedContracts = await deploy(this.chain, this.deployer);
    const networkKeys = getNetworkKeys(this.chain.network().chainId);

    nonce = await this.chain.getAccountNonce(this.deployer.publicKey);
    console.log(`Initializating oracles\nDeployer nonce: ${nonce}`);

    this.token = deployedContracts.token;
    this.engine = deployedContracts.engine;
    this.masterOracle = deployedContracts.masterOracle;

    for (let i = 0; i < OracleWhitelist.MAX_PARTICIPANTS; i++) {
      const oracleName = 'oracle' + (i + 1);
      this.oracles[oracleName] = PrivateKey.randomKeypair();
      this.whitelist.addresses[i] = this.oracles[oracleName].publicKey;
      this.whitelistedOracles.set(oracleName, i);
    }

    // check if oracle accounts exist if not - create them
    let createOraclesTx;
    try {
      const oracleAccount = (
        await fetchAccount({ publicKey: this.oracles[0] }.publicKey)
      ).account;
      if (!oracleAccount) throw new Error('Oracle account not found');
      console.log('Oracle accounts already exist. Skipping creation.');
    } catch {
      console.log('Oracle accounts already exist. Skipping creation.');
      createOraclesTx = await transaction(this.deployer, async () => {
        const au = AccountUpdate.fundNewAccount(this.deployer.publicKey, 8);
        for (const [_name, oracle] of Object.entries(this.oracles)) {
          au.send({
            to: oracle.publicKey,
            amount: TestAmounts.COLLATERAL_50_MINA,
          });
        }
      },
        {
          fee: 10 * this.chain.fee,
          nonce: nonce++
        }
      );
    }

    const updateOracleWhiteListTx = await transaction(
      this.deployer,
      async () => {
        await this.engine.contract.updateOracleWhitelist(this.whitelist);
      },
      {
        extraSigners: [this.networkKeys.protocolAdmin.privateKey],
        fee: this.chain.fee,
        nonce: nonce++
      }
    );

    // let createOraclePriceTrackerTx;
    // try {
    //   const priceTrackerAccount = (
    //     await fetchAccount({ publicKey: networkKeys.masterOracle.publicKey, tokenId: this.engine.contract.deriveTokenId() })
    //   ).account;
    //   if (!priceTrackerAccount) throw new Error('Master oracle price tracker account not found');
    //   console.log('Master oracle price tracker account exists. Skipping creation.');

    // } catch {
    //   createOraclePriceTrackerTx = await transaction(this.deployer, async () => {
    //     const root = AccountUpdate.fundNewAccount(this.deployer.publicKey, 1);
    //     const au = AccountUpdate.create(networkKeys.masterOracle.publicKey, this.engine.contract.deriveTokenId())
    //     root.approve(au);
    //   },
    //     {
    //       extraSigners: [this.networkKeys.engine.privateKey],
    //       fee: this.chain.fee,
    //       nonce: nonce++
    //     }
    //   )
    // }

    //Transfer Mina to the price feed oracle to pay the oracle fee
    const depositOracleFundsTx = await transaction(this.deployer, async () => {
      await this.engine.contract.depositOracleFunds(
        TestAmounts.COLLATERAL_100_MINA
      );
    },
      {
        extraSigners: [this.networkKeys.protocolAdmin.privateKey],
        fee: this.chain.fee,
        nonce: nonce++
      }
    );

    const txs = [createOraclesTx, updateOracleWhiteListTx, depositOracleFundsTx]

    console.log('Waiting for transactions to be included')
    for (const tx of txs) {
      if (!tx) continue;
      const txResult = await tx.safeWait();
      if (txResult.status !== 'included') {
        console.log('Transaction failed with status', txResult.status);
        console.log('Error list:');
        for (const err of txResult.errors) {
          console.log(err);
        }
        throw new Error(`Transaction failed with status ${txResult.status}`);
      }
    }
  }

  async createAgents(names: string[]) {
    for (const name of names) {
      const keys = await this.chain.newAccount();
      this.agents[name] = { keys };
    }
  }

  async createVaults(names: string[]) {
    for (const name of names) {
      if (!this.agents[name]) {
        throw new Error(`Agent ${name} not found`);
      }

      const vaultKeyPair = this.createVaultKeyPair();

      this.agents[name].vault = {
        contract: new ZkUsdVault(
          vaultKeyPair.publicKey,
          this.engine.contract.deriveTokenId()
        ),
        publicKey: vaultKeyPair.publicKey,
        privateKey: vaultKeyPair.privateKey,
      };

      await transaction(
        this.agents[name].keys,
        async () => {
          AccountUpdate.fundNewAccount(this.agents[name].keys.publicKey, 2);
          await this.engine.contract.createVault(
            this.agents[name].vault!.publicKey
          );
        },
        {
          fee: this.chain.fee,
          extraSigners: [this.agents[name].vault!.privateKey],
        }
      );
    }
  }


  async updateOracleMinaPrice(price: UInt64) {
    // Use the map to iterate over whitelisted oracles
    for (const [oracleName] of this.whitelistedOracles) {
      await transaction(this.oracles[oracleName], async () => {
        await this.engine.contract.submitPrice(price, this.whitelist);
      });
    }

    this.chain.moveChainForward();

    await transaction(this.deployer, async () => {
      await this.engine.contract.settlePriceUpdate();
    });

    this.chain.moveChainForward();
  }


  async stopTheProtocol() {
    await transaction(
      this.deployer,
      async () => {
        await this.engine.contract.toggleEmergencyStop(Bool(true));
      },
      {
        extraSigners: [this.networkKeys.protocolAdmin.privateKey],
      }
    );
  }

  async resumeTheProtocol() {
    await transaction(
      this.deployer,
      async () => {
        await this.engine.contract.toggleEmergencyStop(Bool(false));
      },
      {
        extraSigners: [this.networkKeys.protocolAdmin.privateKey],
      }
    );
  }

}
