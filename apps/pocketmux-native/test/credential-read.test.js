import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeCredentialReadResults,
  withCredentialReadTimeout,
} from '../src/credential-read.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('keeps a delayed keyring read result after the UI timeout', async () => {
  const read = deferred();
  const late = deferred();
  const timed = withCredentialReadTimeout(read.promise, 5, {
    onLateValue: (value) => late.resolve(value),
  });

  await assert.rejects(timed, /credential-read-timeout/);
  read.resolve([{ Ok: 'token-after-cold-start' }]);
  assert.deepEqual(await late.promise, [{ Ok: 'token-after-cold-start' }]);
});

test('does not let a delayed missing result erase a newer in-memory token', () => {
  const tokens = new Map([['https://example.test/', 'new-token']]);
  const states = mergeCredentialReadResults(tokens, ['https://example.test/'], [{ Ok: null }]);

  assert.equal(tokens.get('https://example.test/'), 'new-token');
  assert.equal(states.get('https://example.test/'), 'present');
});

test('classifies malformed keyring results as unknown', () => {
  const states = mergeCredentialReadResults(
    new Map(),
    ['https://example.test/'],
    [{ Err: 'keystore unavailable' }],
  );

  assert.equal(states.get('https://example.test/'), 'unknown');
});
