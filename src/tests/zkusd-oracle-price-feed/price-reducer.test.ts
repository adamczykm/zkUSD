import { TestHelper } from '../test-helper';

describe('zkUSD Price Feed Oracle Price Reducer Test Suite', () => {
  const testHelper = new TestHelper();

  beforeAll(async () => {
    await testHelper.initChain();
    await testHelper.deployTokenContracts();
  });

  it('placeholder', () => {
    expect(true).toBe(true);
  });
});
