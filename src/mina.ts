import { PublicKey, PrivateKey, Field, CircuitString, Mina } from 'o1js';
import { networks, blockchain, MinaNetwork, Local } from './networks';

interface MinaNetworkInstance {
  keys: {
    publicKey: PublicKey;
    privateKey: PrivateKey;
  }[];
  network: MinaNetwork;
  networkIdHash: Field;
  local?: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
}

let currentNetwork: MinaNetworkInstance | undefined = undefined;

function getNetworkIdHash(): Field {
  if (currentNetwork === undefined) {
    throw new Error('Network is not initialized');
  }
  return currentNetwork.networkIdHash;
}

function calculateNetworkIdHash(chain: blockchain): Field {
  return CircuitString.fromString(chain).hash();
}

async function initBlockchain(
  instance: blockchain
): Promise<MinaNetworkInstance> {
  const networkIdHash = calculateNetworkIdHash(instance);

  if (instance === 'local') {
    const local = await Mina.LocalBlockchain({
      proofsEnabled: true,
    });
    Mina.setActiveInstance(local);
    currentNetwork = {
      keys: local.testAccounts.map((key) => ({
        privateKey: key.key,
        publicKey: key,
      })),
      network: Local,
      networkIdHash: networkIdHash,
      local: local,
    };
    return currentNetwork;
  }

  const network = networks.find((n) => n.chainId === instance);

  if (!network) {
    throw new Error(`Network ${instance} not found`);
  }

  const networkInstance = Mina.Network({
    mina: network.mina,
    archive: network.archive,
    lightnetAccountManager: network.accountManager,
    networkId: 'testnet', //Testnet for now - could be mainnet when supporting mainnet deployments
  });
  Mina.setActiveInstance(networkInstance);

  const keys: {
    publicKey: PublicKey;
    privateKey: PrivateKey;
  }[] = [];

  currentNetwork = {
    keys: keys,
    network: network,
    networkIdHash: networkIdHash,
  };

  return currentNetwork;
}

export {
  initBlockchain,
  getNetworkIdHash,
  MinaNetworkInstance,
  calculateNetworkIdHash,
};
