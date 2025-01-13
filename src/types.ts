import {
  Struct,
  PublicKey,
  UInt64,
  Provable,
  Field,
  UInt32,
  Bool,
  PrivateKey,
} from 'o1js';

interface KeyPair {
  privateKey: PrivateKey;
  publicKey: PublicKey;
}

interface ContractInstance<T> {
  contract: T extends new (...args: any[]) => infer R ? R : T;
}

class PriceFeedAction extends Struct({
  address: PublicKey,
  price: UInt64,
}) {}

class PriceState extends Struct({
  prices: Provable.Array(UInt64, 10),
  count: UInt64,
}) {}

class PriceSubmissionPacked extends Struct({
  packedData: Field,
}) {}

class PriceSubmission extends Struct({
  price: UInt64,
  blockNumber: UInt32,
}) {
  static new(price?: UInt64, blockNumber?: UInt32): PriceSubmission {
    return new PriceSubmission({
      price: price ?? UInt64.zero,
      blockNumber: blockNumber ?? UInt32.zero,
    });
  }
  pack(): PriceSubmissionPacked {
    return new PriceSubmissionPacked({
      packedData: Field.fromBits([
        ...this.price.value.toBits(64),
        ...this.blockNumber.value.toBits(32),
      ]),
    });
  }

  static unpack(packed: PriceSubmissionPacked): PriceSubmission {
    const bits = packed.packedData.toBits(128);
    const price = UInt64.Unsafe.fromField(Field.fromBits(bits.slice(0, 64)));
    const blockNumber = UInt32.Unsafe.fromField(
      Field.fromBits(bits.slice(64, 96))
    );
    return new PriceSubmission({ price, blockNumber });
  }
}

class ProtocolDataPacked extends Struct({
  adminX: Field,
  packedData: Field,
}) {}

class OracleWhitelist extends Struct({
  addresses: Provable.Array(PublicKey, 8),
}) {
  static MAX_PARTICIPANTS = 8;
}

class ProtocolData extends Struct({
  admin: PublicKey,
  oracleFlatFee: UInt64,
  emergencyStop: Bool,
}) {
  static new(
    params: {
      admin?: PublicKey;
      oracleFlatFee?: UInt64;
      emergencyStop?: Bool;
    } = {}
  ): ProtocolData {
    return new ProtocolData({
      admin: params.admin ?? PublicKey.empty(),
      oracleFlatFee: params.oracleFlatFee ?? UInt64.zero,
      emergencyStop: params.emergencyStop ?? Bool(false),
    });
  }

  pack(): ProtocolDataPacked {
    return new ProtocolDataPacked({
      adminX: this.admin.x,
      packedData: Field.fromBits([
        ...this.oracleFlatFee.value.toBits(64),
        this.emergencyStop,
        this.admin.isOdd,
      ]),
    });
  }

  static unpack(packed: ProtocolDataPacked) {
    const bits = packed.packedData.toBits(64 + 2);
    const oracleFlatFee = UInt64.Unsafe.fromField(
      Field.fromBits(bits.slice(0, 64))
    );
    const emergencyStop = Bool(bits[64]);
    const adminIsOdd = Bool(bits[64 + 1]);
    const admin = PublicKey.from({
      x: packed.adminX,
      isOdd: adminIsOdd,
    });
    return new ProtocolData({
      admin: admin,
      oracleFlatFee: oracleFlatFee,
      emergencyStop: emergencyStop,
    });
  }
}

class VaultState extends Struct({
  collateralAmount: UInt64,
  debtAmount: UInt64,
  owner: PublicKey,
}) {}

class LiquidationResults extends Struct({
  oldVaultState: VaultState,
  liquidatorCollateral: UInt64,
  vaultOwnerCollateral: UInt64,
}) {}

class MinaPrice extends Struct({
  priceNanoUSD: UInt64,
  firstValidBlockHeight: UInt32,
  lastValidBlockHeight: UInt32,
}) {}

export {
  KeyPair,
  PriceFeedAction,
  PriceState,
  PriceSubmission,
  PriceSubmissionPacked,
  ProtocolData,
  ProtocolDataPacked,
  OracleWhitelist,
  VaultState,
  LiquidationResults,
  ContractInstance,
  MinaPrice,
};

