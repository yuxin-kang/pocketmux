import { normalizeRecentServers, rememberServer } from './connection.js';

const MAX_CONNECTION_PROFILES = 5;
const MAX_CONNECTION_NAME_LENGTH = 48;

function normalizeConnectionName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_CONNECTION_NAME_LENGTH);
}

function normalizeConnectionProfiles(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    const serverUrl = typeof item === 'string' ? item : item?.serverUrl;
    const name = typeof item === 'object' ? normalizeConnectionName(item?.name) : '';
    try {
      const normalizedServer = normalizeRecentServers([serverUrl])[0];
      if (!normalizedServer || normalized.some((profile) => profile.serverUrl === normalizedServer)) continue;
      normalized.push({ serverUrl: normalizedServer, ...(name ? { name } : {}) });
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
  return loadRecentServers(storage, legacyKey).map((serverUrl) => ({ serverUrl }));
}

export function loadLegacyConnectionTokens(storage, key) {
  try {
    const value = JSON.parse(readStoredValue(storage, key, '[]'));
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const token = typeof item?.token === 'string' ? item.token.trim() : '';
      if (!token) return [];
      const [profile] = normalizeConnectionProfiles([item]);
      return profile ? [{ serverUrl: profile.serverUrl, token }] : [];
    });
  } catch {
    return [];
  }
}

export function rememberConnectionProfile(storage, key, current, connection) {
  const [profile] = normalizeConnectionProfiles([connection]);
  if (!profile) return { connectionProfiles: normalizeConnectionProfiles(current), persisted: false };
  const normalizedCurrent = normalizeConnectionProfiles(current);
  const existing = normalizedCurrent.find((item) => item.serverUrl === profile.serverUrl);
  const rememberedProfile = existing?.name && !profile.name
    ? { ...profile, name: existing.name }
    : profile;
  const connectionProfiles = [
    rememberedProfile,
    ...normalizedCurrent.filter((item) => item.serverUrl !== profile.serverUrl),
  ].slice(0, MAX_CONNECTION_PROFILES);
  return {
    connectionProfiles,
    persisted: writeStoredValue(storage, key, JSON.stringify(connectionProfiles)),
  };
}

export function saveConnectionProfiles(
  storage,
  key,
  connectionProfiles,
  pendingLegacyCredentials = [],
) {
  const pendingByServer = new Map(
    pendingLegacyCredentials.flatMap((credential) => {
      const token = typeof credential?.token === 'string' ? credential.token.trim() : '';
      return token ? [[credential.serverUrl, token]] : [];
    }),
  );
  const persistedProfiles = normalizeConnectionProfiles(connectionProfiles).map((profile) => {
    const token = pendingByServer.get(profile.serverUrl);
    return token ? { ...profile, token } : profile;
  });
  return writeStoredValue(storage, key, JSON.stringify(persistedProfiles));
}

export function removeConnectionProfile(current, serverUrl) {
  const normalizedServer = normalizeRecentServers([serverUrl])[0];
  if (!normalizedServer) return normalizeConnectionProfiles(current);
  return normalizeConnectionProfiles(current).filter((profile) => profile.serverUrl !== normalizedServer);
}

export function renameConnectionProfile(current, serverUrl, name) {
  const normalizedServer = normalizeRecentServers([serverUrl])[0];
  if (!normalizedServer) return normalizeConnectionProfiles(current);
  const normalizedName = normalizeConnectionName(name);
  return normalizeConnectionProfiles(current).map((profile) => {
    if (profile.serverUrl !== normalizedServer) return profile;
    const { name: _previousName, ...connection } = profile;
    return normalizedName ? { ...connection, name: normalizedName } : connection;
  });
}
