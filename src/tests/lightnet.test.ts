import { TestHelper } from './test-helper.js';

import { describe, it, before } from 'node:test';

describe('zkUSD Lightnet Test Suite', () => {
  const testHelper = new TestHelper();

  before(async () => {
    await testHelper.initChain({ useLightnet: true });
  });
});
