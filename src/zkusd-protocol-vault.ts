import {
  SmartContract,
  state,
  PublicKey,
  State,
  DeployArgs,
  method,
  UInt64,
  Permissions,
  VerificationKey,
  AccountUpdate,
  assert,
  Provable,
} from 'o1js';

import { ZkUsdProtocolAdmin } from './zkusd-protocol-admin';

export class ZkUsdProtocolVault extends SmartContract {
  @state(UInt64) protocolFee = State<UInt64>(); // The percentage taken from staking rewards

  static ZKUSD_PROTOCOL_ADMIN_KEY = PublicKey.fromBase58(
    'B62qkkJyWEXwHN9zZmqzfdf2ec794EL5Nyr8hbpvqRX4BwPyQcwKJy6'
  );

  static ZkUsdProtocolAdminContract = new ZkUsdProtocolAdmin(
    ZkUsdProtocolVault.ZKUSD_PROTOCOL_ADMIN_KEY
  );

  async deploy(args: DeployArgs & { protocolFee: UInt64 }) {
    await super.deploy(args);

    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey: Permissions.VerificationKey.proofOrSignature(), // We want to be able to upgrade the protocol vault contract - TODO: Test to see this is locked down to the proof
      setPermissions: Permissions.impossible(),
    });

    this.protocolFee.set(args.protocolFee);
  }

  @method
  async updateVerificationKey(vk: VerificationKey) {
    const canUpdate =
      await ZkUsdProtocolVault.ZkUsdProtocolAdminContract.canUpdateProtocolVaultVerificationKey(
        this.self
      );
    canUpdate.assertTrue(); //TODO: Add message
    this.account.verificationKey.set(vk);
  }

  @method async withdrawProtocolFunds(recipient: PublicKey, amount: UInt64) {
    const canWithdraw =
      await ZkUsdProtocolVault.ZkUsdProtocolAdminContract.canWithdrawProtocolFunds(
        this.self
      );

    canWithdraw.assertTrue(); //TODO: Add message

    // Process withdrawal
    this.send({
      to: recipient,
      amount: amount,
    });
  }

  @method async setProtocolFee(fee: UInt64) {
    const canSetFee =
      await ZkUsdProtocolVault.ZkUsdProtocolAdminContract.canSetProtocolFee(
        this.self
      );
    canSetFee.assertTrue(); //TODO: Add message

    //Assert fee is less than 100 TODO: Add message
    fee.assertLessThanOrEqual(UInt64.from(100));

    this.protocolFee.set(fee);
  }
}
