import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeConnections } from '../src/connection-initialization.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('finishes migration but does not restore a previous connection after the user acts during hydration', async () => {
  const hydration = deferred();
  let current = 1;
  let migrated = 0;
  let hydratedApplied = 0;
  let completedApplied = 0;
  const initializing = initializeConnections({
    operation: 1,
    isCurrent: (operation) => operation === current,
    hydrateCredentials: () => hydration.promise,
    migrateLegacyCredentials: async () => { migrated += 1; return true; },
    applyHydratedState: () => { hydratedApplied += 1; },
    applyCompletedState: () => { completedApplied += 1; },
  });

  current = 2;
  hydration.resolve({ complete: true, states: new Map() });
  const result = await initializing;

  assert.equal(result.superseded, true);
  assert.equal(migrated, 1);
  assert.equal(hydratedApplied, 1);
  assert.equal(completedApplied, 0);
});

test('does not restore a previous connection after the user acts during migration', async () => {
  const migration = deferred();
  let current = 1;
  let hydratedApplied = 0;
  let completedApplied = 0;
  const initializing = initializeConnections({
    operation: 1,
    isCurrent: (operation) => operation === current,
    hydrateCredentials: async () => ({ complete: true, states: new Map() }),
    migrateLegacyCredentials: () => migration.promise,
    applyHydratedState: () => { hydratedApplied += 1; },
    applyCompletedState: () => { completedApplied += 1; },
  });

  current = 2;
  migration.resolve(true);
  const result = await initializing;

  assert.equal(result.superseded, true);
  assert.equal(hydratedApplied, 1);
  assert.equal(completedApplied, 0);
});

test('applies the complete startup state when initialization remains current', async () => {
  const applied = [];
  const hydration = { complete: true, states: new Map([['https://one.example/', 'present']]) };
  const result = await initializeConnections({
    operation: 1,
    isCurrent: (operation) => operation === 1,
    hydrateCredentials: async () => hydration,
    migrateLegacyCredentials: async (states) => states.get('https://one.example/') === 'present',
    applyHydratedState: () => applied.push('hydrated'),
    applyCompletedState: ({ migrated }) => applied.push(`complete:${migrated}`),
  });

  assert.equal(result.superseded, false);
  assert.deepEqual(applied, ['complete:true']);
});
