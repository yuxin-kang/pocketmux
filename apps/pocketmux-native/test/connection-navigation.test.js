import assert from 'node:assert/strict';
import test from 'node:test';

import { persistBeforeRemoteNavigation } from '../src/connection-navigation.js';
import { createConnectionOperationTracker } from '../src/connection-operations.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a slow credential write cannot reopen an older navigation', async () => {
  const operations = createConnectionOperationTracker();
  const write = deferred();
  const firstOperation = operations.begin();
  const first = persistBeforeRemoteNavigation({
    metadataPersisted: true,
    credentialAlreadyPersisted: false,
    persistCredential: () => write.promise,
    isCurrent: () => operations.isCurrent(firstOperation),
  });

  const secondOperation = operations.begin();
  assert.equal(operations.isCurrent(secondOperation), true);
  write.resolve(true);

  assert.deepEqual(await first, {
    cancelled: true,
    metadataPersisted: true,
    credentialPersisted: true,
  });
});

test('an existing credential does not perform another keyring write', async () => {
  let writes = 0;
  const result = await persistBeforeRemoteNavigation({
    metadataPersisted: true,
    credentialAlreadyPersisted: true,
    persistCredential: async () => { writes += 1; return true; },
    isCurrent: () => true,
  });

  assert.equal(writes, 0);
  assert.equal(result.cancelled, false);
  assert.equal(result.credentialPersisted, true);
});
