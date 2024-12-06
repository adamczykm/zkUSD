import { AccountUpdate, Field, Mina, PrivateKey, UInt32, UInt64 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import { OracleWhitelist, ProtocolData } from '../../types';
import { ZkUsdEngine, ZkUsdEngineErrors } from '../../zkusd-engine';
import {
  ZkUsdMasterOracle,
  ZkUsdMasterOracleErrors,
} from '../../zkusd-master-oracle';

describe('zkUSD Price Feed Oracle Submission Test Suite', () => {
  const testHelper = new TestHelper();

  let whitelist: OracleWhitelist;
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
        await testHelper.engine.contract.updateOracleWhitelist(
          testHelper.whitelist
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    //settle any outstanding actions
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });
  });

  it('should allow a whitelisted address to submit a price', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;

    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await testHelper.transaction(
      testHelper.agents[oracleName].account,
      async () => {
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      }
    );

    const priceFeedAction = Mina.getActions(testHelper.engine.publicKey);

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
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      }
    );

    await expect(
      testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.engine.contract.submitPrice(
            TestAmounts.PRICE_25_CENT,
            testHelper.whitelist
          );
        }
      )
    ).rejects.toThrow(ZkUsdEngineErrors.PENDING_ACTION_EXISTS);
  });

  it('should not allow a non-whitelisted address to submit a price', async () => {
    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      })
    ).rejects.toThrow(ZkUsdEngineErrors.SENDER_NOT_WHITELISTED);
  });

  it('should not allow a different version of the whitelist', async () => {
    const fakeWhitelist = testHelper.whitelist;
    fakeWhitelist.addresses[0] = testHelper.agents.alice.account;

    await expect(
      testHelper.transaction(testHelper.agents.alice.account, async () => {
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          fakeWhitelist
        );
      })
    ).rejects.toThrow(ZkUsdEngineErrors.INVALID_WHITELIST);
  });

  it('should not allow a price to be submitted with a price of 0', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await expect(
      testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.engine.contract.submitPrice(
            TestAmounts.ZERO,
            testHelper.whitelist
          );
        }
      )
    ).rejects.toThrow(ZkUsdEngineErrors.AMOUNT_ZERO);
  });

  it('should allow multiple whitelisted oracles to submit prices', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleNames = Array.from(whitelistedOracles.keys());

    // Submit prices from all whitelisted oracles
    for (const oracleName of oracleNames) {
      await testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.engine.contract.submitPrice(
            TestAmounts.PRICE_25_CENT,
            testHelper.whitelist
          );
        }
      );
    }

    const priceFeedActions = Mina.getActions(testHelper.engine.publicKey, {
      fromActionState: await testHelper.engine.contract.actionState.fetch(),
    });

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
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      }
    );

    // Settle the price update
    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    // Submit new price after settlement
    await testHelper.transaction(
      testHelper.agents[oracleName].account,
      async () => {
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_50_CENT,
          testHelper.whitelist
        );
      }
    );

    const actionState = await testHelper.engine.contract.actionState.fetch();
    const priceFeedActions = Mina.getActions(testHelper.engine.publicKey, {
      fromActionState: actionState,
    });
    expect(priceFeedActions[0].actions.length).toBe(1);
  });

  it('should handle maximum number of oracle submissions', async () => {
    const mxOracles = [];

    //First lets create some new addresses

    for (let i = 0; i < ZkUsdEngine.MAX_PARTICIPANTS; i++) {
      const oracleName = `maxOracle${i}`;
      const privateKey = PrivateKey.random();
      mxOracles.push({
        name: oracleName,
        privateKey: privateKey,
      });

      //transfer each oracle 50 mina

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
    const newWhitelist: OracleWhitelist = {
      addresses: mxOracles.map((oracle) => oracle.privateKey.toPublicKey()),
    };

    //update the whitelist
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateOracleWhitelist(newWhitelist);
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    //submit prices from all the new oracles
    for (const oracle of mxOracles) {
      const tx = await Mina.transaction(
        {
          sender: oracle.privateKey.toPublicKey(),
        },
        async () => {
          await testHelper.engine.contract.submitPrice(
            TestAmounts.PRICE_48_CENT,
            newWhitelist
          );
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

    //settle the actions
    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    //move block forward
    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    //expect price to be 48 cent
    const price = await testHelper.engine.contract.getPrice();

    expect(price.toString()).toEqual(TestAmounts.PRICE_48_CENT.toString());
  });

  it('should allow the fallback price to be updated with the admin key', async () => {
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateFallbackPrice(
          TestAmounts.PRICE_52_CENT
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    //move block forward
    testHelper.Local.setBlockchainLength(
      testHelper.Local.getNetworkState().blockchainLength.add(1)
    );

    const fallbackPrice =
      await testHelper.masterOracle.contract.getFallbackPrice();

    expect(fallbackPrice.toString()).toEqual(
      TestAmounts.PRICE_52_CENT.toString()
    );
  });

  it('should update the even fallback price if we are on an odd block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(1));
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateFallbackPrice(
          TestAmounts.PRICE_25_CENT
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const fallbackEvenPrice =
      await testHelper.masterOracle.contract.fallbackPriceEvenBlock.fetch();

    expect(fallbackEvenPrice?.toString()).toEqual(
      TestAmounts.PRICE_25_CENT.toString()
    );
  });
  it('should update the odd fallback price if we are on an even block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(2));
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

    const fallbackOddPrice =
      await testHelper.masterOracle.contract.fallbackPriceOddBlock.fetch();

    expect(fallbackOddPrice?.toString()).toEqual(
      TestAmounts.PRICE_2_USD.toString()
    );
  });
  it('should not allow the fallback price to be updated without the admin key', async () => {
    await expect(
      testHelper.transaction(testHelper.deployer, async () => {
        await testHelper.engine.contract.updateFallbackPrice(
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
          await testHelper.engine.contract.updateFallbackPrice(
            TestAmounts.ZERO
          );
        },
        {
          extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
        }
      )
    ).rejects.toThrow(ZkUsdMasterOracleErrors.AMOUNT_ZERO);
  });

  it('should pay out the oracle fee correctly', async () => {
    const packedData =
      await testHelper.engine.contract.protocolDataPacked.fetch();

    const protocolData = ProtocolData.unpack(packedData!);
    const oracleFee = protocolData.oracleFlatFee;

    //get the current balance of the price feed oracle
    const minaBalanceOfEngineBefore = Mina.getBalance(
      testHelper.engine.publicKey
    );

    const oracleFundsInEngineBefore =
      await testHelper.engine.contract.getAvailableOracleFunds();

    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleName = Array.from(whitelistedOracles.keys())[0];
    const oracle = testHelper.agents[oracleName].account;

    // Get oracle's initial balance
    const oracleBalanceBefore = Mina.getBalance(oracle);

    console.log('oracleBalanceBefore', oracleBalanceBefore.toString());

    // Submit price from oracle
    await testHelper.transaction(oracle, async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_25_CENT,
        testHelper.whitelist
      );
    });

    // Get oracle's balance after submission
    const oracleBalanceAfter = Mina.getBalance(oracle);

    console.log('oracleBalanceAfter', oracleBalanceAfter.toString());

    console.log('oracleFee', oracleFee.toString());

    const priceFeedOracleBalanceAfter = Mina.getBalance(
      testHelper.engine.publicKey
    );

    const oracleFundsInEngineAfter =
      await testHelper.engine.contract.getAvailableOracleFunds();

    console.log(
      'Available Oracle Funds Before',
      oracleFundsInEngineBefore.toString()
    );
    console.log(
      'Available Oracle Funds After',
      oracleFundsInEngineAfter.toString()
    );

    // Verify oracle received the fee
    expect(oracleBalanceAfter.toString()).toEqual(
      oracleBalanceBefore.add(oracleFee).toString()
    );

    expect(minaBalanceOfEngineBefore.sub(priceFeedOracleBalanceAfter)).toEqual(
      oracleFee
    );

    expect(oracleFundsInEngineBefore.sub(oracleFee)).toEqual(
      oracleFundsInEngineAfter
    );
  });

  it('should fail to submit the price if the contract runs out of available oracle funds', async () => {
    const packedProtocolData =
      await testHelper.engine.contract.protocolDataPacked.fetch();

    const protocolData = ProtocolData.unpack(packedProtocolData!);

    const oracleFee = protocolData.oracleFlatFee;

    //get the current balance of the price feed oracle
    const priceFeedOracleBalanceBefore =
      await testHelper.engine.contract.getAvailableOracleFunds();

    //set the fee to the balance of the oracle to drain the funds
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateOracleFee(
          priceFeedOracleBalanceBefore
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    //submit a price

    const whitelistedOracles = testHelper.whitelistedOracles;

    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await testHelper.transaction(
      testHelper.agents[oracleName].account,
      async () => {
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      }
    );

    const availableOracleFundsAfter =
      await testHelper.engine.contract.getAvailableOracleFunds();

    expect(availableOracleFundsAfter.toString()).toEqual(
      UInt64.zero.toString()
    );

    //set the fee to the balance of the oracle to drain the funds
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateOracleFee(
          TestAmounts.COLLATERAL_1_MINA
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    //Settle the price update
    await testHelper.transaction(testHelper.deployer, async () => {
      await testHelper.engine.contract.settlePriceUpdate();
    });

    //Submit a new price - this should fail
    await expect(
      testHelper.transaction(
        testHelper.agents[oracleName].account,
        async () => {
          await testHelper.engine.contract.submitPrice(
            TestAmounts.PRICE_50_CENT,
            testHelper.whitelist
          );
        }
      )
    ).rejects.toThrow(/Overflow/i);
  });
});
