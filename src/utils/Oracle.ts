import { Field, UInt64, Signature, PrivateKey, PublicKey } from 'o1js';

export class Oracle {
  private price: UInt64;
  private privateKey: PrivateKey;
  public publicKey: PublicKey;

  constructor(privateKey: PrivateKey) {
    this.price = UInt64.from(1e9); // Initialize price to 1$ (1e9 to account for Mina's decimals)
    this.privateKey = privateKey;
    this.publicKey = this.privateKey.toPublicKey();
  }

  setPrice(newPrice: UInt64) {
    this.price = newPrice;
  }

  getSignedPrice(): { price: UInt64; signature: Signature } {
    const signature = Signature.create(this.privateKey, [
      this.price.toFields()[0],
    ]);
    return { price: this.price, signature };
  }
}
