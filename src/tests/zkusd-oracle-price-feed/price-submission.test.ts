import { AccountUpdate, Field, Mina, PrivateKey, UInt32 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import {
  Whitelist,
  ZkUsdPriceFeedOracle,
  ZkUsdPriceFeedOracleErrors,
} from '../../zkusd-price-feed-oracle';

describe('zkUSD Price Feed Oracle Submission Test Suite', () => {
  const testHelper = new TestHelper();

  let whitelist: Whitelist;
  let whitelistedOracles: Map<string, number>;
  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    whitelist = testHelper.whitelist;
    whitelistedOracles = testHelper.whitelistedOracles;
    testHelper.createAgents(['alice']);
  });

  beforeEach(async () => {
    //reset the whitelist
    testHelper.whitelist = {
      ...whitelist,
      addresses: [...whitelist.addresses],
    };
    testHelper.whitelistedOracles = new Map(whitelistedOracles);

    await testHelper.transaction(
      testHelper.agents.alice.account,
      async () => {
        await testHelper.priceFeedOracle.contract.updateWhitelist(
          testHelper.whitelist
        );
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    //settle any outstanding actions
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.priceFeedOracle.contract.settlePriceUpdate();
    });
  });

  it('should allow a whitelisted address to submit a price', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;

    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await testHelper.transaction(
      testHelper.agents[oracleName].account,
      async () => {
        await testHelper.priceFeedOracle.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      }
    );

    const priceFeedAction = Mina.getActions(
      testHelper.priceFeedOracle.publicKey
    );

    const oracle1Address = testHelper.agents[oracleName].account.x.toString();
    const addressInActionState = priceFeedAction[0].actions[0][0].toString();

    expect(oracle1Address).toEqual(addressInActionState);
  });

  it('should not allow a whitelisted address to submit a second price before settlement', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;

    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await testHelper.transaction(
      testHelper.agents[oracleName].account,
      async () => {
        await testHelper.priceFeedOracle.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      }
    );

    await expect(
      testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.priceFeedOracle.contract.submitPrice(
            TestAmounts.PRICE_25_CENT,
            testHelper.whitelist
          );
        }
      )
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.PENDING_ACTION_EXISTS);
  });

  it('should not allow a non-whitelisted address to submit a price', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.priceFeedOracle.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      })
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.SENDER_NOT_WHITELISTED);
  });

  it('should not allow a different version of the whitelist', async () => {
    const fakeWhitelist = testHelper.whitelist;
    fakeWhitelist.addresses[0] = testHelper.agents.alice.account;

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.priceFeedOracle.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          fakeWhitelist
        );
      })
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.INVALID_WHITELIST);
  });

  it('should not allow a price to be submitted with a price of 0', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await expect(
      testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.priceFeedOracle.contract.submitPrice(
            TestAmounts.ZERO,
            testHelper.whitelist
          );
        }
      )
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.AMOUNT_ZERO);
  });

  it('should allow multiple whitelisted oracles to submit prices', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleNames = Array.from(whitelistedOracles.keys());

    // Submit prices from all whitelisted oracles
    for (const oracleName of oracleNames) {
      await testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.priceFeedOracle.contract.submitPrice(
            TestAmounts.PRICE_25_CENT,
            testHelper.whitelist
          );
        }
      );
    }

    const priceFeedActions = Mina.getActions(
      testHelper.priceFeedOracle.publicKey,
      {
        fromActionState: testHelper.priceFeedOracle.contract.actionState.get(),
      }
    );

    // Verify all submissions were recorded
    expect(priceFeedActions.length).toBe(whitelistedOracles.size);
  });

  it('should allow a whitelisted oracle to submit a new price after settlement', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleName = Array.from(whitelistedOracles.keys())[0];

    // Submit initial price
    await testHelper.transaction(
      testHelper.agents[oracleName].account,
      async () => {
        await testHelper.priceFeedOracle.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      }
    );

    // Settle the price update
    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.priceFeedOracle.contract.settlePriceUpdate();
    });

    // Submit new price after settlement
    await testHelper.transaction(
      testHelper.agents[oracleName].account,
      async () => {
        await testHelper.priceFeedOracle.contract.submitPrice(
          TestAmounts.PRICE_50_CENT,
          testHelper.whitelist
        );
      }
    );

    const actionState = testHelper.priceFeedOracle.contract.actionState.get();
    const priceFeedActions = Mina.getActions(
      testHelper.priceFeedOracle.publicKey,
      {
        fromActionState: actionState,
      }
    );
    expect(priceFeedActions[0].actions.length).toBe(1);
  });

  it('should handle maximum number of oracle submissions', async () => {
    const mxOracles = [];

    //First lets create some new addresses

    for (let i = 0; i < ZkUsdPriceFeedOracle.MAX_PARTICIPANTS; i++) {
      const oracleName = `maxOracle${i}`;
      const privateKey = PrivateKey.random();
      mxOracles.push({
        name: oracleName,
        privateKey: privateKey,
      });

      //transfer each oracle 10 mina

      await testHelper.transaction(testHelper.deployer, async () => {
        AccountUpdate.fundNewAccount(testHelper.deployer, 1);
        let transfer = AccountUpdate.createSigned(testHelper.deployer);
        transfer.send({
          to: privateKey.toPublicKey(),
          amount: TestAmounts.COLLATERAL_50_MINA,
        });
      });
    }

    //create the new whitelist
    const newWhitelist: Whitelist = {
      addresses: mxOracles.map((oracle) => oracle.privateKey.toPublicKey()),
    };

    //update the whitelist
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.priceFeedOracle.contract.updateWhitelist(newWhitelist);
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    //submit prices from all the new oracles
    for (const oracle of mxOracles) {
      const tx = await Mina.transaction(
        {
          sender: oracle.privateKey.toPublicKey(),
        },
        async () => {
          await testHelper.priceFeedOracle.contract.submitPrice(
            TestAmounts.PRICE_48_CENT,
            newWhitelist
          );
        }
      )
        .prove()
        .sign([oracle.privateKey])
        .send();
    }

    const actionState = testHelper.priceFeedOracle.contract.actionState.get();

    const priceFeedActions = Mina.getActions(
      testHelper.priceFeedOracle.publicKey,
      {
        fromActionState: actionState,
      }
    );

    expect(priceFeedActions.length).toBe(ZkUsdPriceFeedOracle.MAX_PARTICIPANTS);

    //settle the actions
    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.priceFeedOracle.contract.settlePriceUpdate();
    });

    //move block forward
    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    //expect price to be 48 cent
    const price = await testHelper.priceFeedOracle.contract.getPrice();

    expect(price.toString()).toEqual(TestAmounts.PRICE_48_CENT.toString());
  });

  it('should allow the fallback price to be updated with the admin key', async () => {
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.priceFeedOracle.contract.updateFallbackPrice(
          TestAmounts.PRICE_52_CENT
        );
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    //move block forward
    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    const fallbackPrice =
      await testHelper.priceFeedOracle.contract.getFallbackPrice();

    expect(fallbackPrice.toString()).toEqual(
      TestAmounts.PRICE_52_CENT.toString()
    );
  });

  it('should update the even fallback price if we are on an odd block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(1));
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.priceFeedOracle.contract.updateFallbackPrice(
          TestAmounts.PRICE_25_CENT
        );
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    const fallbackEvenPrice =
      testHelper.priceFeedOracle.contract.fallbackPriceEvenBlock.get();

    expect(fallbackEvenPrice.toString()).toEqual(
      TestAmounts.PRICE_25_CENT.toString()
    );
  });
  it('should update the odd fallback price if we are on an even block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(2));
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.priceFeedOracle.contract.updateFallbackPrice(
          TestAmounts.PRICE_2_USD
        );
      },
      {
        extraSigners: [testHelper.protocolAdmin.privateKey],
      }
    );

    const fallbackOddPrice =
      testHelper.priceFeedOracle.contract.fallbackPriceOddBlock.get();

    expect(fallbackOddPrice.toString()).toEqual(
      TestAmounts.PRICE_2_USD.toString()
    );
  });
  it('should not allow the fallback price to be updated without the admin key', async () => {
    await expect(
      testHelper.transaction(testHelper.deployer, async () => {
        await testHelper.priceFeedOracle.contract.updateFallbackPrice(
          TestAmounts.PRICE_2_USD
        );
      })
    ).rejects.toThrow(/Transaction verification failed/i);
  });

  it('should not allow the fallback price to be updated to 0', async () => {
    await expect(
      testHelper.transaction(
        testHelper.deployer,
        async () => {
          await testHelper.priceFeedOracle.contract.updateFallbackPrice(
            TestAmounts.ZERO
          );
        },
        {
          extraSigners: [testHelper.protocolAdmin.privateKey],
        }
      )
    ).rejects.toThrow(ZkUsdPriceFeedOracleErrors.AMOUNT_ZERO);
  });
});
