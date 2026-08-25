import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthDiagnostics } from '../src/auth-diagnostics.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test('persists bounded, non-sensitive diagnostic events across instances', () => {
  const storage = memoryStorage();
  const diagnostics = createAuthDiagnostics(storage, { maxEvents: 2 });

  diagnostics.record('ssh-write-failed', {
    profileId: 'profile-12345678',
    kind: 'password',
    serverUrl: 'https://example.test/?token=top-secret',
    error: 'password=top-secret Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  });
  diagnostics.record('ignored', { secret: 'should-not-be-stored' });
  diagnostics.record('ssh-read-missing', { profileId: 'profile-12345678', kind: 'jumpPassword' });

  const raw = storage.getItem('pocketmux-native-auth-diagnostics-v1');
  assert.doesNotMatch(raw, /top-secret|should-not-be-stored|abcdefghijklmnopqrstuvwxyz/);
  assert.equal(JSON.parse(raw).length, 2);
  assert.equal(createAuthDiagnostics(storage).list()[0].event, 'ignored');
  assert.equal(createAuthDiagnostics(storage).list()[1].event, 'ssh-read-missing');
});

test('does not let unavailable storage affect diagnostics callers', () => {
  const storage = {
    getItem() { throw new Error('unavailable'); },
    setItem() { throw new Error('unavailable'); },
  };
  const diagnostics = createAuthDiagnostics(storage);
  assert.doesNotThrow(() => diagnostics.record('read-failed', { error: 'unavailable' }));
  assert.equal(diagnostics.list().length, 1);
});
