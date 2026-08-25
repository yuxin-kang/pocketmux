const DEFAULT_STORAGE_KEY = 'pocketmux-native-auth-diagnostics-v1';
const DEFAULT_MAX_EVENTS = 160;
const DETAIL_KEYS = new Set([
  'serverUrl',
  'profileId',
  'kind',
  'attempt',
  'retry',
  'servers',
  'present',
  'missing',
  'unknown',
  'pending',
  'error',
  'reason',
  'stage',
  'authMethod',
  'jumpAuthMethod',
  'hasJump',
  'targetProvided',
  'jumpProvided',
  'targetPasswordProvided',
  'targetPrivateKeyProvided',
  'jumpPasswordProvided',
  'jumpPrivateKeyProvided',
  'build',
]);

function safeEndpoint(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.replace(/[?&#].*$/, '').slice(0, 180);
  }
}

function safeError(value) {
  return String(value || '')
    .replace(/([?&](?:token|secret|password|privateKey|passphrase)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, '[redacted]')
    .slice(0, 220);
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (!DETAIL_KEYS.has(key)) continue;
    if (key === 'serverUrl') {
      const endpoint = safeEndpoint(value);
      if (endpoint) result.serverUrl = endpoint;
    } else if (key === 'error') {
      const error = safeError(value);
      if (error) result.error = error;
    } else if (
      key === 'profileId'
      || key === 'kind'
      || key === 'reason'
      || key === 'stage'
      || key === 'authMethod'
      || key === 'jumpAuthMethod'
      || key === 'build'
    ) {
      const text = String(value || '').slice(0, 96);
      if (text) result[key] = text;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

function readEvents(storage, storageKey) {
  try {
    const parsed = JSON.parse(storage?.getItem(storageKey) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry === 'object').slice(-DEFAULT_MAX_EVENTS);
  } catch {
    return [];
  }
}

export function createAuthDiagnostics(
  storage,
  { storageKey = DEFAULT_STORAGE_KEY, maxEvents = DEFAULT_MAX_EVENTS } = {},
) {
  let events = readEvents(storage, storageKey);

  const persist = () => {
    try {
      storage?.setItem(storageKey, JSON.stringify(events));
    } catch {
      // Diagnostics must never affect connection or credential behavior.
    }
  };

  return {
    record(event, details = {}) {
      const entry = {
        at: new Date().toISOString(),
        event: String(event || 'unknown').slice(0, 80),
        details: sanitizeDetails(details),
      };
      events = [...events, entry].slice(-maxEvents);
      persist();
      return entry;
    },
    list() {
      return events.map((entry) => ({
        ...entry,
        details: { ...entry.details },
      }));
    },
    clear() {
      events = [];
      persist();
    },
  };
}

export { DEFAULT_STORAGE_KEY };
