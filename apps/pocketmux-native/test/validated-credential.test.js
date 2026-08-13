import assert from 'node:assert/strict';
import test from 'node:test';

import { persistValidatedCredential } from '../src/validated-credential.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('waits for legacy migration before a newly validated token is persisted', async () => {
  const initialization = deferred();
  const writes = [];
  const persistence = persistValidatedCredential({
    initialization: initialization.promise,
    isCurrent: () => true,
    persistMetadata: () => { writes.push('metadata'); return true; },
    persistCredential: async () => { writes.push('new-token'); return true; },
  });

  await Promise.resolve();
  assert.deepEqual(writes, []);
  writes.push('legacy-token');
  initialization.resolve();

  assert.deepEqual(await persistence, {
    cancelled: false,
    metadataPersisted: true,
    credentialPersisted: true,
  });
  assert.deepEqual(writes, ['legacy-token', 'metadata', 'new-token']);
});

test('does not create an orphan credential when metadata storage fails', async () => {
  let credentialWrites = 0;
  const result = await persistValidatedCredential({
    initialization: Promise.resolve(),
    isCurrent: () => true,
    persistMetadata: () => false,
    persistCredential: async () => { credentialWrites += 1; return true; },
  });

  assert.equal(credentialWrites, 0);
  assert.deepEqual(result, {
    cancelled: false,
    metadataPersisted: false,
    credentialPersisted: false,
  });
});

test('does not start credential persistence after validation is superseded', async () => {
  let current = true;
  let credentialWrites = 0;
  const result = await persistValidatedCredential({
    initialization: Promise.resolve(),
    isCurrent: () => current,
    persistMetadata: () => {
      current = false;
      return true;
    },
    persistCredential: async () => { credentialWrites += 1; return true; },
  });

  assert.equal(credentialWrites, 0);
  assert.deepEqual(result, {
    cancelled: true,
    metadataPersisted: true,
    credentialPersisted: false,
  });
});

test('does not persist a credential for a connection superseded during initialization', async () => {
  const initialization = deferred();
  let current = true;
  let writes = 0;
  const persistence = persistValidatedCredential({
    initialization: initialization.promise,
    isCurrent: () => current,
    persistMetadata: () => { writes += 1; return true; },
    persistCredential: async () => { writes += 1; return true; },
  });

  current = false;
  initialization.resolve();
  const result = await persistence;

  assert.equal(result.cancelled, true);
  assert.equal(writes, 0);
});
