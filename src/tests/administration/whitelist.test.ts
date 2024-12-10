import { Field, Poseidon, PrivateKey, PublicKey } from 'o1js';
import { TestHelper } from '../test-helper';
import { OracleWhitelist } from '../../types';

describe('zkUSD Engine Oracle Whitelist Test Suite', () => {
  const testHelper = new TestHelper();
  let whitelist: OracleWhitelist;
  let previousWhitelistHash: Field;
  let newWhitelistHash: Field;

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    whitelist = testHelper.whitelist;
  });

  beforeEach(async () => {
    //reset the whitelist
    testHelper.whitelist = {
      ...whitelist,
      addresses: [...whitelist.addresses],
    };
  });

  it('should allow the whitelist to be updated with the admin key', async () => {
    const currentWhitelist = testHelper.whitelistedOracles.size;
    const whitelist = testHelper.whitelist;

    const newOracle = PrivateKey.random().toPublicKey();
    whitelist.addresses[0] = newOracle;

    previousWhitelistHash =
      (await testHelper.engine.contract.oracleWhitelistHash.fetch()) as Field;

    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateOracleWhitelist(whitelist);
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const expectedWhitelistHash = Poseidon.hash(
      OracleWhitelist.toFields(whitelist)
    );

    newWhitelistHash =
      (await testHelper.engine.contract.oracleWhitelistHash.fetch()) as Field;

    expect(
      await testHelper.engine.contract.oracleWhitelistHash.fetch()
    ).toEqual(expectedWhitelistHash);
  });

  it('should emit the oracle whitelist update event', async () => {
    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('OracleWhitelistUpdated');
    // @ts-ignore
    expect(latestEvent.event.data.newHash).toEqual(newWhitelistHash);
    // @ts-ignore
    expect(latestEvent.event.data.previousHash).toEqual(previousWhitelistHash);
  });

  it('should not allow updating the whitelist without the admin key', async () => {
    const whitelist = testHelper.whitelist;

    const newOracle = PrivateKey.random().toPublicKey();
    whitelist.addresses[0] = newOracle;

    await expect(
      testHelper.transaction(testHelper.deployer, async () => {
        await testHelper.engine.contract.updateOracleWhitelist(whitelist);
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should not allow updating with a whitelist that has more than 8 addresses', async () => {
    const whitelist = testHelper.whitelist;

    for (let i = 0; i < 10; i++) {
      whitelist.addresses[i] = PrivateKey.random().toPublicKey();
    }

    console.log(whitelist);

    await expect(
      testHelper.transaction(
        testHelper.deployer,
        async () => {
          await testHelper.engine.contract.updateOracleWhitelist(whitelist);
        },
        {
          extraSigners: [TestHelper.engineKeyPair.privateKey],
        }
      )
    ).rejects.toThrow('Expected witnessed values of length 16, got 20.');
  });

  it('should not allow updating with an invalid whitelist', async () => {
    testHelper.whitelist.addresses[1] = 'RandomString' as unknown as PublicKey;

    await expect(
      testHelper.transaction(
        testHelper.deployer,
        async () => {
          await testHelper.engine.contract.updateOracleWhitelist(
            testHelper.whitelist
          );
        },
        {
          extraSigners: [TestHelper.engineKeyPair.privateKey],
        }
      )
    ).rejects.toThrow('Cannot convert undefined to a BigInt');
  });
});
