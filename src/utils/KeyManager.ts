import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrivateKey, PublicKey } from 'o1js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const keysDir = path.join(projectRoot, 'keys');

interface KeyPair {
  privateKey: PrivateKey;
  publicKey: PublicKey;
}

export class KeyManager {
  private networkType: string;

  constructor(networkType: string) {
    this.networkType = networkType;
    if (!fs.existsSync(keysDir)) {
      fs.mkdirSync(keysDir, { recursive: true });
    }
  }

  writeKeys(name: string, keyPair: KeyPair): void {
    const keyData = {
      privateKey: keyPair.privateKey.toBase58(),
      publicKey: keyPair.publicKey.toBase58(),
    };

    const filePath = path.join(keysDir, `${this.networkType}_${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(keyData, null, 2));
  }

  readKeys(name: string): KeyPair | null {
    const filePath = path.join(keysDir, `${this.networkType}_${name}.json`);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const keyData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      privateKey: PrivateKey.fromBase58(keyData.privateKey),
      publicKey: PublicKey.fromBase58(keyData.publicKey),
    };
  }
}
