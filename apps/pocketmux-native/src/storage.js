import { normalizeRecentServers, rememberServer } from './connection.js';

const MAX_CONNECTION_PROFILES = 5;

function normalizeConnectionProfiles(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    const serverUrl = typeof item === 'string' ? item : item?.serverUrl;
    const token = typeof item === 'object' && typeof item?.token === 'string' ? item.token.trim() : '';
    try {
      const normalizedServer = normalizeRecentServers([serverUrl])[0];
      if (!normalizedServer || normalized.some((profile) => profile.serverUrl === normalizedServer)) continue;
      normalized.push({ serverUrl: normalizedServer, token });
    } catch {
      // Ignore stale or malformed profiles.
    }
    if (normalized.length === MAX_CONNECTION_PROFILES) break;
  }
  return normalized;
}

export function readStoredValue(storage, key, fallback = null) {
  try {
    return storage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredValue(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function loadRecentServers(storage, key) {
  try {
    return normalizeRecentServers(JSON.parse(readStoredValue(storage, key, '[]')));
  } catch {
    return [];
  }
}

export function rememberRecentServer(storage, key, current, serverUrl) {
  const recentServers = rememberServer(current, serverUrl);
  return {
    recentServers,
    persisted: writeStoredValue(storage, key, JSON.stringify(recentServers)),
  };
}

export function loadConnectionProfiles(storage, key, legacyKey) {
  const stored = readStoredValue(storage, key);
  if (stored !== null) {
    try {
      return normalizeConnectionProfiles(JSON.parse(stored));
    } catch {
      return [];
    }
  }
  return loadRecentServers(storage, legacyKey).map((serverUrl) => ({ serverUrl, token: '' }));
}

export function rememberConnectionProfile(storage, key, current, connection) {
  const [profile] = normalizeConnectionProfiles([connection]);
  if (!profile) return { connectionProfiles: normalizeConnectionProfiles(current), persisted: false };
  const connectionProfiles = [
    profile,
    ...normalizeConnectionProfiles(current).filter((item) => item.serverUrl !== profile.serverUrl),
  ].slice(0, MAX_CONNECTION_PROFILES);
  return {
    connectionProfiles,
    persisted: writeStoredValue(storage, key, JSON.stringify(connectionProfiles)),
  };
}

export function saveConnectionProfiles(storage, key, connectionProfiles) {
  return writeStoredValue(storage, key, JSON.stringify(normalizeConnectionProfiles(connectionProfiles)));
}

export function removeConnectionProfile(current, serverUrl) {
  const normalizedServer = normalizeRecentServers([serverUrl])[0];
  if (!normalizedServer) return normalizeConnectionProfiles(current);
  return normalizeConnectionProfiles(current).filter((profile) => profile.serverUrl !== normalizedServer);
}
