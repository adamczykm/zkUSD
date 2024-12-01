import { Struct, PublicKey, UInt64, Provable, Field, UInt32, Bool } from 'o1js';

export class PriceFeedAction extends Struct({
  address: PublicKey,
  price: UInt64,
}) {}

export class PriceState extends Struct({
  prices: Provable.Array(UInt64, 10),
  count: UInt64,
}) {}

export class ProtocolDataPacked extends Struct({
  adminX: Field,
  packedData: Field,
}) {}

export class OracleWhitelist extends Struct({
  addresses: Provable.Array(PublicKey, 10),
}) {}

export class ProtocolData extends Struct({
  admin: PublicKey,
  oracleFlatFee: UInt64,
  protocolPercentageFee: UInt32,
  emergencyStop: Bool,
}) {
  static new(
    params: {
      admin?: PublicKey;
      oracleFlatFee?: UInt64;
      protocolPercentageFee?: UInt32;
      emergencyStop?: Bool;
    } = {}
  ): ProtocolData {
    return new ProtocolData({
      admin: params.admin ?? PublicKey.empty(),
      oracleFlatFee: params.oracleFlatFee ?? UInt64.zero,
      protocolPercentageFee: params.protocolPercentageFee ?? UInt32.zero,
      emergencyStop: params.emergencyStop ?? Bool(false),
    });
  }

  pack(): ProtocolDataPacked {
    return new ProtocolDataPacked({
      adminX: this.admin.x,
      packedData: Field.fromBits([
        ...this.oracleFlatFee.value.toBits(64),
        ...this.protocolPercentageFee.value.toBits(32),
        this.emergencyStop,
        this.admin.isOdd,
      ]),
    });
  }

  static unpack(packed: ProtocolDataPacked) {
    const bits = packed.packedData.toBits(64 + 32 + 2);
    const oracleFlatFee = UInt64.Unsafe.fromField(
      Field.fromBits(bits.slice(0, 64))
    );
    const protocolPercentageFee = UInt32.Unsafe.fromField(
      Field.fromBits(bits.slice(64, 64 + 32))
    );
    const emergencyStop = Bool(bits[64 + 32]);
    const adminIsOdd = Bool(bits[64 + 32 + 1]);
    const admin = PublicKey.from({
      x: packed.adminX,
      isOdd: adminIsOdd,
    });
    return new ProtocolData({
      admin: admin,
      oracleFlatFee: oracleFlatFee,
      protocolPercentageFee: protocolPercentageFee,
      emergencyStop: emergencyStop,
    });
  }
}

export class VaultState extends Struct({
  collateralAmount: UInt64,
  debtAmount: UInt64,
  owner: PublicKey,
}) {}
