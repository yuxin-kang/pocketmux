import { normalizeRecentServers, rememberServer } from './connection.js';

const MAX_CONNECTION_PROFILES = 5;
const MAX_CONNECTION_NAME_LENGTH = 48;

function normalizeSshId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : '';
}

function sshIdFromServerUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('ssh://')) return '';
  try {
    return normalizeSshId(new URL(value).hostname);
  } catch {
    return '';
  }
}

function normalizeSshCredentialAliases(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeSshId).filter(Boolean))];
}

function stableSshId(item) {
  const target = item?.ssh || {};
  const jump = target.jump || {};
  const seed = [
    `${target.host || ''}:${target.port || 22}:${target.username || ''}:${target.remotePort || 3789}`,
    jump.host ? `${jump.host}:${jump.port || 22}:${jump.username || ''}` : '',
  ].join('|');
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `ssh-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// SSH credentials used to be keyed only by the profile's generated id.  Keep
// that id for compatibility, but also derive a deterministic endpoint id so a
// profile can recover credentials if an older build recreated its metadata id
// during a restart or edit.
export function sshCredentialProfileIds(profile) {
  if (!profile?.ssh) return [];
  return [...new Set([
    normalizeSshId(profile.id),
    ...normalizeSshCredentialAliases(profile.credentialAliases),
    stableSshId(profile),
  ].filter(Boolean))];
}

function normalizeSshJump(value) {
  if (!value || typeof value !== 'object') return null;
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const port = Number(value.port || 22);
  if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host: host.slice(0, 255),
    port,
    username: username.slice(0, 128),
    authMethod: value.authMethod === 'privateKey' ? 'privateKey' : 'password',
    hostKeyFingerprint: typeof value.hostKeyFingerprint === 'string'
      ? value.hostKeyFingerprint.trim().slice(0, 128)
      : '',
  };
}

function normalizeSshProfile(item) {
  if (!item || typeof item !== 'object' || item.transport !== 'ssh' || !item.ssh) return null;
  const ssh = item.ssh;
  const host = typeof ssh.host === 'string' ? ssh.host.trim() : '';
  const username = typeof ssh.username === 'string' ? ssh.username.trim() : '';
  const port = Number(ssh.port || 22);
  const remotePort = Number(ssh.remotePort || 3789);
  const jump = normalizeSshJump(ssh.jump);
  if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return null;
  // Older metadata sometimes retained only serverUrl and ssh fields. Recover
  // the original profile id from that URL before falling back to the endpoint
  // alias; the original id is where the first SSH build stored its secrets.
  const storedId = normalizeSshId(item.id) || sshIdFromServerUrl(item.serverUrl);
  const legacyUrlId = sshIdFromServerUrl(item.serverUrl);
  const id = storedId || stableSshId(item);
  const credentialAliases = normalizeSshCredentialAliases([
    ...(Array.isArray(item.credentialAliases) ? item.credentialAliases : []),
    storedId,
    legacyUrlId,
    stableSshId(item),
  ]);
  const profile = {
    id,
    transport: 'ssh',
    serverUrl: `ssh://${id}/`,
    ...(credentialAliases.length ? { credentialAliases } : {}),
    ssh: {
      host: host.slice(0, 255),
      port,
      username: username.slice(0, 128),
      authMethod: ssh.authMethod === 'privateKey' ? 'privateKey' : 'password',
      remoteHost: '127.0.0.1',
      remotePort,
      hostKeyFingerprint: typeof ssh.hostKeyFingerprint === 'string'
        ? ssh.hostKeyFingerprint.trim().slice(0, 128)
        : '',
      ...(jump ? { jump } : {}),
    },
  };
  const name = normalizeConnectionName(item.name);
  return name ? { ...profile, name } : profile;
}

function normalizeConnectionName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_CONNECTION_NAME_LENGTH);
}

function normalizeConnectionProfiles(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    const sshProfile = normalizeSshProfile(item);
    if (sshProfile) {
      if (normalized.some((profile) => profile.serverUrl === sshProfile.serverUrl)) continue;
      normalized.push(sshProfile);
      if (normalized.length === MAX_CONNECTION_PROFILES) break;
      continue;
    }
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
  const normalizedServer = typeof serverUrl === 'string' && serverUrl.startsWith('ssh://')
    ? serverUrl
    : normalizeRecentServers([serverUrl])[0];
  if (!normalizedServer) return normalizeConnectionProfiles(current);
  return normalizeConnectionProfiles(current).filter((profile) => profile.serverUrl !== normalizedServer);
}

export function renameConnectionProfile(current, serverUrl, name) {
  const normalizedServer = typeof serverUrl === 'string' && serverUrl.startsWith('ssh://')
    ? serverUrl
    : normalizeRecentServers([serverUrl])[0];
  if (!normalizedServer) return normalizeConnectionProfiles(current);
  const normalizedName = normalizeConnectionName(name);
  return normalizeConnectionProfiles(current).map((profile) => {
    if (profile.serverUrl !== normalizedServer) return profile;
    const { name: _previousName, ...connection } = profile;
    return normalizedName ? { ...connection, name: normalizedName } : connection;
  });
}
