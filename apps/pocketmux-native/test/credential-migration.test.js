import assert from 'node:assert/strict';
import test from 'node:test';

import {
  migrateLegacyCredentials,
  retainCurrentLegacyCredentials,
} from '../src/credential-migration.js';
import {
  loadConnectionProfiles,
  loadLegacyConnectionTokens,
  renameConnectionProfile,
  saveConnectionProfiles,
} from '../src/storage.js';

function credential(serverUrl, token) {
  return { serverUrl, token };
}

function options(overrides = {}) {
  return {
    buildConnection: (serverUrl, token) => ({ serverUrl, token }),
    credentialState: async () => 'missing',
    validateCredential: async () => 'valid',
    storeCredential: async () => true,
    persistMigrationProgress: () => true,
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test('an incomplete migration cannot restore plaintext removed by a concurrent secure write', () => {
  const replaced = credential('https://one.example/', 'old-token');
  const unresolved = credential('https://two.example/', 'pending-token');
  const current = [unresolved];

  assert.deepEqual(
    retainCurrentLegacyCredentials(current, [replaced, unresolved]),
    [unresolved],
  );
});

test('removes plaintext credentials only after the whole migration succeeds', async () => {
  const first = credential('https://one.example/', 'one');
  const second = credential('https://two.example/', 'two');
  const persisted = [];
  const result = await migrateLegacyCredentials([first, second], options({
    persistMigrationProgress: (remaining) => {
      persisted.push(remaining.map((item) => item.serverUrl));
      return true;
    },
  }));

  assert.deepEqual(result, { complete: true, remaining: [], failures: [] });
  assert.deepEqual(persisted, [[]]);
});

test('keeps only failed or incompatible plaintext credentials for retry', async () => {
  const first = credential('https://one.example/', 'one');
  const incompatible = credential('http://private.example/', 'two');
  const failed = credential('https://three.example/', 'three');
  const persisted = [];
  const result = await migrateLegacyCredentials([first, incompatible, failed], options({
    buildConnection: (serverUrl, token) => {
      if (serverUrl.startsWith('http:')) throw new Error('platform-policy');
      return { serverUrl, token };
    },
    storeCredential: async (connection) => connection.serverUrl !== failed.serverUrl,
    persistMigrationProgress: (remaining) => {
      persisted.push(remaining.map((item) => item.serverUrl));
      return true;
    },
  }));

  assert.equal(result.complete, false);
  assert.deepEqual(result.remaining, [incompatible, failed]);
  assert.deepEqual(persisted, []);
  assert.deepEqual(result.failures.map(({ serverUrl, stage }) => ({ serverUrl, stage })), [
    { serverUrl: incompatible.serverUrl, stage: 'build' },
    { serverUrl: failed.serverUrl, stage: 'store' },
  ]);
});

test('does not overwrite a newer secure credential with a legacy token', async () => {
  const stored = [];
  const result = await migrateLegacyCredentials([
    credential('https://one.example/', 'legacy-token'),
  ], options({
    credentialState: async () => 'present',
    validateCredential: async () => { throw new Error('must not validate'); },
    storeCredential: async (connection) => { stored.push(connection.token); return true; },
  }));

  assert.deepEqual(result, { complete: true, remaining: [], failures: [] });
  assert.deepEqual(stored, []);
});

test('drops rejected legacy credentials but retains inconclusive ones for retry', async () => {
  const invalid = credential('https://invalid.example/', 'old');
  const unknown = credential('https://unknown.example/', 'old');
  const result = await migrateLegacyCredentials([invalid, unknown], options({
    validateCredential: async (connection) => (
      connection.serverUrl === invalid.serverUrl ? 'invalid' : 'unknown'
    ),
  }));

  assert.equal(result.complete, false);
  assert.deepEqual(result.remaining, [unknown]);
  assert.deepEqual(result.failures.map(({ serverUrl, stage }) => ({ serverUrl, stage })), [
    { serverUrl: unknown.serverUrl, stage: 'validate' },
  ]);
});

test('retains plaintext when secure credential lookup is unavailable', async () => {
  let stored = 0;
  const legacy = credential('https://one.example/', 'legacy-token');
  const result = await migrateLegacyCredentials([legacy], options({
    credentialState: async () => 'unknown',
    storeCredential: async () => { stored += 1; return true; },
  }));

  assert.equal(result.complete, false);
  assert.deepEqual(result.remaining, [legacy]);
  assert.equal(result.failures[0].stage, 'lookup');
  assert.equal(result.failures[0].error.message, 'credential-state-unavailable');
  assert.equal(stored, 0);
});

test('keeps the previous plaintext state when persisting a migration step fails', async () => {
  const first = credential('https://one.example/', 'one');
  const second = credential('https://two.example/', 'two');
  const result = await migrateLegacyCredentials([first, second], options({
    persistMigrationProgress: () => false,
  }));

  assert.equal(result.complete, false);
  assert.deepEqual(result.remaining, [first, second]);
  assert.equal(result.failures[0].stage, 'persist');
  assert.equal(result.failures[0].error.message, 'migration-progress-persistence-failed');
});

test('resumes safely after one credential is secured and a later credential fails', async () => {
  const first = credential('https://one.example/', 'one');
  const second = credential('https://two.example/', 'two');
  const durableLegacyRecord = [first, second];
  const secureTokens = new Set();
  let secondAttempt = 0;
  let persistedLegacyRecord = durableLegacyRecord;

  const runMigration = () => migrateLegacyCredentials(
    persistedLegacyRecord,
    options({
      credentialState: async (connection) => (
        secureTokens.has(connection.serverUrl) ? 'present' : 'missing'
      ),
      storeCredential: async (connection) => {
        if (connection.serverUrl === second.serverUrl && secondAttempt++ === 0) return false;
        secureTokens.add(connection.serverUrl);
        return true;
      },
      persistMigrationProgress: (remaining) => {
        persistedLegacyRecord = remaining;
        return true;
      },
    }),
  );

  const interrupted = await runMigration();
  assert.equal(interrupted.complete, false);
  assert.deepEqual(interrupted.remaining, [second]);
  assert.deepEqual(persistedLegacyRecord, durableLegacyRecord);
  assert.deepEqual([...secureTokens], [first.serverUrl]);

  const resumed = await runMigration();
  assert.deepEqual(resumed, { complete: true, remaining: [], failures: [] });
  assert.deepEqual(persistedLegacyRecord, []);
  assert.deepEqual([...secureTokens], [first.serverUrl, second.serverUrl]);
});

test('metadata rename cannot erase a pending legacy credential before restart', async () => {
  const storage = memoryStorage();
  const key = 'profiles';
  storage.setItem(key, JSON.stringify([
    { serverUrl: 'https://one.example/', token: 'one' },
    { serverUrl: 'https://two.example/', token: 'two' },
  ]));
  const secureTokens = new Set();
  let secondAttempt = 0;

  const migrateFromStorage = () => {
    const legacy = loadLegacyConnectionTokens(storage, key);
    const profiles = loadConnectionProfiles(storage, key, 'recent');
    return migrateLegacyCredentials(legacy, options({
      credentialState: async (connection) => (
        secureTokens.has(connection.serverUrl) ? 'present' : 'missing'
      ),
      storeCredential: async (connection) => {
        if (connection.serverUrl === 'https://two.example/' && secondAttempt++ === 0) return false;
        secureTokens.add(connection.serverUrl);
        return true;
      },
      persistMigrationProgress: (remaining) => saveConnectionProfiles(
        storage,
        key,
        profiles,
        remaining,
      ),
    }));
  };

  const interrupted = await migrateFromStorage();
  assert.equal(interrupted.complete, false);

  const renamed = renameConnectionProfile(
    loadConnectionProfiles(storage, key, 'recent'),
    'https://one.example/',
    'Renamed one',
  );
  assert.equal(saveConnectionProfiles(storage, key, renamed, loadLegacyConnectionTokens(storage, key)), true);
  assert.deepEqual(loadLegacyConnectionTokens(storage, key), [
    { serverUrl: 'https://one.example/', token: 'one' },
    { serverUrl: 'https://two.example/', token: 'two' },
  ]);

  const resumed = await migrateFromStorage();
  assert.equal(resumed.complete, true);
  assert.deepEqual(loadLegacyConnectionTokens(storage, key), []);
  assert.deepEqual(loadConnectionProfiles(storage, key, 'recent'), [
    { serverUrl: 'https://one.example/', name: 'Renamed one' },
    { serverUrl: 'https://two.example/' },
  ]);
});

test('preserves validation and keyring failure causes without exposing plaintext tokens', async () => {
  const validationError = new Error('validation transport failed');
  const keyringError = new Error('keyring locked');
  const validationFailure = credential('https://validate.example/', 'validation-secret');
  const keyringFailure = credential('https://keyring.example/', 'keyring-secret');
  let persistedSteps = 0;
  const result = await migrateLegacyCredentials([validationFailure, keyringFailure], options({
    validateCredential: async (connection) => {
      if (connection.serverUrl === validationFailure.serverUrl) throw validationError;
      return 'valid';
    },
    storeCredential: async () => { throw keyringError; },
    persistMigrationProgress: () => {
      persistedSteps += 1;
      return true;
    },
  }));

  assert.deepEqual(result.failures.map(({ serverUrl, stage, error }) => ({ serverUrl, stage, error })), [
    { serverUrl: validationFailure.serverUrl, stage: 'validate', error: validationError },
    { serverUrl: keyringFailure.serverUrl, stage: 'store', error: keyringError },
  ]);
  assert.equal(JSON.stringify(result.failures).includes('validation-secret'), false);
  assert.equal(JSON.stringify(result.failures).includes('keyring-secret'), false);
  assert.equal(persistedSteps, 0);
});
