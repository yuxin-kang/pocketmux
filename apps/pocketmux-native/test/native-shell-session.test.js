import assert from 'node:assert/strict';
import test from 'node:test';

import { createNativeShellSession } from '../src/native-shell-session.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('credential access waits only for one shell registration', async () => {
  const registration = deferred();
  const invoke = () => {};
  let registrations = 0;
  let settled = false;
  const session = createNativeShellSession({
    initialize: () => { registrations += 1; return registration.promise; },
    getInvoke: () => invoke,
  });

  const first = session.readyInvoke().then((value) => { settled = true; return value; });
  const second = session.readyInvoke();
  await Promise.resolve();
  assert.equal(registrations, 1);
  assert.equal(settled, false);

  registration.resolve();
  assert.equal(await first, invoke);
  assert.equal(await second, invoke);
});

test('a failed shell registration returns no privileged invoke bridge', async () => {
  const errors = [];
  const session = createNativeShellSession({
    initialize: async () => { throw new Error('registration failed'); },
    getInvoke: () => () => {},
    onInitializationError: (error) => errors.push(error.message),
  });

  assert.equal(await session.readyInvoke(), null);
  assert.deepEqual(errors, ['registration failed']);
});

test('a missing bridge is not cached as a successful shell registration', async () => {
  let bridgeAvailable = false;
  let attempts = 0;
  const invoke = () => {};
  const errors = [];
  const session = createNativeShellSession({
    initialize: async () => { attempts += 1; },
    getInvoke: () => (bridgeAvailable ? invoke : null),
    onInitializationError: (error) => errors.push(error.message),
  });

  assert.equal(await session.readyInvoke(), null);
  bridgeAvailable = true;
  assert.equal(await session.readyInvoke(), invoke);
  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['native bridge unavailable']);
});

test('shell registration can be retried after a transient failure', async () => {
  let attempts = 0;
  const invoke = () => {};
  const session = createNativeShellSession({
    initialize: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
    },
    getInvoke: () => invoke,
  });

  assert.equal(await session.readyInvoke(), null);
  assert.equal(await session.readyInvoke(), invoke);
  assert.equal(attempts, 2);
});
