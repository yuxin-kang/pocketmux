import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginConnectionAuthentication,
  recordNativeValidation,
  recordWebAuthentication,
  shouldIgnoreNativeInvalidation,
  shouldPersistAuthenticatedCredential,
} from '../src/connection-authentication.js';

test('does not treat an iframe load as authentication', () => {
  const state = beginConnectionAuthentication();

  assert.equal(shouldPersistAuthenticatedCredential(state), false);
  assert.equal(shouldIgnoreNativeInvalidation(state), false);
});

test('persists after Web authentication even when Native validation is unknown', () => {
  const state = recordWebAuthentication(recordNativeValidation(
    beginConnectionAuthentication(),
    'unknown',
  ));

  assert.equal(shouldPersistAuthenticatedCredential(state), true);
  assert.equal(shouldIgnoreNativeInvalidation(state), true);
});

test('Native valid validation is a persistence fallback without Web acknowledgement', () => {
  const state = recordNativeValidation(beginConnectionAuthentication(), 'valid');

  assert.equal(shouldPersistAuthenticatedCredential(state), true);
  assert.equal(shouldIgnoreNativeInvalidation(state), false);
});
