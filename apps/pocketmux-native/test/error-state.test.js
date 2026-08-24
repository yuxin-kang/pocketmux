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

test('maps ProxyJump failures to the SSH connection message', () => {
  assert.equal(errorMessageKey(new Error('ssh-jump-auth-rejected')), 'error.sshUnavailable');
  assert.equal(errorMessageKey(new Error('ssh-target-connect-failed')), 'error.sshUnavailable');
  assert.equal(errorMessageKey(new Error('ssh-jump-host-key-missing')), 'error.sshUnavailable');
});

test('keeps secure-storage failures and missing SSH credentials actionable', () => {
  assert.equal(errorMessageKey(new Error('credential-persistence-failed')), 'error.credentialPersistenceFailed');
  assert.equal(errorMessageKey(new Error('ssh-secret-persistence-failed')), 'error.sshSecretPersistenceFailed');
  assert.equal(errorMessageKey(new Error('ssh-secret-unavailable')), 'error.sshSecretUnavailable');
  assert.equal(errorMessageKey(new Error('ssh-jump-password-required')), 'error.sshCredentialsRequired');
});
