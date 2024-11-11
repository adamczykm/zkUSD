import { ZkUsdProtocolVault } from '../zkusd-protocol-vault';
import { ZkUsdVault } from '../zkusd-vault';
import { TestHelper, TestAmounts } from './test-helper';
import {
  AccountUpdate,
  Permissions,
  DeployArgs,
  method,
  Mina,
  PublicKey,
  SmartContract,
  state,
  State,
  UInt64,
  VerificationKey,
  Int64,
} from 'o1js';

describe('zkUSD Price Feed Oracle Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
    testHelper.createAgents(['alice', 'bob']);

    await testHelper.deployVaults(['alice']);
  });

  it('Should be true', () => {
    expect(true).toBe(true);
  });
});
