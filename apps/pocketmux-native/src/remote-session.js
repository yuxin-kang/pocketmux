const REMOTE_STATES = new Set(['loading', 'loaded', 'failed']);

export function beginRemoteSession(serverUrl, targetUrl, storageWarning = false) {
  return Object.freeze({
    serverUrl,
    targetUrl,
    storageWarning: Boolean(storageWarning),
    state: 'loading',
  });
}

export function transitionRemoteSession(session, state) {
  if (!session || !REMOTE_STATES.has(state)) throw new Error('invalid-remote-state');
  return Object.freeze({ ...session, state });
}
