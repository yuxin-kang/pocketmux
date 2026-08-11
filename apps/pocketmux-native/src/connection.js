const MAX_RECENT_SERVERS = 5;

function ipv4Octets(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

export function isPrivateLanHost(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes(':') && (host === '::1' || /^(?:fc|fd|fe[89ab])/.test(host))) return true;

  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function parseServerUrl(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('invalid-url');
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('invalid-url');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('unsupported-url');
  }
  if (url.hostname.toLowerCase() === 'tauri.localhost') throw new Error('native-origin');
  if (url.protocol === 'http:' && !isPrivateLanHost(url.hostname)) {
    throw new Error('public-http');
  }
  return url;
}

export function buildConnection(serverInput, tokenInput = '', { allowPrivateHttp = true } = {}) {
  const url = parseServerUrl(serverInput);
  if (url.protocol === 'http:' && !allowPrivateHttp) throw new Error('android-http');
  const embeddedToken = (url.searchParams.get('token') || '').trim();
  const token = String(tokenInput || '').trim() || embeddedToken;
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';
  const serverUrl = url.toString();
  if (token) url.searchParams.set('token', token);
  return {
    serverUrl,
    targetUrl: url.toString(),
    hasToken: Boolean(token),
    token,
  };
}

export function requireAccessToken(connection) {
  if (!connection?.hasToken) throw new Error('missing-token');
  return connection;
}

export function isInsecureServer(serverUrl) {
  return new URL(serverUrl).protocol === 'http:';
}

export function normalizeRecentServers(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    try {
      const serverUrl = buildConnection(item).serverUrl;
      if (!normalized.includes(serverUrl)) normalized.push(serverUrl);
    } catch {
      // Ignore stale or malformed entries from older app versions.
    }
    if (normalized.length === MAX_RECENT_SERVERS) break;
  }
  return normalized;
}

export function rememberServer(current, serverUrl) {
  const normalized = buildConnection(serverUrl).serverUrl;
  return [normalized, ...normalizeRecentServers(current).filter((item) => item !== normalized)]
    .slice(0, MAX_RECENT_SERVERS);
}

export function removeRememberedServer(current, serverUrl) {
  const normalized = buildConnection(serverUrl).serverUrl;
  return normalizeRecentServers(current).filter((item) => item !== normalized);
}
