import assert from 'node:assert/strict';
import test from 'node:test';

import { errorMessageKey } from '../src/error-state.js';

test('keeps missing-token errors distinct from unsupported URL errors', () => {
  assert.equal(errorMessageKey(new Error('missing-token')), 'error.missingToken');
  assert.equal(errorMessageKey(new Error('unsupported-url')), 'error.unsupportedUrl');
});

test('uses a neutral message for unexpected runtime errors', () => {
  assert.equal(errorMessageKey(new TypeError('unexpected')), 'error.unexpected');
});
