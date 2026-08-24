const REMOTE_STATES = new Set(['loading', 'interactive', 'loaded', 'failed']);

export function beginRemoteSession(
  serverUrl,
  targetUrl,
  storageWarning = false,
  { transportServerUrl = serverUrl, profile = null } = {},
) {
  return Object.freeze({
    serverUrl,
    transportServerUrl,
    targetUrl,
    profile,
    storageWarning: Boolean(storageWarning),
    state: 'loading',
  });
}

export function transitionRemoteSession(session, state) {
  if (!session || !REMOTE_STATES.has(state)) throw new Error('invalid-remote-state');
  return Object.freeze({ ...session, state });
}
