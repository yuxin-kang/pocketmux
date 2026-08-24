import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadConnectionProfiles,
  loadLegacyConnectionTokens,
  loadRecentServers,
  readStoredValue,
  rememberConnectionProfile,
  removeConnectionProfile,
  renameConnectionProfile,
  rememberRecentServer,
  saveConnectionProfiles,
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

test('persists normalized server metadata without access tokens', () => {
  const storage = memoryStorage();
  const result = rememberConnectionProfile(
    storage,
    'profiles',
    [],
    { serverUrl: 'https://demo.example/path', token: 'saved-secret' },
  );

  assert.equal(result.persisted, true);
  assert.deepEqual(result.connectionProfiles, [
    { serverUrl: 'https://demo.example/path/' },
  ]);
  assert.deepEqual(loadConnectionProfiles(storage, 'profiles', 'recent'), result.connectionProfiles);
  assert.doesNotMatch(storage.getItem('profiles'), /saved-secret/);
});

test('preserves only unresolved legacy credentials during metadata writes', () => {
  const storage = memoryStorage();
  const key = 'profiles';
  const profiles = [
    { serverUrl: 'https://one.example/', name: 'Renamed one' },
    { serverUrl: 'https://two.example/' },
  ];

  assert.equal(saveConnectionProfiles(storage, key, profiles, [
    { serverUrl: 'https://two.example/', token: 'pending-two' },
    { serverUrl: 'https://removed.example/', token: 'removed' },
  ]), true);

  assert.deepEqual(JSON.parse(storage.getItem(key)), [
    { serverUrl: 'https://one.example/', name: 'Renamed one' },
    { serverUrl: 'https://two.example/', token: 'pending-two' },
  ]);
  assert.deepEqual(loadLegacyConnectionTokens(storage, key), [
    { serverUrl: 'https://two.example/', token: 'pending-two' },
  ]);
});

test('keeps the most recently used authenticated connection first across app restarts', () => {
  const storage = memoryStorage();
  const first = rememberConnectionProfile(
    storage,
    'profiles',
    [],
    { serverUrl: 'https://first.example/', token: 'first-secret' },
  );
  const second = rememberConnectionProfile(
    storage,
    'profiles',
    first.connectionProfiles,
    { serverUrl: 'https://second.example/', token: 'second-secret' },
  );

  assert.deepEqual(loadConnectionProfiles(storage, 'profiles', 'recent'), [
    { serverUrl: 'https://second.example/' },
    { serverUrl: 'https://first.example/' },
  ]);
});

test('migrates legacy token-free history and keeps metadata token-free', () => {
  const storage = memoryStorage();
  storage.setItem('recent', JSON.stringify(['https://demo.example/']));

  const migrated = loadConnectionProfiles(storage, 'profiles', 'recent');
  assert.deepEqual(migrated, [{ serverUrl: 'https://demo.example/' }]);

  const updated = rememberConnectionProfile(
    storage,
    'profiles',
    migrated,
    { serverUrl: 'https://demo.example/', token: 'replacement' },
  );
  assert.deepEqual(updated.connectionProfiles, [
    { serverUrl: 'https://demo.example/' },
  ]);
});

test('extracts legacy plaintext tokens once for secure-store migration', () => {
  const storage = memoryStorage();
  storage.setItem('profiles', JSON.stringify([
    { serverUrl: 'https://one.example/', token: 'one-secret', name: 'One' },
    { serverUrl: 'ftp://invalid.example/', token: 'ignored' },
    { serverUrl: 'https://two.example/', token: '' },
  ]));

  assert.deepEqual(loadLegacyConnectionTokens(storage, 'profiles'), [
    { serverUrl: 'https://one.example/', token: 'one-secret' },
  ]);
  assert.deepEqual(loadConnectionProfiles(storage, 'profiles', 'recent'), [
    { serverUrl: 'https://one.example/', name: 'One' },
    { serverUrl: 'https://two.example/' },
  ]);
  assert.equal(
    saveConnectionProfiles(
      storage,
      'profiles',
      loadConnectionProfiles(storage, 'profiles', 'recent'),
    ),
    true,
  );
  assert.doesNotMatch(storage.getItem('profiles'), /one-secret|"token"/);
});

test('removing a connection removes only its metadata profile', () => {
  const profiles = [
    { serverUrl: 'https://one.example/' },
    { serverUrl: 'https://two.example/' },
  ];

  assert.deepEqual(removeConnectionProfile(profiles, 'https://one.example/'), [
    { serverUrl: 'https://two.example/' },
  ]);
});

test('renames a connection without changing its server URL or ordering', () => {
  const profiles = [
    { serverUrl: 'https://one.example/' },
    { serverUrl: 'https://two.example/' },
  ];

  assert.deepEqual(renameConnectionProfile(profiles, 'https://two.example/', '  Home   GPU  '), [
    { serverUrl: 'https://one.example/' },
    { serverUrl: 'https://two.example/', name: 'Home GPU' },
  ]);
});

test('keeps a custom connection name when metadata is refreshed and clears it with an empty rename', () => {
  const storage = memoryStorage();
  const current = [
    { serverUrl: 'https://demo.example/', name: 'Training PC' },
  ];
  const remembered = rememberConnectionProfile(
    storage,
    'profiles',
    current,
    { serverUrl: 'https://demo.example/', token: 'new-secret' },
  );

  assert.deepEqual(remembered.connectionProfiles, [
    { serverUrl: 'https://demo.example/', name: 'Training PC' },
  ]);
  assert.deepEqual(renameConnectionProfile(remembered.connectionProfiles, 'https://demo.example/', '  '), [
    { serverUrl: 'https://demo.example/' },
  ]);
});

test('keeps metadata ordering after switching away, switching back, and reloading storage', () => {
  const storage = memoryStorage();
  const profiles = [
    { serverUrl: 'https://first.example/', name: 'First' },
    { serverUrl: 'https://second.example/', name: 'Second' },
  ];
  const refreshed = rememberConnectionProfile(
    storage,
    'profiles',
    profiles,
    { serverUrl: 'https://first.example/', token: 'fresh-secret' },
  );
  const switchedAway = rememberConnectionProfile(
    storage,
    'profiles',
    refreshed.connectionProfiles,
    refreshed.connectionProfiles.find((profile) => profile.serverUrl === 'https://second.example/'),
  );

  assert.deepEqual(loadConnectionProfiles(storage, 'profiles', 'recent'), [
    { serverUrl: 'https://second.example/', name: 'Second' },
    { serverUrl: 'https://first.example/', name: 'First' },
  ]);

  const switchedBack = rememberConnectionProfile(
    storage,
    'profiles',
    switchedAway.connectionProfiles,
    switchedAway.connectionProfiles.find((profile) => profile.serverUrl === 'https://first.example/'),
  );
  assert.equal(switchedBack.connectionProfiles[0].name, 'First');
  assert.equal(switchedBack.persisted, true);
});

test('persists SSH metadata with a stable logical id and no runtime tunnel port', () => {
  const storage = memoryStorage();
  const profile = {
    id: 'ssh-profile-01',
    transport: 'ssh',
    serverUrl: 'ssh://ssh-profile-01/',
    name: 'GPU host',
    ssh: {
      host: 'server.example.com',
      port: 22,
      username: 'root',
      authMethod: 'password',
      remoteHost: '127.0.0.1',
      remotePort: 3789,
      hostKeyFingerprint: 'SHA256:abc',
    },
  };
  const remembered = rememberConnectionProfile(storage, 'profiles', [], profile);
  assert.equal(remembered.persisted, true);
  assert.deepEqual(loadConnectionProfiles(storage, 'profiles', 'recent'), [profile]);
  assert.doesNotMatch(storage.getItem('profiles'), /127\.0\.0\.1:\d{4,5}/);
});

test('round-trips a ProxyJump profile without storing jump secrets or runtime ports', () => {
  const storage = memoryStorage();
  const profile = {
    transport: 'ssh',
    name: 'Via gateway',
    ssh: {
      host: 'target.example.com',
      port: 2222,
      username: 'appuser',
      authMethod: 'password',
      remotePort: 3789,
      hostKeyFingerprint: 'SHA256:target',
      jump: {
        host: 'jump.example.com',
        port: 22,
        username: 'jumpuser',
        authMethod: 'password',
        hostKeyFingerprint: 'SHA256:jump',
      },
    },
  };
  const remembered = rememberConnectionProfile(storage, 'profiles', [], profile);
  const [stored] = loadConnectionProfiles(storage, 'profiles', 'recent');
  assert.equal(remembered.persisted, true);
  assert.equal(stored.ssh.jump.host, 'jump.example.com');
  assert.equal(stored.ssh.host, 'target.example.com');
  assert.match(stored.serverUrl, /^ssh:\/\/[a-z0-9_-]+\/$/);
  assert.doesNotMatch(storage.getItem('profiles'), /jumpPassword|jumpPrivateKey|runtimePort/);
});

test('keeps SSH profiles with different Pocketmux ports distinct', () => {
  const storage = memoryStorage();
  const base = {
    transport: 'ssh',
    ssh: {
      host: 'target.example.com',
      port: 2222,
      username: 'appuser',
      authMethod: 'password',
      remoteHost: '127.0.0.1',
      hostKeyFingerprint: '',
    },
  };
  const first = rememberConnectionProfile(storage, 'profiles', [], {
    ...base,
    ssh: { ...base.ssh, remotePort: 3789 },
  });
  const second = rememberConnectionProfile(storage, 'profiles', first.connectionProfiles, {
    ...base,
    ssh: { ...base.ssh, remotePort: 3790 },
  });
  assert.equal(second.connectionProfiles.length, 2);
  assert.notEqual(second.connectionProfiles[0].serverUrl, second.connectionProfiles[1].serverUrl);
});
