import { AccountUpdate, Field, Mina, PrivateKey, UInt32, UInt64 } from 'o1js';
import { TestAmounts, TestHelper } from '../test-helper';
import { OracleWhitelist, PriceSubmission, ProtocolData } from '../../types';
import { ZkUsdEngine, ZkUsdEngineErrors } from '../../zkusd-engine';
import {
  ZkUsdMasterOracle,
  ZkUsdMasterOracleErrors,
} from '../../zkusd-master-oracle';
import { ZkUsdPriceTracker } from '../../zkusd-price-tracker';

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

  const getWriteTrackerAddress = () => {
    const isEven = testHelper.Local.getNetworkState()
      .blockchainLength.mod(2)
      .equals(UInt32.from(0))
      .toBoolean();

    return isEven
      ? ZkUsdEngine.EVEN_ORACLE_PRICE_TRACKER_ADDRESS
      : ZkUsdEngine.ODD_ORACLE_PRICE_TRACKER_ADDRESS;
  };

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

    await testHelper.transaction(testHelper.oracles[oracleName], async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_48_CENT,
        testHelper.whitelist
      );
    });

    console.log(
      'blockchainLength',
      testHelper.Local.getNetworkState().blockchainLength.toString()
    );

    const trackerAddress = getWriteTrackerAddress();

    const tracker = new ZkUsdPriceTracker(
      trackerAddress,
      testHelper.engine.contract.deriveTokenId()
    );

    const priceSubmission = await tracker.oracleOne.fetch();

    console.log('priceSubmission', priceSubmission?.packedData.toString());

    const submission = PriceSubmission.unpack(priceSubmission!);

    expect(submission.price).toEqual(TestAmounts.PRICE_48_CENT);
  });

  it('should submit the price to the even price tracker on an even block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(2));

    const whitelistedOracles = testHelper.whitelistedOracles;

    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await testHelper.transaction(testHelper.oracles[oracleName], async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_52_CENT,
        testHelper.whitelist
      );
    });

    const trackerAddress = getWriteTrackerAddress();

    expect(trackerAddress).toEqual(
      ZkUsdEngine.EVEN_ORACLE_PRICE_TRACKER_ADDRESS
    );

    const tracker = new ZkUsdPriceTracker(
      trackerAddress,
      testHelper.engine.contract.deriveTokenId()
    );

    const priceSubmission = await tracker.oracleOne.fetch();

    const submission = PriceSubmission.unpack(priceSubmission!);

    expect(submission.price).toEqual(TestAmounts.PRICE_52_CENT);
  });

  it('should submit the price to the odd price tracker on an odd block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(1001));

    const whitelistedOracles = testHelper.whitelistedOracles;

    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await testHelper.transaction(testHelper.oracles[oracleName], async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_49_CENT,
        testHelper.whitelist
      );
    });

    const trackerAddress = getWriteTrackerAddress();

    expect(trackerAddress).toEqual(
      ZkUsdEngine.ODD_ORACLE_PRICE_TRACKER_ADDRESS
    );

    const tracker = new ZkUsdPriceTracker(
      trackerAddress,
      testHelper.engine.contract.deriveTokenId()
    );

    const priceSubmission = await tracker.oracleOne.fetch();

    const submission = PriceSubmission.unpack(priceSubmission!);

    expect(submission.price).toEqual(TestAmounts.PRICE_49_CENT);
  });

  it('should emit the price submission event', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;

    const oracleName = Array.from(whitelistedOracles.keys())[0];

    await testHelper.transaction(testHelper.oracles[oracleName], async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_25_CENT,
        testHelper.whitelist
      );
    });

    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    console.log(contractEvents);

    expect(latestEvent.type).toEqual('PriceSubmission');
    // @ts-ignore
    expect(latestEvent.event.data.submitter.toBase58()).toEqual(
      testHelper.oracles[oracleName].publicKey.toBase58()
    );
    // @ts-ignore
    expect(latestEvent.event.data.price).toEqual(TestAmounts.PRICE_25_CENT);
    // @ts-ignore
    expect(latestEvent.event.data.oracleFee).toEqual(
      TestAmounts.COLLATERAL_1_MINA
    );
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
      testHelper.transaction(testHelper.oracles[oracleName], async () => {
        await testHelper.engine.contract.submitPrice(
          TestAmounts.ZERO,
          testHelper.whitelist
        );
      })
    ).rejects.toThrow(ZkUsdEngineErrors.AMOUNT_ZERO);
  });

  it('should allow all the whitelisted oracles to submit prices', async () => {
    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleNames = Array.from(whitelistedOracles.keys());

    // Submit prices from all whitelisted oracles
    for (const oracleName of oracleNames) {
      await testHelper.transaction(testHelper.oracles[oracleName], async () => {
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_25_CENT,
          testHelper.whitelist
        );
      });
    }

    const trackerAddress = getWriteTrackerAddress();

    const tracker = new ZkUsdPriceTracker(
      trackerAddress,
      testHelper.engine.contract.deriveTokenId()
    );

    const oracleOnePackedData = await tracker.oracleOne.fetch();
    const oracleTwoPackedData = await tracker.oracleTwo.fetch();
    const oracleThreePackedData = await tracker.oracleThree.fetch();
    const oracleFourPackedData = await tracker.oracleFour.fetch();
    const oracleFivePackedData = await tracker.oracleFive.fetch();
    const oracleSixPackedData = await tracker.oracleSix.fetch();
    const oracleSevenPackedData = await tracker.oracleSeven.fetch();
    const oracleEightPackedData = await tracker.oracleEight.fetch();

    const oracleOneSubmission = PriceSubmission.unpack(oracleOnePackedData!);
    const oracleTwoSubmission = PriceSubmission.unpack(oracleTwoPackedData!);
    const oracleThreeSubmission = PriceSubmission.unpack(
      oracleThreePackedData!
    );
    const oracleFourSubmission = PriceSubmission.unpack(oracleFourPackedData!);
    const oracleFiveSubmission = PriceSubmission.unpack(oracleFivePackedData!);
    const oracleSixSubmission = PriceSubmission.unpack(oracleSixPackedData!);
    const oracleSevenSubmission = PriceSubmission.unpack(
      oracleSevenPackedData!
    );
    const oracleEightSubmission = PriceSubmission.unpack(
      oracleEightPackedData!
    );

    expect(oracleOneSubmission.price).toEqual(TestAmounts.PRICE_25_CENT);
    expect(oracleTwoSubmission.price).toEqual(TestAmounts.PRICE_25_CENT);
    expect(oracleThreeSubmission.price).toEqual(TestAmounts.PRICE_25_CENT);
    expect(oracleFourSubmission.price).toEqual(TestAmounts.PRICE_25_CENT);
    expect(oracleFiveSubmission.price).toEqual(TestAmounts.PRICE_25_CENT);
    expect(oracleSixSubmission.price).toEqual(TestAmounts.PRICE_25_CENT);
    expect(oracleSevenSubmission.price).toEqual(TestAmounts.PRICE_25_CENT);
    expect(oracleEightSubmission.price).toEqual(TestAmounts.PRICE_25_CENT);
  });

  it('should update the odd price tracker on an odd block', async () => {
    testHelper.Local.setBlockchainLength(UInt32.from(1001));

    const whitelistedOracles = testHelper.whitelistedOracles;
    const oracleName = Array.from(whitelistedOracles.keys())[0];

    // Submit prices from all whitelisted oracles
    await testHelper.transaction(testHelper.oracles[oracleName], async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_2_USD,
        testHelper.whitelist
      );
    });

    const trackerAddress = ZkUsdEngine.ODD_ORACLE_PRICE_TRACKER_ADDRESS;

    const tracker = new ZkUsdPriceTracker(
      trackerAddress,
      testHelper.engine.contract.deriveTokenId()
    );

    const priceSubmission = await tracker.oracleOne.fetch();

    const submission = PriceSubmission.unpack(priceSubmission!);

    expect(submission.price).toEqual(TestAmounts.PRICE_2_USD);
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

  it('should emit the fallback price update event', async () => {
    await testHelper.transaction(
      testHelper.deployer,
      async () => {
        await testHelper.engine.contract.updateFallbackPrice(
          TestAmounts.PRICE_48_CENT
        );
      },
      {
        extraSigners: [TestHelper.protocolAdminKeyPair.privateKey],
      }
    );

    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('FallbackPriceUpdate');
    // @ts-ignore
    expect(latestEvent.event.data.newPrice).toEqual(TestAmounts.PRICE_48_CENT);
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
    const oracle = testHelper.oracles[oracleName];

    // Get oracle's initial balance
    const oracleBalanceBefore = Mina.getBalance(oracle.publicKey);

    // Submit price from oracle
    await testHelper.transaction(oracle, async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_25_CENT,
        testHelper.whitelist
      );
    });

    // Get oracle's balance after submission
    const oracleBalanceAfter = Mina.getBalance(oracle.publicKey);

    const priceFeedOracleBalanceAfter = Mina.getBalance(
      testHelper.engine.publicKey
    );

    const oracleFundsInEngineAfter =
      await testHelper.engine.contract.getAvailableOracleFunds();

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

    await testHelper.transaction(testHelper.oracles[oracleName], async () => {
      await testHelper.engine.contract.submitPrice(
        TestAmounts.PRICE_25_CENT,
        testHelper.whitelist
      );
    });

    const availableOracleFundsAfter =
      await testHelper.engine.contract.getAvailableOracleFunds();

    expect(availableOracleFundsAfter.toString()).toEqual(
      UInt64.zero.toString()
    );

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

    //Submit a new price - this should fail
    await expect(
      testHelper.transaction(testHelper.oracles[oracleName], async () => {
        await testHelper.engine.contract.submitPrice(
          TestAmounts.PRICE_50_CENT,
          testHelper.whitelist
        );
      })
    ).rejects.toThrow(/Overflow/i);
  });

  it('should allow anyone to deposit funds into the oracle', async () => {
    const oracleFundsBefore =
      await testHelper.engine.contract.getAvailableOracleFunds();

    console.log('oracleFunds', oracleFundsBefore.toString());

    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositOracleFunds(
        TestAmounts.COLLATERAL_50_MINA
      );
    });

    const oracleFundsAfterDeposit =
      await testHelper.engine.contract.getAvailableOracleFunds();

    expect(oracleFundsAfterDeposit.toString()).toEqual(
      oracleFundsBefore.add(TestAmounts.COLLATERAL_50_MINA).toString()
    );
  });

  it('should emit the oracle funds deposited event', async () => {
    await testHelper.transaction(testHelper.agents.alice.account, async () => {
      await testHelper.engine.contract.depositOracleFunds(
        TestAmounts.COLLATERAL_50_MINA
      );
    });

    const contractEvents = await testHelper.engine.contract.fetchEvents();
    const latestEvent = contractEvents[0];

    expect(latestEvent.type).toEqual('OracleFundsDeposited');

    // @ts-ignore
    expect(latestEvent.event.data.amount).toEqual(
      TestAmounts.COLLATERAL_50_MINA
    );
  });
});
