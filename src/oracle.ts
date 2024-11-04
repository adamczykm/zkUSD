import { UInt64, Signature, PrivateKey, PublicKey, Mina } from 'o1js';
import { OraclePayload } from './zkusd-vault.js';

const keyPair = {
  privateKey: PrivateKey.fromBase58(
    'EKEzgDB9mryVGJDwa979R3vNNnphyxVGGJyccmRqXDtwuHV2hFXZ'
  ),
  publicKey: PublicKey.fromBase58(
    'B62qkQA5kdAsyvizsSdZ9ztzNidsqNXj9YrESPkMwUPt1J8RYDGkjAY'
  ),
};

export class Oracle {
  private price: UInt64;
  public privateKey: PrivateKey;
  public publicKey: PublicKey;
  private Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;

  constructor(Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>) {
    this.price = UInt64.from(1e9); // Initialize price to 1$ (1e9 to account for Mina's decimals)
    this.Local = Local;

    //create a random keypair
    this.privateKey = keyPair.privateKey;
    this.publicKey = keyPair.publicKey;
  }

  setPrice(newPrice: UInt64) {
    this.price = newPrice;
  }

  getSignedPrice(): OraclePayload {
    const currentBlockchainLength =
      this.Local.getNetworkState().blockchainLength;

    const signature = Signature.create(this.privateKey, [
      ...this.price.toFields(),
      ...currentBlockchainLength.toFields(),
    ]);

    return new OraclePayload({
      price: this.price,
      blockchainLength: currentBlockchainLength,
      signature,
    });
  }
}
