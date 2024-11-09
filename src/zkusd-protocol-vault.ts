import {
  DeployArgs,
  method,
  SmartContract,
  Permissions,
  AccountUpdate,
  UInt64,
  Int64,
  PublicKey,
  Mina,
  PrivateKey,
} from 'o1js';

export class ZkUsdProtocolVault extends SmartContract {
  async deploy(args: DeployArgs) {
    await super.deploy(args);

    // Set permissions to prevent unauthorized updates
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  @method async withdraw(amount: UInt64) {
    // const zkUsdVault = new ZkUsdVault(_accountUpdate.publicKey);
    // zkUsdVault.assertInteractionFlag();

    this.send({
      to: this.sender.getAndRequireSignatureV2(),
      amount: amount,
    });
  }
}

const localChain = await Mina.LocalBlockchain({
  proofsEnabled: false,
});

// Mina.setActiveInstance(localChain);

// const [deployer] = localChain.testAccounts;

// const collateralVault = PrivateKey.randomKeypair();

// await Mina.transaction(
//   {
//     sender: deployer,
//   },
//   async () => {
//     AccountUpdate.fundNewAccount(deployer);
//     await contract.deploy({});
//   }
// )
//   .prove()
//   .sign([collateralVault.privateKey, deployer.key])
//   .send();

// //Deposit

// const tx = await Mina.transaction(
//   {
//     sender: deployer,
//   },
//   async () => {
//     // AccountUpdate.fundNewAccount(deployer);
//     let accountUpdate = AccountUpdate.create(deployer);
//     await contract.withdraw(UInt64.from(100e9));
//   }
// ).prove();

// console.log(tx.toPretty());

// tx.sign([collateralVault.privateKey, deployer.key]).send();

// contract.getTotalHoldings().then((value) => {
//   console.log(value.toString());
// });
