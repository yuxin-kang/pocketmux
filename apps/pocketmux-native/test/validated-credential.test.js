import assert from 'node:assert/strict';
import test from 'node:test';

import { persistValidatedCredential } from '../src/validated-credential.js';

test('persists a newly entered token without waiting for app initialization', async () => {
  const writes = [];
  const result = await persistValidatedCredential({
    isCurrent: () => true,
    persistMetadata: () => { writes.push('metadata'); return true; },
    persistCredential: async () => { writes.push('new-token'); return true; },
  });

  assert.deepEqual(result, {
    cancelled: false,
    metadataPersisted: true,
    credentialPersisted: true,
  });
  assert.deepEqual(writes, ['metadata', 'new-token']);
});

test('does not create an orphan credential when metadata storage fails', async () => {
  let credentialWrites = 0;
  const result = await persistValidatedCredential({
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

test('does not persist a credential for an already superseded connection', async () => {
  let writes = 0;
  const result = await persistValidatedCredential({
    isCurrent: () => false,
    persistMetadata: () => { writes += 1; return true; },
    persistCredential: async () => { writes += 1; return true; },
  });

  assert.equal(result.cancelled, true);
  assert.equal(writes, 0);
});
