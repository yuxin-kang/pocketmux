import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadConnectionProfiles,
  loadRecentServers,
  readStoredValue,
  rememberConnectionProfile,
  removeConnectionProfile,
  rememberRecentServer,
  writeStoredValue,
} from '../src/storage.js';

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

const unavailableStorage = {
  getItem() {
    throw new Error('storage unavailable');
  },
  setItem() {
    throw new Error('storage unavailable');
  },
};

test('loads and stores normalized token-free recent servers', () => {
  const storage = memoryStorage();
  const result = rememberRecentServer(
    storage,
    'recent',
    [],
    'https://demo.example/?token=secret',
  );

  assert.equal(result.persisted, true);
  assert.deepEqual(result.recentServers, ['https://demo.example/']);
  assert.deepEqual(loadRecentServers(storage, 'recent'), ['https://demo.example/']);
});

test('storage failures degrade gracefully without blocking a valid connection', () => {
  assert.equal(readStoredValue(unavailableStorage, 'language', 'zh'), 'zh');
  assert.equal(writeStoredValue(unavailableStorage, 'language', 'en'), false);
  assert.deepEqual(loadRecentServers(unavailableStorage, 'recent'), []);

  const result = rememberRecentServer(
    unavailableStorage,
    'recent',
    [],
    'https://demo.example/?token=secret',
  );
  assert.equal(result.persisted, false);
  assert.deepEqual(result.recentServers, ['https://demo.example/']);
});

test('missing or malformed storage data falls back safely', () => {
  const storage = memoryStorage();
  assert.equal(readStoredValue(null, 'missing', 'fallback'), 'fallback');
  assert.equal(writeStoredValue(null, 'missing', 'value'), false);
  storage.setItem('recent', '{broken json');
  assert.deepEqual(loadRecentServers(storage, 'recent'), []);
});

test('persists normalized server profiles with their access tokens', () => {
  const storage = memoryStorage();
  const result = rememberConnectionProfile(
    storage,
    'profiles',
    [],
    { serverUrl: 'https://demo.example/path', token: 'saved-secret' },
  );

  assert.equal(result.persisted, true);
  assert.deepEqual(result.connectionProfiles, [
    { serverUrl: 'https://demo.example/path/', token: 'saved-secret' },
  ]);
  assert.deepEqual(loadConnectionProfiles(storage, 'profiles', 'recent'), result.connectionProfiles);
});

test('migrates legacy token-free history and replaces a saved token by server', () => {
  const storage = memoryStorage();
  storage.setItem('recent', JSON.stringify(['https://demo.example/']));

  const migrated = loadConnectionProfiles(storage, 'profiles', 'recent');
  assert.deepEqual(migrated, [{ serverUrl: 'https://demo.example/', token: '' }]);

  const updated = rememberConnectionProfile(
    storage,
    'profiles',
    migrated,
    { serverUrl: 'https://demo.example/', token: 'replacement' },
  );
  assert.deepEqual(updated.connectionProfiles, [
    { serverUrl: 'https://demo.example/', token: 'replacement' },
  ]);
});

test('removing a connection removes its saved token with the server profile', () => {
  const profiles = [
    { serverUrl: 'https://one.example/', token: 'one-secret' },
    { serverUrl: 'https://two.example/', token: 'two-secret' },
  ];

  assert.deepEqual(removeConnectionProfile(profiles, 'https://one.example/'), [
    { serverUrl: 'https://two.example/', token: 'two-secret' },
  ]);
});
