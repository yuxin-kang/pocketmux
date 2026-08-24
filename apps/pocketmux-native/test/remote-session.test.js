import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConnection } from '../src/connection.js';
import { beginRemoteSession, transitionRemoteSession } from '../src/remote-session.js';

test('keeps a token-bearing target only in the active in-memory session', () => {
  const connection = buildConnection('https://demo.example/?token=secret');
  const session = beginRemoteSession(connection.serverUrl, connection.targetUrl);

  assert.equal(session.serverUrl, 'https://demo.example/');
  assert.equal(session.targetUrl, 'https://demo.example/?token=secret');
  assert.equal(session.state, 'loading');
  assert.equal(Object.isFrozen(session), true);
});

test('preserves connection identity and storage warnings across load state transitions', () => {
  const loading = beginRemoteSession(
    'https://demo.example/',
    'https://demo.example/?token=secret',
    true,
  );
  const failed = transitionRemoteSession(loading, 'failed');
  const retried = transitionRemoteSession(failed, 'loading');
  const interactive = transitionRemoteSession(retried, 'interactive');
  const loaded = transitionRemoteSession(interactive, 'loaded');

  assert.equal(loaded.targetUrl, loading.targetUrl);
  assert.equal(loaded.storageWarning, true);
  assert.equal(loaded.state, 'loaded');
  assert.equal(interactive.state, 'interactive');
  assert.throws(() => transitionRemoteSession(loaded, 'unknown'), /invalid-remote-state/);
});

test('keeps logical SSH identity separate from the ephemeral tunnel origin', () => {
  const session = beginRemoteSession(
    'ssh://ssh-profile-01/',
    'http://127.0.0.1:43127/?native=1',
    false,
    { transportServerUrl: 'http://127.0.0.1:43127/', profile: { transport: 'ssh' } },
  );
  assert.equal(session.serverUrl, 'ssh://ssh-profile-01/');
  assert.equal(session.transportServerUrl, 'http://127.0.0.1:43127/');
  assert.equal(session.profile.transport, 'ssh');
});
