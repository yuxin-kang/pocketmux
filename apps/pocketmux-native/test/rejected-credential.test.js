import assert from 'node:assert/strict';
import test from 'node:test';

import { rejectCredential } from '../src/rejected-credential.js';

function rejectionHarness(overrides = {}) {
  let memoryToken = 'old-token';
  return {
    currentMemory: () => memoryToken,
    options: {
      expectedToken: 'old-token',
      currentToken: 'old-token',
      rejectStoredToken: async () => null,
      forgetMemory: () => { memoryToken = ''; },
      rememberMemory: (token) => { memoryToken = token; },
      ...overrides,
    },
  };
}

test('forgets a confirmed invalid token in memory even when keyring deletion fails', async () => {
  const harness = rejectionHarness({
    rejectStoredToken: async () => { throw new Error('locked'); },
  });
  assert.equal(await rejectCredential(harness.options), false);
  assert.equal(harness.currentMemory(), '');
});

test('adopts a newer stored token instead of deleting it', async () => {
  const harness = rejectionHarness({ rejectStoredToken: async () => 'new-token' });
  assert.equal(await rejectCredential(harness.options), true);
  assert.equal(harness.currentMemory(), 'new-token');
});

test('forgets the rejected in-memory token when keyring lookup is unavailable', async () => {
  const harness = rejectionHarness({
    rejectStoredToken: async () => { throw new Error('locked'); },
  });
  assert.equal(await rejectCredential(harness.options), false);
  assert.equal(harness.currentMemory(), '');
});
