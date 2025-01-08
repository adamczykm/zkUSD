import { Mina, Lightnet, UInt32 } from 'o1js';
import { MinaNetwork, Local, Lightnet as LightnetNetwork } from './networks.js';
import { KeyPair } from './types.js';

/**
 * This type captures whatever methods come back from `Mina.Network()`.
 * For example, transaction(...), currentSlot(), etc.
 */
type MinaApi = Awaited<ReturnType<typeof Mina.Network>>;

export type LocalOnlyApi = {
  // add more as needed
  setBlockchainLength(height: UInt32): void;
}

class LocalBlockchain {
  kind: 'local' = 'local';
  instance: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  currentAccountIndex = 0;

  async init(opts?: {
    proofsEnabled?: boolean;
    enforceTransactionLimits?: boolean;
  }): Promise<void> {
    this.instance = await Mina.LocalBlockchain(opts);
  }

  async newAccount(): Promise<KeyPair> {
    if (this.currentAccountIndex >= 10) {
      throw new Error('Max number of local test accounts reached');
    }
    const t = this.instance.testAccounts[this.currentAccountIndex++];
    return {
      publicKey: t,
      privateKey: t.key,
    };
  }

  async moveChainForward(n: number=1): Promise<void> {
    this.instance.setBlockchainLength(
      this.instance.getNetworkState().blockchainLength.add(n)
    );
  }

  network(): MinaNetwork {
    return Local;
  }
}

/**
 * A simple helper for "lightnet" mode.
 * Also keeps its own .instance (MinaApi) and extra methods.
 */
class LightnetChain {
  kind: 'lightnet' = 'lightnet';
  instance: MinaApi;

  async init(): Promise<void> {
    this.instance = Mina.Network(this.network());
  }

  async newAccount(): Promise<KeyPair> {
    return Lightnet.acquireKeyPair();
  }

  async moveChainForward(_: number=1): Promise<void> {
    throw new Error('moveChainForward not implemented for Lightnet (TODO)');
  }

  network(): MinaNetwork {
    return LightnetNetwork;
  }
}

// exported singleton mina api helper that works with both local and lightnet
export class MinaChainInstance implements MinaApi {
  private instance: MinaApi;
  private backend: LocalBlockchain | LightnetChain;

  public local?: LocalOnlyApi;

  // We "declare" each property from MinaApi so TS knows we implement them.
  declare transaction: MinaApi['transaction'];
  declare currentSlot: MinaApi['currentSlot'];
  declare hasAccount: MinaApi['hasAccount'];
  declare getAccount: MinaApi['getAccount'];
  declare fetchEvents: MinaApi['fetchEvents'];
  declare fetchActions: MinaApi['fetchActions'];
  declare getActions: MinaApi['getActions'];
  declare sendTransaction: MinaApi['sendTransaction'];
  declare getNetworkState: MinaApi['getNetworkState'];
  declare getNetworkConstants: MinaApi['getNetworkConstants'];
  declare getNetworkId: MinaApi['getNetworkId'];
  declare proofsEnabled: MinaApi['proofsEnabled'];

  // ----------- Init local blockchain -----------
  async initLocal(opts?: {
    proofsEnabled?: boolean;
    enforceTransactionLimits?: boolean;
  }): Promise<void> {
    const local = new LocalBlockchain();
    await local.init(opts);

    // The local .instance is your real MinaApi
    this.backend = local;
    this.instance = local.instance;
    this.local = local.instance;

    // Switch the global "active" instance so .transaction calls, etc. refer to it
    Mina.setActiveInstance(this.instance);

    // Now dynamically copy all methods from local.instance => this
    this.bindMethods();
  }

  // ----------- Init/connect to the lightnet -----------
  async initLightnet(): Promise<void> {
    const ln = new LightnetChain();
    await ln.init();

    this.backend = ln;
    this.instance = ln.instance;

    Mina.setActiveInstance(this.instance);

    this.bindMethods();
  }

  // ----------- Extra “backend” methods -----------
  async newAccount(): Promise<KeyPair> {
    return this.backend.newAccount();
  }

  async moveChainForward(n: number=1): Promise<void> {
    return this.backend.moveChainForward(n);
  }

  network(): MinaNetwork {
    return this.backend.network();
  }

  // ----------- Bind all MinaApi methods -----------
  private bindMethods() {
    const proto = Object.getPrototypeOf(this.instance);
    for (const methodName of Object.getOwnPropertyNames(proto)) {
      if (methodName === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, methodName);
      if (descriptor && typeof descriptor.value === 'function') {
        (this as any)[methodName] = descriptor.value.bind(this.instance);
      }
    }
  }
}

// Export a singleton you can import anywhere
export const MinaChain = new MinaChainInstance();
