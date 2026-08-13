const ERROR_MESSAGE_KEYS = new Map([
  ['invalid-url', 'error.invalidUrl'],
  ['public-http', 'error.publicHttp'],
  ['android-http', 'error.androidHttp'],
  ['native-origin', 'error.nativeOrigin'],
  ['missing-token', 'error.missingToken'],
  ['unsupported-url', 'error.unsupportedUrl'],
]);

export function errorMessageKey(error) {
  return ERROR_MESSAGE_KEYS.get(error?.message) || 'error.unexpected';
}
