function notify(callback, value) {
  if (!callback) return;
  try {
    Promise.resolve(callback(value)).catch(() => undefined);
  } catch {
    // A late-result observer must never change the read promise outcome.
  }
}

export function withCredentialReadTimeout(
  readPromise,
  timeoutMs,
  { onLateValue, onLateError } = {},
) {
  let timedOut = false;
  let timer;
  const trackedRead = Promise.resolve(readPromise).then(
    (value) => {
      if (timedOut) notify(onLateValue, value);
      return value;
    },
    (error) => {
      if (timedOut) notify(onLateError, error);
      throw error;
    },
  );
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('credential-read-timeout'));
    }, timeoutMs);
  });
  return Promise.race([trackedRead, timeout]).finally(() => clearTimeout(timer));
}

export function mergeCredentialReadResults(currentTokens, serverUrls, results) {
  const states = new Map();
  serverUrls.forEach((serverUrl, index) => {
    const result = results?.[index];
    if (!result || typeof result !== 'object' || !('Ok' in result)) {
      states.set(serverUrl, 'unknown');
      return;
    }

    const token = typeof result.Ok === 'string' ? result.Ok.trim() : '';
    const currentToken = currentTokens.get(serverUrl);
    if (token) {
      // Never let a delayed startup read overwrite a token entered during the
      // same process. An absent or identical value is safe to hydrate.
      if (!currentToken || currentToken === token) currentTokens.set(serverUrl, token);
      states.set(serverUrl, 'present');
      return;
    }

    // A missing result must not erase an in-flight/newer in-memory token.
    states.set(serverUrl, currentToken ? 'present' : 'missing');
  });
  return states;
}

export function shouldRetryCredentialRead(states) {
  return [...(states?.values?.() || [])].some(
    (state) => state === 'missing' || state === 'unknown',
  );
}
