import { AccountUpdate, Mina, PrivateKey, UInt32, UInt64 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import { ZkUsdEngine } from '../../zkusd-engine';
import { OracleWhitelist } from '../../types';
import { ZkUsdMasterOracle } from '../../zkusd-master-oracle';

describe('zkUSD Price Feed Oracle Price Reducer Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice']);
  });

  it('should settle the correct price', async () => {
    await testHelper.updateOraclePrice(TestAmounts.PRICE_25_CENT);

    const price = await testHelper.engine.contract.getPrice();

    expect(price.toString()).toEqual(TestAmounts.PRICE_25_CENT.toString());
  });

  it('should settle the even price if we are on an odd block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(1));
    await testHelper.updateOraclePrice(TestAmounts.PRICE_50_CENT);

    const evenPrice = await testHelper.engine.contract.priceEvenBlock.fetch();

    expect(evenPrice?.toString()).toEqual(TestAmounts.PRICE_50_CENT.toString());
  });

  it('should settle the odd price if we are on an even block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(2));
    await testHelper.updateOraclePrice(TestAmounts.PRICE_52_CENT);

    const oddPrice = await testHelper.engine.contract.priceOddBlock.fetch();

    expect(oddPrice?.toString()).toEqual(TestAmounts.PRICE_52_CENT.toString());
  });

  it('should use the fallback price if oracles havent submitted the price', async () => {
    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    const actionState = await testHelper.engine.contract.actionState.fetch();

    const pendingActions = Mina.getActions(testHelper.engine.publicKey, {
      fromActionState: actionState,
    });

    expect(pendingActions.length).toEqual(0);

    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateFallbackPrice(
          TestAmounts.PRICE_2_USD
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const masterOracle = new ZkUsdMasterOracle(
      ZkUsdEngine.MASTER_ORACLE_ADDRESS,
      testHelper.engine.contract.deriveTokenId()
    );

    //Move the block forward
    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    //Move the block forward
    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    const price = await testHelper.engine.contract.getPrice();

    expect(price.toString()).toEqual(TestAmounts.PRICE_2_USD.toString());
  });

  it('should calculate correct median with 3 prices', async () => {
    const prices = [
      TestAmounts.PRICE_48_CENT,
      TestAmounts.PRICE_50_CENT,
      TestAmounts.PRICE_52_CENT,
    ];

    for (let i = 0; i < 3; i++) {
      const oracleName = Array.from(testHelper.whitelistedOracles.keys())[i];
      await testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.engine.contract.submitPrice(
            prices[i],
            testHelper.whitelist
          );
        }
      );
    }

    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    const price = await testHelper.engine.contract.getPrice();
    // Should return middle price (50 cents)
    expect(price.toString()).toEqual(TestAmounts.PRICE_50_CENT.toString());
  });

  it('should calculate correct median with 4 prices', async () => {
    // Add one more oracle
    const newOracleName = 'newOracle';
    testHelper.createAgents([newOracleName]);
    testHelper.whitelist.addresses[3] =
      testHelper.agents[newOracleName].account;
    testHelper.whitelistedOracles.set(newOracleName, 3);

    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateOracleWhitelist(
          testHelper.whitelist
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const prices = [
      TestAmounts.PRICE_48_CENT,
      TestAmounts.PRICE_49_CENT,
      TestAmounts.PRICE_51_CENT,
      TestAmounts.PRICE_52_CENT,
    ];

    for (let i = 0; i < 4; i++) {
      const oracleName = Array.from(testHelper.whitelistedOracles.keys())[i];
      await testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.engine.contract.submitPrice(
            prices[i],
            testHelper.whitelist
          );
        }
      );
    }

    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    const price = await testHelper.engine.contract.getPrice();
    // Should return average of two middle prices (50 cents)
    const expectedMedian = TestAmounts.PRICE_49_CENT.add(
      TestAmounts.PRICE_51_CENT
    ).div(UInt64.from(2));
    expect(price.toString()).toEqual(expectedMedian.toString());
  });

  it('should use fallback price as third price when less than 3 prices submitted', async () => {
    // Set fallback price to 1 USD
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateFallbackPrice(
          TestAmounts.PRICE_1_USD
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    // Submit 2 prices: 48 cents and 52 cents
    const prices = [TestAmounts.PRICE_48_CENT, TestAmounts.PRICE_52_CENT];
    for (let i = 0; i < 2; i++) {
      const oracleName = Array.from(testHelper.whitelistedOracles.keys())[i];
      await testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.engine.contract.submitPrice(
            prices[i],
            testHelper.whitelist
          );
        }
      );
    }

    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    const price = await testHelper.engine.contract.getPrice();
    // Should return 52 cents as median (from [48 cents, 52 cents, 1 USD])
    expect(price.toString()).toEqual(TestAmounts.PRICE_52_CENT.toString());
  });

  it('should handle maximum number of prices correctly', async () => {
    const mxOracles = [];

    // Create new addresses
    for (let i = 0; i < ZkUsdEngine.MAX_PARTICIPANTS; i++) {
      const oracleName = `maxOracle${i}`;
      const privateKey = PrivateKey.random();
      mxOracles.push({
        name: oracleName,
        privateKey: privateKey,
      });

      // Fund each oracle with Mina
      await testHelper.transaction(testHelper.deployer, async () => {
        AccountUpdate.fundNewAccount(testHelper.deployer, 1);
        let transfer = AccountUpdate.createSigned(testHelper.deployer);
        transfer.send({
          to: privateKey.toPublicKey(),
          amount: TestAmounts.COLLATERAL_50_MINA,
        });
      });
    }

    // Create new whitelist with max participants
    const newWhitelist: OracleWhitelist = {
      addresses: mxOracles.map((oracle) => oracle.privateKey.toPublicKey()),
    };

    // Update the whitelist
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateOracleWhitelist(newWhitelist);
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    // Submit prices in ascending order
    for (let i = 0; i < mxOracles.length; i++) {
      const oracle = mxOracles[i];
      const price = UInt64.from((0.48 + i * 0.01) * 1e9); // Prices from 0.48 to 0.57 USD

      const tx = await Mina.transaction(
        {
          sender: oracle.privateKey.toPublicKey(),
        },
        async () => {
          await testHelper.engine.contract.submitPrice(price, newWhitelist);
        }
      )
        .prove()
        .sign([oracle.privateKey])
        .send();
    }

    const actionState = await testHelper.engine.contract.actionState.fetch();
    const priceFeedActions = Mina.getActions(testHelper.engine.publicKey, {
      fromActionState: actionState,
    });

    expect(priceFeedActions.length).toBe(ZkUsdEngine.MAX_PARTICIPANTS);

    // Settle the actions
    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    // Move block forward
    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    const price = await testHelper.engine.contract.getPrice();
    // Should return average of two middle prices (0.525 USD for 10 participants)
    const expectedMedian = UInt64.from(0.525 * 1e9); // 0.525 USD
    expect(price.toString()).toEqual(expectedMedian.toString());
  });
});
