export function beginConnectionAuthentication() {
  return Object.freeze({
    nativeValidation: 'pending',
    webAuthenticated: false,
  });
}

export function recordNativeValidation(state, validation) {
  if (!state || !['valid', 'invalid', 'unknown'].includes(validation)) return state;
  return Object.freeze({ ...state, nativeValidation: validation });
}

export function recordWebAuthentication(state) {
  if (!state) return state;
  return Object.freeze({ ...state, webAuthenticated: true });
}

export function shouldPersistAuthenticatedCredential(state) {
  return Boolean(state?.webAuthenticated || state?.nativeValidation === 'valid');
}

export function shouldIgnoreNativeInvalidation(state) {
  return Boolean(state?.webAuthenticated);
}
