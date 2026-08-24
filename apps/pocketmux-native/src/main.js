import {
  buildConnection,
  isInsecureServer,
  requireAccessToken,
} from './connection.js';
import { planConnectionSwitch } from './connection-switch.js';
import { createConnectionOperationTracker } from './connection-operations.js';
import { createConnectionValidationTracker } from './connection-validation.js';
import {
  beginConnectionAuthentication,
  recordNativeValidation,
  recordWebAuthentication,
  shouldDeferNativeInvalidation,
  shouldIgnoreNativeInvalidation,
} from './connection-authentication.js';
import {
  migrateLegacyCredentials,
  retainCurrentLegacyCredentials,
} from './credential-migration.js';
import { initializeConnections } from './connection-initialization.js';
import { persistBeforeRemoteNavigation } from './connection-navigation.js';
import { rejectCredential } from './rejected-credential.js';
import { shouldBeginDrawerSwipe } from './drawer-gesture.js';
import { errorMessageKey } from './error-state.js';
import {
  clampHandleCenter,
  handlePositionRatio,
  hasHandleMoved,
  normalizeHandlePosition,
} from './floating-handle.js';
import { messages, normalizeLanguage } from './i18n.js';
import { createNativeShellSession } from './native-shell-session.js';
import {
  mergeCredentialReadResults,
  shouldRetryCredentialRead,
  withCredentialReadTimeout,
} from './credential-read.js';
import {
  normalizeNativeViewportHeight,
  resolveRemoteViewportHeight,
} from './remote-viewport.js';
import { beginRemoteSession, transitionRemoteSession } from './remote-session.js';
import { persistValidatedCredential } from './validated-credential.js';
import {
  loadConnectionProfiles,
  loadLegacyConnectionTokens,
  readStoredValue,
  rememberConnectionProfile,
  removeConnectionProfile,
  renameConnectionProfile,
  saveConnectionProfiles,
  sshCredentialProfileIds,
  writeStoredValue,
} from './storage.js';

const LANGUAGE_KEY = 'pocketmux-native-language';
const CONNECTION_PROFILES_KEY = 'pocketmux-native-connection-profiles-v1';
const LEGACY_RECENT_SERVERS_KEY = 'pocketmux-native-recent-servers';
const REMOTE_HANDLE_POSITION_KEY = 'pocketmux-native-remote-handle-position-v1';
const REMOTE_HANDLE_HEIGHT_PX = 58;
const REMOTE_HANDLE_MARGIN_PX = 12;
const REMOTE_LOAD_TIMEOUT_MS = 15000;
const REMOTE_REVEAL_DELAY_MS = 400;
const CREDENTIAL_READ_TIMEOUT_MS = 5000;
const CREDENTIAL_READ_RETRY_DELAY_MS = 1000;
const CREDENTIAL_READ_MAX_ATTEMPTS = 3;
const NATIVE_BRIDGE_RETRY_ATTEMPTS = 4;
const NATIVE_BRIDGE_RETRY_DELAY_MS = 250;
const SSH_SECRET_READ_RETRIES = 6;
const SSH_SECRET_READ_RETRY_DELAY_MS = 500;
const LATE_CREDENTIAL_RECOVERY_MAX_ATTEMPTS = 3;
const SSH_SECRET_WRITE_RETRIES = 2;
const SSH_SECRET_WRITE_RETRY_DELAY_MS = 150;
const CREDENTIAL_DRAIN_TIMEOUT_MS = 10000;
const REMOTE_LANGUAGE_MESSAGE_TYPE = 'pocketmux:language';
const REMOTE_AUTH_REQUIRED_MESSAGE_TYPE = 'pocketmux:authentication-required';
const REMOTE_AUTHENTICATION_SUCCEEDED_MESSAGE_TYPE = 'pocketmux:authentication-succeeded';
const REMOTE_FILE_ACTION_REQUEST_MESSAGE_TYPE = 'pocketmux:file-action-request';
const REMOTE_FILE_ACTION_RESULT_MESSAGE_TYPE = 'pocketmux:file-action-result';
const NATIVE_FILE_ACTION_MAX_BYTES = 50 * 1024 * 1024;
const NATIVE_FILE_ACTION_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'video/x-m4v',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/3gpp',
  'video/mpeg',
  'video/x-ms-wmv',
  'video/ogg',
  'text/markdown',
  'text/plain',
]);
const NATIVE_VIEWPORT_EVENT_TYPE = 'pocketmux:native-viewport';
const connectionPolicy = {
  allowPrivateHttp: !/\bAndroid\b/i.test(window.navigator.userAgent),
};

const elements = {
  appFrame: document.querySelector('.app-frame'),
  launcher: document.querySelector('#launcher'),
  footer: document.querySelector('#app-footer'),
  form: document.querySelector('#connection-form'),
  connectionTransport: document.querySelector('#connection-transport'),
  directConnectionFields: document.querySelector('#direct-connection-fields'),
  sshConnectionFields: document.querySelector('#ssh-connection-fields'),
  serverUrl: document.querySelector('#server-url'),
  sshHost: document.querySelector('#ssh-host'),
  sshPort: document.querySelector('#ssh-port'),
  sshUsername: document.querySelector('#ssh-username'),
  sshAuthMethod: document.querySelector('#ssh-auth-method'),
  sshPassword: document.querySelector('#ssh-password'),
  sshPrivateKey: document.querySelector('#ssh-private-key'),
  sshKeyPassphrase: document.querySelector('#ssh-key-passphrase'),
  sshRemotePort: document.querySelector('#ssh-remote-port'),
  sshPasswordField: document.querySelector('#ssh-password-field'),
  sshPrivateKeyFields: document.querySelector('#ssh-private-key-fields'),
  sshJumpEnabled: document.querySelector('#ssh-jump-enabled'),
  sshJumpFields: document.querySelector('#ssh-jump-fields'),
  sshJumpHost: document.querySelector('#ssh-jump-host'),
  sshJumpPort: document.querySelector('#ssh-jump-port'),
  sshJumpUsername: document.querySelector('#ssh-jump-username'),
  sshJumpAuthMethod: document.querySelector('#ssh-jump-auth-method'),
  sshJumpPassword: document.querySelector('#ssh-jump-password'),
  sshJumpPrivateKey: document.querySelector('#ssh-jump-private-key'),
  sshJumpKeyPassphrase: document.querySelector('#ssh-jump-key-passphrase'),
  sshJumpPasswordField: document.querySelector('#ssh-jump-password-field'),
  sshJumpPrivateKeyFields: document.querySelector('#ssh-jump-private-key-fields'),
  accessToken: document.querySelector('#access-token'),
  toggleToken: document.querySelector('#toggle-token'),
  connectButton: document.querySelector('#connect-button'),
  warning: document.querySelector('#connection-warning'),
  error: document.querySelector('#connection-error'),
  recentList: document.querySelector('#recent-list'),
  recentEmpty: document.querySelector('#recent-empty'),
  recentCount: document.querySelector('#recent-count'),
  remoteShell: document.querySelector('#remote-shell'),
  remoteFrame: document.querySelector('#remote-frame'),
  remoteMenuToggle: document.querySelector('#remote-menu-toggle'),
  drawerEdgeTarget: document.querySelector('#drawer-edge-target'),
  remoteDrawer: document.querySelector('#remote-drawer'),
  remoteDrawerBackdrop: document.querySelector('#remote-drawer-backdrop'),
  closeRemoteDrawer: document.querySelector('#close-remote-drawer'),
  remoteNotice: document.querySelector('#remote-notice'),
  remoteLoadingCover: document.querySelector('#remote-loading-cover'),
  remoteLoadingSpinner: document.querySelector('#remote-loading-spinner'),
  remoteLoadingTitle: document.querySelector('#remote-loading-title'),
  remoteLoadingHint: document.querySelector('#remote-loading-hint'),
  retryRemote: document.querySelector('#retry-remote'),
  refreshRemote: document.querySelector('#refresh-remote'),
  switchTargetList: document.querySelector('#switch-target-list'),
  addConnection: document.querySelector('#add-connection'),
  exitApp: document.querySelector('#exit-app'),
  languageButtons: [...document.querySelectorAll('[data-language]')],
  connectionNameDialog: document.querySelector('#connection-name-dialog'),
  connectionNameForm: document.querySelector('#connection-name-form'),
  connectionNameServer: document.querySelector('#connection-name-server'),
  connectionName: document.querySelector('#connection-name'),
  cancelConnectionName: document.querySelector('#cancel-connection-name'),
};

function availableStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const storage = availableStorage();
let language = normalizeLanguage(readStoredValue(storage, LANGUAGE_KEY));
let connectionProfiles = loadConnectionProfiles(
  storage,
  CONNECTION_PROFILES_KEY,
  LEGACY_RECENT_SERVERS_KEY,
);
let legacyConnectionTokens = loadLegacyConnectionTokens(storage, CONNECTION_PROFILES_KEY);
let recentServers = connectionProfiles.map((profile) => profile.serverUrl);
let remoteSession = null;
let remoteLoadTimer = null;
let remoteRevealTimer = null;
let drawerGestureStart = null;
let remoteHandlePosition = normalizeHandlePosition(readStoredValue(storage, REMOTE_HANDLE_POSITION_KEY));
let remoteHandleDrag = null;
let suppressRemoteHandleClick = false;
let switchingTarget = '';
let renamingServerUrl = '';
let selectedSshProfileId = '';
let currentErrorKey = '';
let initializationSettled = false;
let nativeViewportHeight = normalizeNativeViewportHeight(
  window.__POCKETMUX_NATIVE_VIEWPORT__?.height,
);
const connectionOperations = createConnectionOperationTracker();
const connectionValidations = createConnectionValidationTracker();
const connectionTokens = new Map();
const authenticatedTargets = new Map();
const connectionAttempts = new Map();
let credentialMutationQueue = Promise.resolve();
let shellSessionToken = '';
let credentialHydrationGeneration = 0;
let lateCredentialRecoveryStarted = false;
let lateCredentialRecoveryAttempts = 0;
let exitRequested = false;
let sshStopPromise = Promise.resolve();

function authDebug(event, details = {}) {
  console.info('[pocketmux-auth]', event, details);
}

function text(key) {
  return messages[language][key] || messages.zh[key] || key;
}

function setError(message = '') {
  currentErrorKey = '';
  elements.error.textContent = message;
}

function localizedError(error) {
  const raw = String(error?.message || error || '');
  const key = errorMessageKey(new Error(raw.split(':', 2)[0]));
  return text(key).replace('{fingerprint}', raw.split(':').slice(1).join(':'));
}

function setLocalizedError(error) {
  const raw = String(error?.message || error || '');
  currentErrorKey = errorMessageKey(new Error(raw.split(':', 2)[0]));
  elements.error.textContent = text(currentErrorKey)
    .replace('{fingerprint}', raw.split(':').slice(1).join(':'));
}

function isSshProfile(profile) {
  return profile?.transport === 'ssh' && typeof profile.serverUrl === 'string';
}

function profileForServer(serverUrl) {
  return connectionProfiles.find((profile) => profile.serverUrl === serverUrl);
}

function savedTokenForServer(serverUrl) {
  const secureToken = String(connectionTokens.get(serverUrl) || '').trim();
  if (secureToken) return secureToken;
  return String(
    legacyConnectionTokens.find((item) => item.serverUrl === serverUrl)?.token || '',
  ).trim();
}

function hasSavedTokenForServer(serverUrl) {
  return Boolean(savedTokenForServer(serverUrl));
}

function restorableConnectionCandidate() {
  for (const profile of connectionProfiles) {
    const token = savedTokenForServer(profile.serverUrl);
    if (token) return { profile, token };
  }
  return null;
}

function runtimeServerUrl(connection) {
  return connection?.runtimeServerUrl || connection?.serverUrl || '';
}

function createProfileId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sshProfileEndpointMatches(profile, {
  host,
  port,
  username,
  authMethod,
  remotePort,
  jumpEnabled,
  jumpHost,
  jumpPort,
  jumpUsername,
  jumpAuthMethod,
} = {}) {
  if (!isSshProfile(profile) || !profile.ssh) return false;
  const jump = profile.ssh.jump || null;
  return profile.ssh.host === host
    && profile.ssh.port === port
    && profile.ssh.username === username
    && profile.ssh.authMethod === authMethod
    && profile.ssh.remotePort === remotePort
    && Boolean(jump) === jumpEnabled
    && (!jumpEnabled || (
      jump.host === jumpHost
      && jump.port === jumpPort
      && jump.username === jumpUsername
      && jump.authMethod === jumpAuthMethod
    ));
}

function sshProfileFromForm(existing = null) {
  const host = elements.sshHost.value.trim();
  const username = elements.sshUsername.value.trim();
  const port = Number(elements.sshPort.value || 22);
  const remotePort = Number(elements.sshRemotePort.value || 3789);
  const jumpEnabled = Boolean(elements.sshJumpEnabled?.checked);
  const jumpHost = elements.sshJumpHost?.value.trim() || '';
  const jumpUsername = elements.sshJumpUsername?.value.trim() || '';
  const jumpPort = Number(elements.sshJumpPort?.value || 22);
  const jumpAuthMethod = elements.sshJumpAuthMethod?.value === 'privateKey'
    ? 'privateKey'
    : 'password';
  if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error('ssh-invalid-config');
  }
  if (jumpEnabled && (!jumpHost || !jumpUsername || !Number.isInteger(jumpPort)
    || jumpPort < 1 || jumpPort > 65535)) {
    throw new Error('ssh-jump-invalid-config');
  }
  const authMethod = elements.sshAuthMethod.value === 'privateKey' ? 'privateKey' : 'password';
  // A launcher form can be filled manually after an error or a fresh app
  // start, when selectedSshProfileId is empty. Reuse the matching saved
  // profile instead of generating a new ID and orphaning its keyring secrets.
  const matchedExisting = existing || connectionProfiles.find((profile) => sshProfileEndpointMatches(profile, {
    host,
    port,
    username,
    authMethod,
    remotePort,
    jumpEnabled,
    jumpHost,
    jumpPort,
    jumpUsername,
    jumpAuthMethod,
  }));
  const existingJump = matchedExisting?.ssh?.jump;
  const sameJump = jumpEnabled
    && existingJump
    && existingJump.host === jumpHost
    && existingJump.port === jumpPort
    && existingJump.username === jumpUsername
    && existingJump.authMethod === jumpAuthMethod;
  const sameEndpoint = sshProfileEndpointMatches(matchedExisting, {
    host,
    port,
    username,
    authMethod,
    remotePort,
    jumpEnabled,
    jumpHost,
    jumpPort,
    jumpUsername,
    jumpAuthMethod,
  }) && (!jumpEnabled || sameJump);
  const id = sameEndpoint ? matchedExisting.id : createProfileId();
  const jump = jumpEnabled ? {
    host: jumpHost,
    port: jumpPort,
    username: jumpUsername,
    authMethod: jumpAuthMethod,
    hostKeyFingerprint: sameJump ? existingJump.hostKeyFingerprint : '',
  } : null;
  return {
    id,
    transport: 'ssh',
    serverUrl: `ssh://${id}/`,
    ...(matchedExisting?.name ? { name: matchedExisting.name } : {}),
    ssh: {
      host,
      port,
      username,
      authMethod,
      remoteHost: '127.0.0.1',
      remotePort,
      hostKeyFingerprint: sameEndpoint ? matchedExisting.ssh.hostKeyFingerprint : '',
      ...(jump ? { jump } : {}),
    },
  };
}

function sshCredentialsFromForm() {
  return {
    password: elements.sshPassword.value,
    privateKey: elements.sshPrivateKey.value,
    keyPassphrase: elements.sshKeyPassphrase.value,
    jumpPassword: elements.sshJumpPassword?.value || '',
    jumpPrivateKey: elements.sshJumpPrivateKey?.value || '',
    jumpKeyPassphrase: elements.sshJumpKeyPassphrase?.value || '',
  };
}

function setSshFormVisibility() {
  const ssh = elements.connectionTransport.value === 'ssh';
  elements.directConnectionFields.classList.toggle('is-hidden', ssh);
  elements.sshConnectionFields.classList.toggle('is-hidden', !ssh);
  const privateKey = ssh && elements.sshAuthMethod.value === 'privateKey';
  elements.sshPasswordField.classList.toggle('is-hidden', !ssh || privateKey);
  elements.sshPrivateKeyFields.classList.toggle('is-hidden', !privateKey);
  const jumpEnabled = ssh && Boolean(elements.sshJumpEnabled?.checked);
  const jumpPrivateKey = jumpEnabled && elements.sshJumpAuthMethod?.value === 'privateKey';
  elements.sshJumpFields?.classList.toggle('is-hidden', !jumpEnabled);
  elements.sshJumpPasswordField?.classList.toggle('is-hidden', !jumpEnabled || jumpPrivateKey);
  elements.sshJumpPrivateKeyFields?.classList.toggle('is-hidden', !jumpPrivateKey);
  elements.serverUrl.required = !ssh;
  renderSecurityWarning();
}

function loadSshProfileIntoForm(profile) {
  if (!isSshProfile(profile)) return;
  selectedSshProfileId = profile.id;
  elements.connectionTransport.value = 'ssh';
  elements.sshHost.value = profile.ssh.host;
  elements.sshPort.value = String(profile.ssh.port);
  elements.sshUsername.value = profile.ssh.username;
  elements.sshAuthMethod.value = profile.ssh.authMethod;
  elements.sshRemotePort.value = String(profile.ssh.remotePort);
  elements.sshPassword.value = '';
  elements.sshPrivateKey.value = '';
  elements.sshKeyPassphrase.value = '';
  const jump = profile.ssh.jump || null;
  if (elements.sshJumpEnabled) elements.sshJumpEnabled.checked = Boolean(jump);
  if (elements.sshJumpHost) elements.sshJumpHost.value = jump?.host || '';
  if (elements.sshJumpPort) elements.sshJumpPort.value = String(jump?.port || 22);
  if (elements.sshJumpUsername) elements.sshJumpUsername.value = jump?.username || '';
  if (elements.sshJumpAuthMethod) elements.sshJumpAuthMethod.value = jump?.authMethod || 'password';
  if (elements.sshJumpPassword) elements.sshJumpPassword.value = '';
  if (elements.sshJumpPrivateKey) elements.sshJumpPrivateKey.value = '';
  if (elements.sshJumpKeyPassphrase) elements.sshJumpKeyPassphrase.value = '';
  setSshFormVisibility();
}

function profileForConnection(connection) {
  return connection?.profile || profileForServer(connection?.serverUrl);
}

function buildRemoteConnection(serverInput, tokenInput = '') {
  const connection = buildConnection(serverInput, tokenInput, connectionPolicy);
  if (new URL(connection.serverUrl).origin === window.location.origin) {
    throw new Error('native-origin');
  }
  const targetUrl = new URL(connection.targetUrl);
  targetUrl.searchParams.set('native', '1');
  return Object.freeze({ ...connection, targetUrl: targetUrl.toString() });
}

function buildSshRuntimeConnection(profile, localUrl, tokenInput = '') {
  if (!isSshProfile(profile)) throw new Error('ssh-invalid-config');
  const runtime = buildConnection(localUrl, tokenInput, { allowPrivateHttp: true });
  if (new URL(runtime.serverUrl).hostname !== '127.0.0.1') {
    throw new Error('ssh-invalid-endpoint');
  }
  const targetUrl = new URL(runtime.targetUrl);
  targetUrl.searchParams.set('native', '1');
  return Object.freeze({
    ...runtime,
    serverUrl: profile.serverUrl,
    runtimeServerUrl: runtime.serverUrl,
    targetUrl: targetUrl.toString(),
    profile,
    isSsh: true,
  });
}

function connectionLabel(serverUrl) {
  const profile = profileForServer(serverUrl);
  if (isSshProfile(profile)) {
    return profile.name || `${profile.ssh.username}@${profile.ssh.host}:${profile.ssh.port}`;
  }
  try {
    return profile?.name || new URL(serverUrl).host;
  } catch {
    return profile?.name || serverUrl;
  }
}

function sshRouteLabel(profile) {
  if (!isSshProfile(profile)) return '';
  const target = `${profile.ssh.username}@${profile.ssh.host}:${profile.ssh.port}`;
  const jump = profile.ssh.jump
    ? `${profile.ssh.jump.username}@${profile.ssh.jump.host}:${profile.ssh.jump.port} → `
    : '';
  return `${jump}${target} → 127.0.0.1:${profile.ssh.remotePort}`;
}

function rebuildAuthenticatedTargets() {
  authenticatedTargets.clear();
  for (const profile of connectionProfiles) {
    const token = connectionTokens.get(profile.serverUrl) || '';
    if (!token) continue;
    if (isSshProfile(profile)) continue;
    try {
      const connection = requireAccessToken(buildRemoteConnection(profile.serverUrl, token));
      authenticatedTargets.set(connection.serverUrl, connection.targetUrl);
    } catch {
      // Keep malformed or platform-incompatible legacy profiles out of direct switching.
    }
  }
  for (const attempt of connectionAttempts.values()) {
    if (!attempt.authenticated || !connectionValidations.isCurrent(attempt.validationAttempt)) continue;
    authenticatedTargets.set(attempt.connection.serverUrl, attempt.connection.targetUrl);
  }
}

function persistConnectionProfiles() {
  recentServers = connectionProfiles.map((profile) => profile.serverUrl);
  rebuildAuthenticatedTargets();
  return saveConnectionProfiles(
    storage,
    CONNECTION_PROFILES_KEY,
    connectionProfiles,
    legacyConnectionTokens,
  );
}

function rememberConnectionMetadata(connection) {
  const profile = profileForConnection(connection);
  const remembered = rememberConnectionProfile(
    null,
    CONNECTION_PROFILES_KEY,
    connectionProfiles,
    profile || { serverUrl: connection.serverUrl },
  );
  connectionProfiles = remembered.connectionProfiles;
  recentServers = connectionProfiles.map((profile) => profile.serverUrl);
  return persistConnectionProfiles();
}

function persistValidatedConnectionMetadata(connection) {
  return profileForServer(connection.serverUrl)
    ? persistConnectionProfiles()
    : rememberConnectionMetadata(connection);
}

function nativeInvoke() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke || !shellSessionToken) return null;
  return (command, arguments_ = {}) => invoke(command, {
    ...arguments_,
    sessionToken: shellSessionToken,
  });
}

async function nativeCredentialInvokeWithRetry() {
  for (let attempt = 0; attempt < NATIVE_BRIDGE_RETRY_ATTEMPTS; attempt += 1) {
    const invoke = await nativeCredentialInvoke();
    if (invoke) return invoke;
    if (attempt + 1 < NATIVE_BRIDGE_RETRY_ATTEMPTS) {
      await new Promise((resolve) => window.setTimeout(resolve, NATIVE_BRIDGE_RETRY_DELAY_MS));
    }
  }
  return null;
}

function createShellSessionToken() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function initializeShellSession() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('native bridge unavailable');
  const sessionToken = createShellSessionToken();
  await invoke('register_shell_session', { sessionToken });
  shellSessionToken = sessionToken;
}

const nativeShellSession = createNativeShellSession({
  initialize: initializeShellSession,
  getInvoke: nativeInvoke,
  onInitializationError: (error) => {
    authDebug('shell-registration-failed', { error: String(error) });
  },
});

const ensureShellSession = nativeShellSession.ensure;
const nativeCredentialInvoke = nativeShellSession.readyInvoke;

function queueCredentialMutation(mutation) {
  const result = credentialMutationQueue.then(mutation, mutation);
  credentialMutationQueue = result.catch(() => undefined);
  return result;
}

async function storeConnectionToken(connection, { isCurrent = () => true } = {}) {
  return queueCredentialMutation(async () => {
    if (!isCurrent()) {
      authDebug('write-skipped-stale', { serverUrl: connection.serverUrl });
      return false;
    }
    const invoke = await nativeCredentialInvokeWithRetry();
    if (!invoke) {
      authDebug('write-skipped-native-unavailable', { serverUrl: connection.serverUrl });
      return false;
    }
    authDebug('write-start', { serverUrl: connection.serverUrl });
    try {
      await invoke('set_connection_token', {
        serverUrl: connection.serverUrl,
        token: connection.token,
      });
      if (!isCurrent()) {
        authDebug('write-cleanup-stale', { serverUrl: connection.serverUrl });
        try {
          await invoke('reject_connection_token', {
            serverUrl: connection.serverUrl,
            expectedToken: connection.token,
          });
        } catch {
          // Keep the newer in-memory attempt authoritative if cleanup is unavailable.
        }
        return false;
      }
      connectionTokens.set(connection.serverUrl, connection.token);
      const previousLegacyConnectionTokens = legacyConnectionTokens;
      legacyConnectionTokens = legacyConnectionTokens.filter(
        (item) => item.serverUrl !== connection.serverUrl,
      );
      if (!persistConnectionProfiles()) {
        legacyConnectionTokens = previousLegacyConnectionTokens;
        rebuildAuthenticatedTargets();
        return false;
      }
      rebuildAuthenticatedTargets();
      authDebug('write-success', { serverUrl: connection.serverUrl });
      return true;
    } catch (error) {
      authDebug('write-failed', {
        serverUrl: connection.serverUrl,
        error: String(error),
      });
      return false;
    }
  });
}

function persistConnectionAttempt(attempt) {
  if (!attempt) {
    return Promise.resolve({ cancelled: true, metadataPersisted: false, credentialPersisted: false });
  }
  if (connectionTokens.get(attempt.connection.serverUrl) === attempt.connection.token) {
    return Promise.resolve({ cancelled: false, metadataPersisted: true, credentialPersisted: true });
  }
  if (!connectionValidations.isCurrent(attempt.validationAttempt)) {
    return Promise.resolve({ cancelled: true, metadataPersisted: false, credentialPersisted: false });
  }
  if (attempt.persistenceState === 'pending' && attempt.persistencePromise) {
    return attempt.persistencePromise;
  }

  attempt.persistenceState = 'pending';
  const persistencePromise = persistValidatedCredential({
    isCurrent: () => connectionValidations.isCurrent(attempt.validationAttempt),
    persistMetadata: () => persistValidatedConnectionMetadata(attempt.connection),
    persistCredential: () => storeConnectionToken(attempt.connection, {
      isCurrent: () => connectionValidations.isCurrent(attempt.validationAttempt),
    }),
  }).catch((error) => {
    authDebug('persistence-failed', {
      serverUrl: attempt.connection.serverUrl,
      error: String(error),
    });
    return { cancelled: false, metadataPersisted: false, credentialPersisted: false };
  }).then((persistence) => {
    authDebug('persistence-result', {
      serverUrl: attempt.connection.serverUrl,
      metadataPersisted: persistence.metadataPersisted,
      credentialPersisted: persistence.credentialPersisted,
      cancelled: persistence.cancelled,
    });
    attempt.persistenceResult = persistence;
    attempt.persistenceState = persistence.credentialPersisted
      ? 'saved'
      : (persistence.cancelled ? 'cancelled' : 'failed');
    renderRecentServers();
    return persistence;
  }).finally(() => {
    if (attempt.persistencePromise === persistencePromise && attempt.persistenceState !== 'saved') {
      attempt.persistencePromise = null;
    }
  });
  attempt.persistencePromise = persistencePromise;
  return persistencePromise;
}

function markConnectionAttemptAuthenticated(attempt) {
  if (!attempt || !connectionValidations.isCurrent(attempt.validationAttempt)) return false;
  attempt.authenticated = true;
  rebuildAuthenticatedTargets();
  if (
    !connectionOperations.isCurrent(attempt.operation)
    || !remoteSession
    || remoteSession.serverUrl !== attempt.connection.serverUrl
  ) return true;
  setRemoteState('loaded', attempt.operation);
  renderRecentServers();
  return true;
}

async function storeLegacyConnectionToken(connection) {
  return queueCredentialMutation(async () => {
    const pendingLegacyToken = legacyConnectionTokens.find(
      (item) => item.serverUrl === connection.serverUrl && item.token === connection.token,
    );
    if (!profileForServer(connection.serverUrl) || !pendingLegacyToken) return true;
    if (connectionTokens.has(connection.serverUrl)) return true;
    const invoke = await nativeCredentialInvokeWithRetry();
    if (!invoke) throw new Error('credential-store-unavailable');
    await invoke('set_connection_token', {
      serverUrl: connection.serverUrl,
      token: connection.token,
    });
    connectionTokens.set(connection.serverUrl, connection.token);
    rebuildAuthenticatedTargets();
    return true;
  });
}

async function forgetRejectedToken(connection) {
  return queueCredentialMutation(async () => {
    const invoke = await nativeCredentialInvokeWithRetry();
    return rejectCredential({
      expectedToken: connection.token,
      currentToken: connectionTokens.get(connection.serverUrl),
      rejectStoredToken: async (expectedToken) => {
        if (!invoke) throw new Error('credential-store-unavailable');
        return invoke('reject_connection_token', {
          serverUrl: connection.serverUrl,
          expectedToken,
        });
      },
      forgetMemory: () => {
        connectionTokens.delete(connection.serverUrl);
        rebuildAuthenticatedTargets();
      },
      rememberMemory: (token) => {
        connectionTokens.set(connection.serverUrl, token);
        rebuildAuthenticatedTargets();
      },
    });
  });
}

async function deleteConnectionToken(serverUrl) {
  return queueCredentialMutation(async () => {
    const invoke = await nativeCredentialInvokeWithRetry();
    if (!invoke) return false;
    try {
      await invoke('delete_connection_token', { serverUrl });
      connectionTokens.delete(serverUrl);
      rebuildAuthenticatedTargets();
      return true;
    } catch {
      return false;
    }
  });
}

async function hydrateConnectionTokens() {
  return queueCredentialMutation(async () => {
    const invoke = await nativeCredentialInvokeWithRetry();
    if (!invoke) {
      authDebug('read-skipped-native-unavailable');
      return { complete: false, states: new Map() };
    }
    if (connectionProfiles.length === 0) {
      authDebug('read-complete', { servers: 0, present: 0, missing: 0, unknown: 0 });
      return { complete: true, states: new Map() };
    }
    const serverUrls = connectionProfiles.map((profile) => profile.serverUrl);
    const hydrationGeneration = ++credentialHydrationGeneration;
    const hydrationOperation = connectionOperations.current();
    let retryScheduled = false;
    let readAttempt = 1;
    const applyResults = (results, event = 'read-complete') => {
      const states = mergeCredentialReadResults(connectionTokens, serverUrls, results);
      rebuildAuthenticatedTargets();
      if (initializationSettled) renderRecentServers();
      authDebug(event, {
        servers: serverUrls.length,
        present: [...states.values()].filter((state) => state === 'present').length,
        missing: [...states.values()].filter((state) => state === 'missing').length,
        unknown: [...states.values()].filter((state) => state === 'unknown').length,
      });
      return states;
    };
    const restoreAfterLateRead = () => {
      if (
        hydrationGeneration !== credentialHydrationGeneration
        || !initializationSettled
        || !elements.remoteShell.classList.contains('is-hidden')
        || lateCredentialRecoveryStarted
        || lateCredentialRecoveryAttempts >= LATE_CREDENTIAL_RECOVERY_MAX_ATTEMPTS
      ) return;
      const candidate = restorableConnectionCandidate();
      if (!candidate) return;
      lateCredentialRecoveryStarted = true;
      lateCredentialRecoveryAttempts += 1;
      authDebug('read-late-restore', { serverUrl: candidate.profile.serverUrl });
      void restoreMostRecentConnection()
        .then((restored) => {
          if (restored) {
            lateCredentialRecoveryAttempts = 0;
            return;
          }
          authDebug('read-late-restore-failed', {
            serverUrl: candidate.profile.serverUrl,
            attempt: lateCredentialRecoveryAttempts,
          });
          if (lateCredentialRecoveryAttempts < LATE_CREDENTIAL_RECOVERY_MAX_ATTEMPTS) {
            window.setTimeout(() => restoreAfterLateRead(), CREDENTIAL_READ_RETRY_DELAY_MS);
          }
        })
        .catch((error) => {
          console.warn('Pocketmux late credential restore failed', error);
          if (lateCredentialRecoveryAttempts < LATE_CREDENTIAL_RECOVERY_MAX_ATTEMPTS) {
            window.setTimeout(() => restoreAfterLateRead(), CREDENTIAL_READ_RETRY_DELAY_MS);
          }
        })
        .finally(() => {
          lateCredentialRecoveryStarted = false;
        });
    };
    const scheduleReadRetry = () => {
      if (retryScheduled || readAttempt >= CREDENTIAL_READ_MAX_ATTEMPTS) return;
      retryScheduled = true;
      readAttempt += 1;
      const attempt = readAttempt;
      window.setTimeout(() => {
        retryScheduled = false;
        if (
          hydrationGeneration !== credentialHydrationGeneration
          || !connectionOperations.isCurrent(hydrationOperation)
        ) return;
        authDebug('read-retry-start', { servers: serverUrls.length, attempt });
        const retryPromise = invoke('get_connection_tokens', { serverUrls });
        void withCredentialReadTimeout(retryPromise, CREDENTIAL_READ_TIMEOUT_MS, {
          onLateValue: (results) => {
            if (hydrationGeneration !== credentialHydrationGeneration) return;
            const states = applyResults(results, 'read-retry-late-complete');
            restoreAfterLateRead();
            if (shouldRetryCredentialRead(states)) scheduleReadRetry();
          },
          onLateError: (error) => {
            authDebug('read-retry-late-failed', { error: String(error) });
            scheduleReadRetry();
          },
        }).then((results) => {
          const states = applyResults(results, 'read-retry-complete');
          restoreAfterLateRead();
          if (shouldRetryCredentialRead(states)) scheduleReadRetry();
          return states;
        }).catch((error) => {
          authDebug('read-retry-failed', { error: String(error) });
          scheduleReadRetry();
        });
      }, CREDENTIAL_READ_RETRY_DELAY_MS);
    };
    const readPromise = invoke('get_connection_tokens', { serverUrls });
    try {
      const results = await withCredentialReadTimeout(
        readPromise,
        CREDENTIAL_READ_TIMEOUT_MS,
        {
          onLateValue: (results) => {
            if (hydrationGeneration !== credentialHydrationGeneration) return;
            const states = applyResults(results, 'read-late-complete');
            restoreAfterLateRead();
            if (shouldRetryCredentialRead(states)) scheduleReadRetry();
          },
          onLateError: (error) => {
            authDebug('read-late-failed', { error: String(error) });
            scheduleReadRetry();
          },
        },
      );
      const states = applyResults(results);
      if (shouldRetryCredentialRead(states)) scheduleReadRetry();
      return { complete: ![...states.values()].includes('unknown'), states };
    } catch (error) {
      authDebug('read-failed', { error: String(error) });
      const timedOut = error?.message === 'credential-read-timeout';
      if (timedOut) authDebug('read-timeout-late-result-retained');
      scheduleReadRetry();
      return {
        complete: false,
        states: new Map(serverUrls.map((serverUrl) => [serverUrl, 'unknown'])),
      };
    }
  });
}

async function drainCredentialPersistence() {
  const pending = [
    credentialMutationQueue,
    ...[...connectionAttempts.values()]
      .map((attempt) => attempt.persistencePromise)
      .filter(Boolean),
  ];
  const uniquePending = [...new Set(pending)];
  if (uniquePending.length === 0) return true;

  let timer;
  const drained = Promise.allSettled(uniquePending).then((results) => {
    authDebug('exit-drain-complete', {
      pending: uniquePending.length,
      rejected: results.filter((result) => result.status === 'rejected').length,
    });
    return true;
  });
  const timeout = new Promise((resolve) => {
    timer = window.setTimeout(() => resolve(false), CREDENTIAL_DRAIN_TIMEOUT_MS);
  });
  const completed = await Promise.race([drained, timeout]);
  window.clearTimeout(timer);
  if (!completed) authDebug('exit-drain-timeout', { pending: uniquePending.length });
  return completed;
}

async function migrateLegacyConnectionTokens(existingCredentialStates) {
  const migration = await migrateLegacyCredentials(legacyConnectionTokens, {
    buildConnection: (serverUrl, token) => {
      const profile = profileForServer(serverUrl);
      // SSH profiles cannot be validated until a tunnel exists. The legacy
      // token is already local app data, so secure it first and let the normal
      // remote auth handshake reject it if it is no longer valid.
      if (isSshProfile(profile)) {
        return Object.freeze({ serverUrl: profile.serverUrl, token, profile });
      }
      return buildRemoteConnection(serverUrl, token);
    },
    credentialState: async (connection) => {
      const state = existingCredentialStates.get(connection.serverUrl) || 'unknown';
      // A cold-start keyring read may report unknown for SSH. Treat it as
      // retryable missing so an old plaintext token can still be secured.
      return isSshProfile(connection.profile) && state !== 'present' ? 'missing' : state;
    },
    validateCredential: (connection) => (
      isSshProfile(connection.profile) ? 'valid' : validateSavedToken(connection)
    ),
    storeCredential: storeLegacyConnectionToken,
    persistMigrationProgress: (remaining) => {
      const activeServers = new Set(connectionProfiles.map((profile) => profile.serverUrl));
      const previousProfiles = connectionProfiles;
      const previousLegacyConnectionTokens = legacyConnectionTokens;
      legacyConnectionTokens = retainCurrentLegacyCredentials(
        legacyConnectionTokens,
        remaining,
      ).filter((item) => activeServers.has(item.serverUrl));
      if (persistConnectionProfiles()) return true;
      connectionProfiles = previousProfiles;
      legacyConnectionTokens = previousLegacyConnectionTokens;
      return false;
    },
  });
  const activeServers = new Set(connectionProfiles.map((profile) => profile.serverUrl));
  legacyConnectionTokens = retainCurrentLegacyCredentials(
    legacyConnectionTokens,
    migration.remaining,
  ).filter((item) => activeServers.has(item.serverUrl));
  for (const failure of migration.failures) {
    console.warn('Pocketmux credential migration did not complete', {
      serverUrl: failure.serverUrl,
      stage: failure.stage,
      error: failure.error.message,
    });
  }
  return legacyConnectionTokens.length === 0;
}

async function validateSavedToken(connection) {
  const invoke = await nativeCredentialInvokeWithRetry();
  if (!invoke) return 'unknown';
  try {
    return await invoke('validate_token', {
      serverUrl: runtimeServerUrl(connection),
      token: connection.token,
    });
  } catch {
    return 'unknown';
  }
}

function renderTokenVisibility() {
  const showing = elements.accessToken.type === 'text';
  const key = showing ? 'connect.hideToken' : 'connect.showToken';
  elements.toggleToken.textContent = showing ? '◉' : '◎';
  elements.toggleToken.setAttribute('aria-label', text(key));
  elements.toggleToken.title = text(key);
}

function renderRemoteLanguage() {
  elements.remoteFrame.title = text('remote.frameTitle');
  renderRemoteState();
}

function applyLanguage() {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = text(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    element.placeholder = text(element.dataset.i18nPlaceholder);
  });
  if (elements.accessToken.dataset.savedTokenHint === 'true') {
    elements.accessToken.placeholder = text('connect.savedTokenPlaceholder');
  }
  document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    element.setAttribute('aria-label', text(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((element) => {
    element.title = text(element.dataset.i18nTitle);
  });
  elements.languageButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  });
  renderTokenVisibility();
  renderRecentServers();
  renderSecurityWarning();
  renderRemoteLanguage();
  if (currentErrorKey) elements.error.textContent = text(currentErrorKey);
}

function setLanguage(nextLanguage) {
  language = normalizeLanguage(nextLanguage);
  const persisted = writeStoredValue(storage, LANGUAGE_KEY, language);
  applyLanguage();
  if (!persisted) {
    if (elements.remoteShell.classList.contains('is-hidden')) setError(text('error.storageUnavailable'));
    else elements.remoteNotice.textContent = text('error.storageUnavailable');
  }
}

function connectionAttemptForMessage(event) {
  for (const attempt of connectionAttempts.values()) {
    if (attempt.frameWindow !== event.source) continue;
    if (event.origin !== new URL(runtimeServerUrl(attempt.connection)).origin) continue;
    return attempt;
  }
  return null;
}

function nativeFileName(value) {
  const name = String(value || 'pocketmux-file')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .trim()
    .slice(0, 180);
  return name || 'pocketmux-file';
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function postNativeFileActionResult(event, requestId, result) {
  if (!event.source || typeof event.source.postMessage !== 'function') return;
  event.source.postMessage({
    type: REMOTE_FILE_ACTION_RESULT_MESSAGE_TYPE,
    requestId,
    ...result,
  }, event.origin);
}

function handleRemoteFileAction(event, attempt) {
  const requestId = String(event.data?.requestId || '');
  if (!requestId || !attempt || !connectionValidations.isCurrent(attempt.validationAttempt)) return;
  if (!attempt.authentication.webAuthenticated) {
    postNativeFileActionResult(event, requestId, { ok: false, code: 'native-file-not-authenticated' });
    return;
  }
  const action = event.data.action === 'open' ? 'open' : 'save';
  const contentType = String(event.data.contentType || '').toLowerCase();
  const rawBytes = event.data.bytes;
  const bytes = rawBytes instanceof ArrayBuffer
    ? new Uint8Array(rawBytes)
    : (ArrayBuffer.isView(rawBytes) ? new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength) : null);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > NATIVE_FILE_ACTION_MAX_BYTES) {
    postNativeFileActionResult(event, requestId, { ok: false, code: 'invalid-file-data' });
    return;
  }
  if (!NATIVE_FILE_ACTION_TYPES.has(contentType)) {
    postNativeFileActionResult(event, requestId, { ok: false, code: 'unsupported-file-type' });
    return;
  }
  const bridge = window.PocketmuxFiles;
  if (!bridge || typeof bridge.saveFile !== 'function' || !shellSessionToken) {
    postNativeFileActionResult(event, requestId, { ok: false, code: 'native-file-bridge-unavailable' });
    return;
  }
  try {
    const rawResult = bridge.saveFile(
      shellSessionToken,
      base64FromBytes(bytes),
      nativeFileName(event.data.name),
      contentType,
      action === 'open',
    );
    let result = {};
    try { result = JSON.parse(rawResult); } catch { /* no-op */ }
    postNativeFileActionResult(event, requestId, {
      ok: result.ok === true,
      code: result.code || (result.ok === true ? 'saved' : 'native-file-save-failed'),
    });
  } catch (error) {
    authDebug('native-file-action-failed', { error: String(error) });
    postNativeFileActionResult(event, requestId, { ok: false, code: 'native-file-save-failed' });
  }
}

function receiveRemoteLanguage(event) {
  const attempt = connectionAttemptForMessage(event);
  if (event.data?.type === REMOTE_FILE_ACTION_REQUEST_MESSAGE_TYPE) {
    handleRemoteFileAction(event, attempt);
    return;
  }
  if (event.data?.type === REMOTE_AUTHENTICATION_SUCCEEDED_MESSAGE_TYPE) {
    if (!attempt || !connectionValidations.isCurrent(attempt.validationAttempt)) return;
    if (attempt.authentication.webAuthenticated && attempt.persistenceState !== 'failed') return;
    if (!attempt.authentication.webAuthenticated) {
      attempt.authentication = recordWebAuthentication(attempt.authentication);
    }
    authDebug('web-authenticated', { serverUrl: attempt.connection.serverUrl });
    markConnectionAttemptAuthenticated(attempt);
    void persistConnectionAttempt(attempt)
      .then((persistence) => {
        if (!connectionOperations.isCurrent(attempt.operation)) return;
        if (persistence.cancelled) return;
        remoteSession = Object.freeze({
          ...remoteSession,
          storageWarning: !persistence.metadataPersisted || !persistence.credentialPersisted,
        });
        renderRecentServers();
        renderRemoteState();
      })
      .catch((error) => {
        console.warn('Pocketmux credential persistence failed after web authentication', error);
        if (!connectionOperations.isCurrent(attempt.operation)) return;
        remoteSession = Object.freeze({ ...remoteSession, storageWarning: true });
        renderRecentServers();
        renderRemoteState();
      });
    return;
  }

  if (event.data?.type === REMOTE_LANGUAGE_MESSAGE_TYPE) {
    if (!remoteSession || event.source !== elements.remoteFrame.contentWindow) return;
    if (event.origin !== new URL(remoteSession.transportServerUrl || remoteSession.serverUrl).origin) return;
    if (event.data.language !== 'zh' && event.data.language !== 'en') return;
    setLanguage(event.data.language);
    return;
  }
  if (event.data?.type !== REMOTE_AUTH_REQUIRED_MESSAGE_TYPE) return;
  if (!attempt) return;
  authDebug('web-auth-required', { serverUrl: attempt.connection.serverUrl });
  const rejectedConnection = attempt.connection;
  connectionValidations.begin(rejectedConnection.serverUrl);
  connectionAttempts.delete(rejectedConnection.serverUrl);
  const operation = connectionOperations.current();
  void forgetRejectedToken(rejectedConnection).then((persisted) => {
    if (!connectionOperations.isCurrent(operation) || remoteSession?.serverUrl !== rejectedConnection.serverUrl) return;
    window.history.replaceState(
      { screen: 'launcher' },
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    showConnections({
      serverUrl: rejectedConnection.serverUrl,
      message: text('error.invalidToken'),
      focusToken: true,
    });
    if (!persisted) setError(text('error.storageUnavailable'));
    renderRecentServers();
  });
}

function renderSecurityWarning() {
  if (elements.connectionTransport.value === 'ssh') {
    elements.warning.classList.add('is-hidden');
    elements.warning.textContent = '';
    return;
  }
  let connection;
  try {
    connection = buildRemoteConnection(elements.serverUrl.value, elements.accessToken.value);
  } catch (error) {
    if (error?.message === 'android-http') {
      elements.warning.textContent = text('connect.httpWarning');
      elements.warning.classList.remove('is-hidden');
      return;
    }
    elements.warning.classList.add('is-hidden');
    elements.warning.textContent = '';
    return;
  }
  if (isInsecureServer(connection.serverUrl)) {
    elements.warning.textContent = text('connect.httpWarning');
    elements.warning.classList.remove('is-hidden');
    return;
  }
  elements.warning.classList.add('is-hidden');
  elements.warning.textContent = '';
}

function clearRemoteLoadTimer() {
  if (remoteLoadTimer !== null) window.clearTimeout(remoteLoadTimer);
  remoteLoadTimer = null;
}

function clearRemoteRevealTimer() {
  if (remoteRevealTimer !== null) window.clearTimeout(remoteRevealTimer);
  remoteRevealTimer = null;
}

function openRemoteDrawer() {
  if (elements.remoteShell.classList.contains('is-hidden')) return;
  renderSwitchTargets();
  elements.remoteDrawer.classList.add('is-open');
  elements.remoteDrawerBackdrop.classList.remove('is-hidden');
  elements.remoteDrawer.setAttribute('aria-hidden', 'false');
  elements.remoteDrawer.inert = false;
  elements.remoteFrame.setAttribute('aria-hidden', 'true');
  elements.remoteFrame.inert = true;
  elements.remoteMenuToggle.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => elements.closeRemoteDrawer.focus());
}

function closeRemoteDrawer({ restoreFocus = true } = {}) {
  const wasOpen = elements.remoteDrawer.classList.contains('is-open');
  elements.remoteDrawer.classList.remove('is-open');
  elements.remoteDrawerBackdrop.classList.add('is-hidden');
  elements.remoteDrawer.setAttribute('aria-hidden', 'true');
  elements.remoteDrawer.inert = true;
  elements.remoteFrame.removeAttribute('aria-hidden');
  elements.remoteFrame.inert = false;
  elements.remoteMenuToggle.setAttribute('aria-expanded', 'false');
  if (wasOpen && restoreFocus) elements.remoteMenuToggle.focus();
}

function remoteShellHeight() {
  return elements.remoteShell.clientHeight || elements.remoteShell.getBoundingClientRect().height;
}

function applyRemoteViewportHeight() {
  if (!elements.appFrame.classList.contains('is-remote')) {
    elements.appFrame.style.removeProperty('--remote-viewport-height');
    return;
  }

  const viewport = window.visualViewport;
  const height = resolveRemoteViewportHeight({
    layoutHeight: window.innerHeight,
    visualViewportHeight: viewport?.height,
    visualViewportOffsetTop: viewport?.offsetTop,
    visualViewportScale: viewport?.scale,
    nativeViewportHeight,
  });
  elements.appFrame.style.setProperty('--remote-viewport-height', `${Math.floor(height)}px`);
  applyRemoteHandlePosition();
}

function updateNativeViewport(event) {
  nativeViewportHeight = normalizeNativeViewportHeight(event.detail?.height);
  applyRemoteViewportHeight();
}

function placeRemoteHandle(centerY) {
  const height = remoteShellHeight();
  if (height <= 0) return null;
  const clampedCenter = clampHandleCenter(
    centerY,
    height,
    REMOTE_HANDLE_HEIGHT_PX,
    REMOTE_HANDLE_MARGIN_PX,
  );
  elements.remoteMenuToggle.style.top = `${clampedCenter}px`;
  return { centerY: clampedCenter, position: handlePositionRatio(clampedCenter, height) };
}

function applyRemoteHandlePosition() {
  const height = remoteShellHeight();
  if (height <= 0) return;
  placeRemoteHandle(remoteHandlePosition * height);
}

function beginRemoteHandleDrag(event) {
  if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
  const handleRect = elements.remoteMenuToggle.getBoundingClientRect();
  remoteHandleDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    centerOffsetY: event.clientY - (handleRect.top + handleRect.height / 2),
    position: remoteHandlePosition,
    moved: false,
  };
  suppressRemoteHandleClick = false;
  elements.remoteMenuToggle.setPointerCapture?.(event.pointerId);
}

function moveRemoteHandle(event) {
  if (!remoteHandleDrag || event.pointerId !== remoteHandleDrag.pointerId) return;
  if (!remoteHandleDrag.moved) {
    remoteHandleDrag.moved = hasHandleMoved(
      remoteHandleDrag.startX,
      remoteHandleDrag.startY,
      event.clientX,
      event.clientY,
    );
    if (remoteHandleDrag.moved) elements.remoteMenuToggle.classList.add('is-dragging');
  }
  if (!remoteHandleDrag.moved) return;
  event.preventDefault();
  const shellTop = elements.remoteShell.getBoundingClientRect().top;
  const placed = placeRemoteHandle(event.clientY - shellTop - remoteHandleDrag.centerOffsetY);
  if (placed) remoteHandleDrag.position = placed.position;
}

function finishRemoteHandleDrag(event, { cancelled = false } = {}) {
  if (!remoteHandleDrag || event.pointerId !== remoteHandleDrag.pointerId) return;
  const moved = remoteHandleDrag.moved;
  const nextPosition = remoteHandleDrag.position;
  elements.remoteMenuToggle.classList.remove('is-dragging');
  if (elements.remoteMenuToggle.hasPointerCapture?.(event.pointerId)) {
    elements.remoteMenuToggle.releasePointerCapture(event.pointerId);
  }
  remoteHandleDrag = null;
  if (cancelled) {
    applyRemoteHandlePosition();
    return;
  }
  if (!moved) return;
  event.preventDefault();
  remoteHandlePosition = nextPosition;
  writeStoredValue(storage, REMOTE_HANDLE_POSITION_KEY, String(remoteHandlePosition));
  suppressRemoteHandleClick = true;
  window.setTimeout(() => {
    suppressRemoteHandleClick = false;
  }, 0);
}

function keepFocusInRemoteDrawer(event) {
  if (
    elements.connectionNameDialog.open
    || event.key !== 'Tab'
    || !elements.remoteDrawer.classList.contains('is-open')
  ) return;
  const focusable = [...elements.remoteDrawer.querySelectorAll('button:not(:disabled)')];
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openConnectionNameDialog(serverUrl) {
  const profile = profileForServer(serverUrl);
  renamingServerUrl = serverUrl;
  elements.connectionNameServer.textContent = connectionLabel(serverUrl);
  elements.connectionName.value = profile?.name || '';
  try {
    elements.connectionNameDialog.showModal();
  } catch {
    elements.connectionNameDialog.setAttribute('open', '');
  }
  requestAnimationFrame(() => {
    elements.connectionName.focus();
    elements.connectionName.select();
  });
}

function closeConnectionNameDialog({ restoreFocus = true } = {}) {
  renamingServerUrl = '';
  if (
    elements.connectionNameDialog.open
    && typeof elements.connectionNameDialog.close === 'function'
  ) {
    elements.connectionNameDialog.close();
  } else {
    elements.connectionNameDialog.removeAttribute('open');
  }
  if (restoreFocus && elements.remoteDrawer.classList.contains('is-open')) {
    requestAnimationFrame(() => elements.closeRemoteDrawer.focus());
  }
}

function connectionButton(serverUrl) {
  const isCurrent = remoteSession?.serverUrl === serverUrl;
  const isSwitching = switchingTarget === serverUrl;
  const isUnavailable = isCurrent
    ? remoteSession.state === 'failed'
    : !authenticatedTargets.has(serverUrl);
  const entry = document.createElement('div');
  entry.className = 'connection-entry';
  entry.setAttribute('role', 'listitem');
  const button = document.createElement('button');
  button.className = 'connection-item';
  button.type = 'button';
  button.classList.toggle('is-current', isCurrent);
  button.classList.toggle('is-switching', isSwitching);
  button.classList.toggle('is-unavailable', isUnavailable);
  button.disabled = isCurrent || Boolean(switchingTarget);
  if (isCurrent) button.setAttribute('aria-current', 'true');

  const name = document.createElement('strong');
  const profile = profileForServer(serverUrl);
  const host = isSshProfile(profile)
    ? sshRouteLabel(profile)
    : new URL(serverUrl).host;
  const customName = profile?.name;
  name.textContent = customName || host;
  const hint = document.createElement('span');
  const stateHint = isCurrent
    ? `${text('remote.currentConnection')} · ${text(`remote.${remoteSession.state}`)}`
    : text(authenticatedTargets.has(serverUrl) ? 'remote.switchReady' : 'remote.switchNeedsToken');
  hint.textContent = customName ? `${host} · ${stateHint}` : stateHint;
  button.append(name, hint);
  if (!isCurrent) button.addEventListener('click', () => void switchConnection(serverUrl));

  const renameButton = document.createElement('button');
  renameButton.className = 'connection-rename';
  renameButton.type = 'button';
  renameButton.textContent = '✎';
  renameButton.setAttribute('aria-label', text('recent.rename'));
  renameButton.title = text('recent.rename');
  renameButton.addEventListener('click', () => openConnectionNameDialog(serverUrl));
  entry.append(button, renameButton);
  return entry;
}

function renderSwitchTargets() {
  if (!remoteSession) {
    elements.switchTargetList.replaceChildren();
    return;
  }
  const targets = [
    remoteSession.serverUrl,
    ...recentServers.filter((serverUrl) => serverUrl !== remoteSession.serverUrl),
  ];
  elements.switchTargetList.replaceChildren(...targets.map(connectionButton));
}

function renderRemoteState() {
  if (!remoteSession) return;
  const loading = remoteSession.state === 'loading';
  const failed = remoteSession.state === 'failed';
  const visible = remoteSession.state === 'interactive' || remoteSession.state === 'loaded';
  elements.remoteShell.setAttribute('aria-busy', String(loading));
  elements.refreshRemote.disabled = loading;
  elements.remoteNotice.textContent = remoteSession.state === 'failed'
    ? text('remote.timeout')
    : (remoteSession.storageWarning ? text('error.storageUnavailable') : '');
  elements.remoteLoadingCover.classList.toggle('is-hidden', visible);
  elements.remoteLoadingSpinner.classList.toggle('is-hidden', failed);
  elements.retryRemote.classList.toggle('is-hidden', !failed);
  elements.remoteLoadingTitle.textContent = text(failed ? 'remote.failedTitle' : 'remote.loadingTitle');
  elements.remoteLoadingHint.textContent = text(failed ? 'remote.timeout' : 'remote.loadingHint');
  renderSwitchTargets();
}

function setRemoteState(nextState, operation = connectionOperations.current()) {
  if (!remoteSession || !connectionOperations.isCurrent(operation)) return;
  clearRemoteLoadTimer();
  if (nextState !== 'loading') clearRemoteRevealTimer();
  remoteSession = transitionRemoteSession(remoteSession, nextState);
  renderRemoteState();
  if (nextState === 'loading') {
    remoteLoadTimer = window.setTimeout(
      () => setRemoteState('failed', operation),
      REMOTE_LOAD_TIMEOUT_MS,
    );
  }
}

function showRemote(
  serverUrl,
  targetUrl,
  {
    operation = connectionOperations.begin(),
    pushHistory = true,
    storageWarning = false,
    transportServerUrl = serverUrl,
    profile = null,
  } = {},
) {
  clearRemoteLoadTimer();
  clearRemoteRevealTimer();
  remoteSession = beginRemoteSession(
    serverUrl,
    targetUrl,
    storageWarning,
    { transportServerUrl, profile },
  );
  switchingTarget = '';
  elements.launcher.classList.add('is-hidden');
  elements.footer.classList.add('is-hidden');
  elements.remoteShell.classList.remove('is-hidden');
  elements.appFrame.classList.add('is-remote');
  requestAnimationFrame(applyRemoteViewportHeight);
  renderSwitchTargets();
  closeRemoteDrawer({ restoreFocus: false });
  setRemoteState('loading', operation);
  const nextFrame = elements.remoteFrame.cloneNode(false);
  nextFrame.removeAttribute('src');
  nextFrame.addEventListener('load', () => {
    if (
      !connectionOperations.isCurrent(operation)
      || elements.remoteShell.classList.contains('is-hidden')
      || nextFrame.getAttribute('src') !== targetUrl
    ) return;
    clearRemoteRevealTimer();
    remoteRevealTimer = window.setTimeout(() => {
      remoteRevealTimer = null;
      if (remoteSession?.state === 'loading') setRemoteState('interactive', operation);
    }, REMOTE_REVEAL_DELAY_MS);
  }, { once: true });
  nextFrame.addEventListener('error', () => setRemoteState('failed', operation), { once: true });
  elements.remoteFrame.replaceWith(nextFrame);
  elements.remoteFrame = nextFrame;
  nextFrame.src = targetUrl;
  if (pushHistory) window.history.pushState({ screen: 'remote' }, '', '#connected');
  return operation;
}

function showConnections({
  serverUrl,
  message = '',
  focusToken = false,
  focusSsh = false,
  focusJump = false,
  preserveSavedToken = false,
} = {}) {
  if (isSshProfile(remoteSession?.profile)) void stopSshTunnel();
  connectionOperations.begin();
  clearRemoteLoadTimer();
  clearRemoteRevealTimer();
  closeRemoteDrawer({ restoreFocus: false });
  elements.remoteFrame.src = 'about:blank';
  elements.remoteShell.classList.add('is-hidden');
  elements.launcher.classList.remove('is-hidden');
  elements.footer.classList.remove('is-hidden');
  elements.appFrame.classList.remove('is-remote');
  applyRemoteViewportHeight();
  elements.connectButton.disabled = false;
  elements.connectButton.classList.remove('is-loading');
  if (serverUrl !== undefined) {
    const profile = profileForServer(serverUrl);
    if (isSshProfile(profile)) {
      loadSshProfileIntoForm(profile);
    } else {
      elements.connectionTransport.value = 'direct';
      elements.serverUrl.value = serverUrl;
      setSshFormVisibility();
    }
  } else {
    elements.connectionTransport.value = 'direct';
    selectedSshProfileId = '';
    elements.serverUrl.value = '';
    setSshFormVisibility();
  }
  elements.accessToken.value = '';
  const keepSavedTokenHint = preserveSavedToken
    && serverUrl !== undefined
    && hasSavedTokenForServer(serverUrl);
  elements.accessToken.dataset.savedTokenHint = keepSavedTokenHint ? 'true' : 'false';
  elements.accessToken.placeholder = text(
    keepSavedTokenHint ? 'connect.savedTokenPlaceholder' : 'connect.tokenPlaceholder',
  );
  setError(message);
  renderSecurityWarning();
  requestAnimationFrame(() => {
    if (focusToken) elements.accessToken.focus();
    else if (focusJump && elements.connectionTransport.value === 'ssh') {
      const privateKey = elements.sshJumpAuthMethod?.value === 'privateKey';
      (privateKey ? elements.sshJumpPrivateKey : elements.sshJumpPassword)?.focus();
    } else if (focusSsh && elements.connectionTransport.value === 'ssh') {
      const privateKey = elements.sshAuthMethod.value === 'privateKey';
      (privateKey ? elements.sshPrivateKey : elements.sshPassword).focus();
    } else if (elements.connectionTransport.value === 'ssh') elements.sshHost.focus();
    else elements.serverUrl.focus();
  });
}

async function monitorConnectionValidation(
  connection,
  operation,
  { persistOnValid = false, attempt } = {},
) {
  const validation = await validateSavedToken(connection);
  authDebug('native-validation', { serverUrl: connection.serverUrl, validation });
  if (attempt) attempt.authentication = recordNativeValidation(attempt.authentication, validation);
  if (validation === 'valid') {
    const persistence = persistOnValid
      ? await persistConnectionAttempt(attempt)
      : { cancelled: false, metadataPersisted: true, credentialPersisted: true };
    if (persistence.cancelled) return validation;
    if (!markConnectionAttemptAuthenticated(attempt)) return validation;
    if (!connectionOperations.isCurrent(operation)) return validation;
    if (persistOnValid) {
      remoteSession = Object.freeze({
        ...remoteSession,
        storageWarning: !persistence.metadataPersisted || !persistence.credentialPersisted,
      });
    }
    renderRecentServers();
    renderRemoteState();
    return validation;
  }
  if (!connectionOperations.isCurrent(operation)) return validation;
  if (validation !== 'invalid') return validation;
  if (attempt && shouldDeferNativeInvalidation(attempt.authentication)) {
    authDebug('native-invalid-deferred', { serverUrl: connection.serverUrl });
    return validation;
  }
  if (attempt && shouldIgnoreNativeInvalidation(attempt.authentication)) return validation;
  connectionValidations.begin(connection.serverUrl);
  connectionAttempts.delete(connection.serverUrl);
  const persisted = await forgetRejectedToken(connection);
  if (!connectionOperations.isCurrent(operation)) return validation;
  renderRecentServers();
  window.history.replaceState(
    { screen: 'launcher' },
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  showConnections({
    serverUrl: connection.serverUrl,
    message: text('error.invalidToken'),
    focusToken: true,
  });
  if (!persisted) setError(text('error.storageUnavailable'));
  return validation;
}

function sshErrorText(error) {
  return String(error?.message || error || 'ssh-unavailable');
}

function recoveryFocusForError(error) {
  const raw = sshErrorText(error);
  return {
    focusToken: raw === 'missing-token',
    focusSsh: raw === 'ssh-password-required' || raw === 'ssh-private-key-required',
    focusJump: raw === 'ssh-jump-password-required' || raw === 'ssh-jump-private-key-required',
  };
}

async function resolveSshCredentials(profile, provided = {}) {
  const invoke = await nativeCredentialInvokeWithRetry();
  if (!invoke) throw new Error('ssh-secret-unavailable');
  const profileIds = sshCredentialProfileIds(profile);
  if (profileIds.length === 0) throw new Error('ssh-secret-unavailable');
  const readSecret = async (kind, value, { required = false, jump = false } = {}) => {
    const privateKeyKind = kind === 'privateKey' || kind === 'jumpPrivateKey';
    if (value && (!privateKeyKind || value.trim())) return value;
    let stored;
    let readSucceeded = false;
    for (let attempt = 0; attempt < SSH_SECRET_READ_RETRIES; attempt += 1) {
      for (const profileId of profileIds) {
        try {
          stored = await invoke('get_ssh_secret', { profileId, kind });
          readSucceeded = true;
          if (stored && (!privateKeyKind || stored.trim())) return stored;
        } catch {
          // A legacy profile id may no longer exist. Try the deterministic
          // endpoint id in the same round before treating the read as failed.
        }
      }
      // Android Keystore may report an empty value during cold-start
      // initialization. Treat it like a transient read, not a permanent
      // missing credential, and give the next attempt a chance to succeed.
      if (attempt + 1 < SSH_SECRET_READ_RETRIES) {
        await new Promise((resolve) => window.setTimeout(resolve, SSH_SECRET_READ_RETRY_DELAY_MS));
      }
    }
    if (!readSucceeded) {
      throw new Error('ssh-secret-unavailable');
    }
    if (stored && (!privateKeyKind || stored.trim())) return stored;
    if (required) {
      const prefix = jump ? 'ssh-jump-' : 'ssh-';
      const passwordKind = kind === 'password' || kind === 'jumpPassword';
      throw new Error(`${prefix}${passwordKind ? 'password-required' : 'private-key-required'}`);
    }
    return '';
  };
  const resolveSide = async (side, credentials, jump = false) => {
    const prefix = jump ? 'jump' : '';
    const authMethod = side.authMethod;
    if (authMethod === 'password') {
      return {
        password: await readSecret(prefix ? 'jumpPassword' : 'password', credentials?.password, {
          required: true,
          jump,
        }),
        privateKey: null,
        keyPassphrase: null,
      };
    }
    return {
      password: null,
      privateKey: await readSecret(prefix ? 'jumpPrivateKey' : 'privateKey', credentials?.privateKey, {
        required: true,
        jump,
      }),
      keyPassphrase: await readSecret(prefix ? 'jumpKeyPassphrase' : 'keyPassphrase', credentials?.keyPassphrase, { jump }),
    };
  };
  const target = await resolveSide(profile.ssh, {
    password: provided.password,
    privateKey: provided.privateKey,
    keyPassphrase: provided.keyPassphrase,
  });
  const jump = profile.ssh.jump
    ? await resolveSide(profile.ssh.jump, {
      password: provided.jumpPassword,
      privateKey: provided.jumpPrivateKey,
      keyPassphrase: provided.jumpKeyPassphrase,
    }, true)
    : null;
  return {
    invoke,
    ...target,
    jumpPassword: jump?.password || null,
    jumpPrivateKey: jump?.privateKey || null,
    jumpKeyPassphrase: jump?.keyPassphrase || null,
  };
}

async function stopSshTunnel() {
  const previousStop = sshStopPromise;
  const stop = previousStop.then(async () => {
    try {
      const invoke = await nativeCredentialInvokeWithRetry();
      await invoke?.('stop_ssh_tunnel');
    } catch {
      // A stale or already-closed tunnel is harmless. The next SSH connection
      // replaces the native manager state before exposing its local endpoint.
    }
  });
  sshStopPromise = stop.catch(() => undefined);
  return stop;
}

async function establishSshTunnel(profile, providedCredentials = {}) {
  let trustedProfile = profile;
  const credentials = await resolveSshCredentials(profile, providedCredentials);
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await credentials.invoke('start_ssh_tunnel', {
        host: trustedProfile.ssh.host,
        port: trustedProfile.ssh.port,
        username: trustedProfile.ssh.username,
        authMethod: trustedProfile.ssh.authMethod,
        password: credentials.password,
        privateKey: credentials.privateKey,
        keyPassphrase: credentials.keyPassphrase,
        remoteHost: '127.0.0.1',
        remotePort: trustedProfile.ssh.remotePort,
        jump: trustedProfile.ssh.jump
          ? {
            host: trustedProfile.ssh.jump.host,
            port: trustedProfile.ssh.jump.port,
            username: trustedProfile.ssh.jump.username,
            authMethod: trustedProfile.ssh.jump.authMethod,
            password: credentials.jumpPassword,
            privateKey: credentials.jumpPrivateKey,
            keyPassphrase: credentials.jumpKeyPassphrase,
            hostKeyFingerprint: trustedProfile.ssh.jump.hostKeyFingerprint || null,
          }
          : null,
        localPort: null,
        hostKeyFingerprint: trustedProfile.ssh.hostKeyFingerprint || null,
      });
      break;
    } catch (error) {
      const raw = sshErrorText(error);
      const trustCases = [
        { prefix: 'ssh-jump-host-key-untrusted:', field: 'jump', promptKey: 'error.sshJumpHostKeyTrust' },
        { prefix: 'ssh-target-host-key-untrusted:', field: 'target', promptKey: 'error.sshHostKeyTrust' },
        { prefix: 'ssh-host-key-untrusted:', field: 'target', promptKey: 'error.sshHostKeyTrust' },
      ];
      const trustCase = trustCases.find(({ prefix }) => raw.startsWith(prefix));
      if (trustCase) {
        const fingerprint = raw.slice(trustCase.prefix.length);
        const currentFingerprint = trustCase.field === 'jump'
          ? trustedProfile.ssh.jump?.hostKeyFingerprint
          : trustedProfile.ssh.hostKeyFingerprint;
        const prompt = text(trustCase.promptKey).replace('{fingerprint}', fingerprint);
        if (typeof globalThis.confirm !== 'function' || !globalThis.confirm(prompt)) {
          throw new Error(raw);
        }
        trustedProfile = trustCase.field === 'jump'
          ? {
            ...trustedProfile,
            ssh: {
              ...trustedProfile.ssh,
              jump: { ...trustedProfile.ssh.jump, hostKeyFingerprint: fingerprint },
            },
          }
          : {
            ...trustedProfile,
            ssh: { ...trustedProfile.ssh, hostKeyFingerprint: fingerprint },
          };
        if (currentFingerprint === fingerprint) throw new Error(raw);
        continue;
      }
      if (raw.startsWith('ssh-host-key-mismatch:')
        || raw.startsWith('ssh-target-host-key-mismatch:')
        || raw.startsWith('ssh-jump-host-key-mismatch:')) {
        throw new Error(raw);
      }
      throw new Error(raw);
    }
  }
  if (!result?.localUrl) throw new Error('ssh-unavailable');

  const profileIds = sshCredentialProfileIds(trustedProfile);
  const persistSecret = async (kind, secret) => {
    if (!secret || !String(secret).trim()) return;
    for (const profileId of profileIds) {
      let persisted = false;
      for (let attempt = 0; attempt < SSH_SECRET_WRITE_RETRIES; attempt += 1) {
        try {
          await credentials.invoke('set_ssh_secret', {
            profileId,
            kind,
            secret,
          });
          persisted = true;
          break;
        } catch {
          if (attempt + 1 < SSH_SECRET_WRITE_RETRIES) {
            await new Promise((resolve) => window.setTimeout(resolve, SSH_SECRET_WRITE_RETRY_DELAY_MS));
          }
        }
      }
      if (!persisted) throw new Error('ssh-secret-persistence-failed');
    }
  };
  try {
    if (trustedProfile.ssh.authMethod === 'password') {
      await persistSecret('password', credentials.password);
    } else {
      await persistSecret('privateKey', credentials.privateKey);
      await persistSecret('keyPassphrase', credentials.keyPassphrase);
    }
    if (trustedProfile.ssh.jump) {
      if (trustedProfile.ssh.jump.authMethod === 'password') {
        await persistSecret('jumpPassword', credentials.jumpPassword);
      } else {
        await persistSecret('jumpPrivateKey', credentials.jumpPrivateKey);
        await persistSecret('jumpKeyPassphrase', credentials.jumpKeyPassphrase);
      }
    }
  } catch (error) {
    await stopSshTunnel();
    throw error;
  }
  const persistedProfile = {
    ...trustedProfile,
    ssh: {
      ...trustedProfile.ssh,
      hostKeyFingerprint: result.hostKeyFingerprint || trustedProfile.ssh.hostKeyFingerprint || '',
      ...(trustedProfile.ssh.jump ? {
        jump: {
          ...trustedProfile.ssh.jump,
          hostKeyFingerprint: result.jumpHostKeyFingerprint
            || trustedProfile.ssh.jump.hostKeyFingerprint
            || '',
        },
      } : {}),
    },
  };
  return { profile: persistedProfile, result, secretsPersisted: true };
}

async function navigateConnection(
  connection,
  {
    operation = null,
    pushHistory = true,
    profile = null,
    extraStorageWarning = false,
  } = {},
) {
  if (exitRequested) return false;
  requireAccessToken(connection);
  const navigationOperation = operation || connectionOperations.begin();
  elements.connectButton.disabled = true;
  elements.connectButton.classList.add('is-loading');
  if (isSshProfile(profile || connection.profile)) {
    elements.connectionTransport.value = 'ssh';
    setSshFormVisibility();
  } else {
    elements.connectionTransport.value = 'direct';
    elements.serverUrl.value = connection.serverUrl;
    setSshFormVisibility();
  }
  elements.accessToken.value = '';
  const validationAttempt = connectionValidations.begin(connection.serverUrl);
  const isCurrent = () => (
    connectionOperations.isCurrent(navigationOperation)
    && connectionValidations.isCurrent(validationAttempt)
  );
  const metadataPersisted = rememberConnectionMetadata(
    profile ? { ...connection, profile } : connection,
  );
  const credentialAlreadyPersisted = connectionTokens.get(connection.serverUrl) === connection.token;
  const initialPersistence = await persistBeforeRemoteNavigation({
    metadataPersisted,
    credentialAlreadyPersisted,
    persistCredential: () => storeConnectionToken(connection, { isCurrent }),
    isCurrent,
  });
  if (initialPersistence.cancelled) return false;
  const { credentialPersisted } = initialPersistence;
  if (!metadataPersisted || !credentialPersisted) {
    if (isSshProfile(profile || connection.profile)) await stopSshTunnel();
    throw new Error(metadataPersisted
      ? 'credential-persistence-failed'
      : 'metadata-persistence-failed');
  }
  renderRecentServers();
  showRemote(connection.serverUrl, connection.targetUrl, {
    operation: navigationOperation,
    pushHistory,
    profile: profile || connection.profile || null,
    transportServerUrl: runtimeServerUrl(connection),
    storageWarning: extraStorageWarning || !metadataPersisted || !credentialPersisted,
  });
  const attempt = {
    connection,
    validationAttempt,
    operation: navigationOperation,
    frameWindow: elements.remoteFrame.contentWindow,
    authentication: beginConnectionAuthentication(),
    authenticated: false,
    persistenceState: credentialPersisted ? 'saved' : 'failed',
    persistencePromise: null,
    persistenceResult: initialPersistence,
  };
  connectionAttempts.set(connection.serverUrl, attempt);
  rebuildAuthenticatedTargets();
  void monitorConnectionValidation(connection, navigationOperation, {
    persistOnValid: connectionTokens.get(connection.serverUrl) !== connection.token,
    validationAttempt,
    attempt,
  }).catch((error) => {
    console.warn('Pocketmux native connection validation failed', error);
  });
  return true;
}

async function navigateToSshProfile(profile, tokenInput = '', providedCredentials = {}, { pushHistory = true } = {}) {
  if (!isSshProfile(profile)) throw new Error('ssh-invalid-config');
  const token = String(tokenInput || savedTokenForServer(profile.serverUrl) || '').trim();
  if (!token) throw new Error('missing-token');
  const operation = connectionOperations.begin();
  await sshStopPromise;
  if (!connectionOperations.isCurrent(operation)) return false;
  elements.connectionTransport.value = 'ssh';
  loadSshProfileIntoForm(profile);
  elements.connectButton.disabled = true;
  elements.connectButton.classList.add('is-loading');
  const tunnel = await establishSshTunnel(profile, providedCredentials);
  if (!connectionOperations.isCurrent(operation)) return false;
  const connection = buildSshRuntimeConnection(tunnel.profile, tunnel.result.localUrl, token);
  return navigateConnection(connection, {
    operation,
    pushHistory,
    profile: tunnel.profile,
    extraStorageWarning: !tunnel.secretsPersisted,
  });
}

async function navigateToServer(serverInput, tokenInput = '', { pushHistory = true } = {}) {
  if (exitRequested) return false;
  const existingProfile = profileForServer(serverInput);
  if (isSshProfile(existingProfile)) {
    return navigateToSshProfile(existingProfile, tokenInput, {}, { pushHistory });
  }
  if (isSshProfile(remoteSession?.profile)) await stopSshTunnel();
  const candidate = buildRemoteConnection(serverInput, tokenInput);
  const savedToken = savedTokenForServer(candidate.serverUrl);
  const connection = tokenInput || candidate.hasToken || !savedToken
    ? candidate
    : buildRemoteConnection(candidate.serverUrl, savedToken);
  requireAccessToken(connection);
  return navigateConnection(connection, { pushHistory });
}

async function restoreMostRecentConnection() {
  const candidate = restorableConnectionCandidate();
  if (!candidate) {
    authDebug('restore-skipped-no-token', {
      profiles: connectionProfiles.length,
      hydratedTokens: connectionTokens.size,
    });
    return false;
  }
  const { profile, token } = candidate;
  authDebug('restore-start', { serverUrl: profile.serverUrl });
  try {
    window.history.replaceState({ screen: 'remote' }, '', '#connected');
    if (isSshProfile(profile)) {
      return await navigateToSshProfile(profile, token, {}, { pushHistory: false });
    }
    return await navigateToServer(profile.serverUrl, token, { pushHistory: false });
  } catch (error) {
    window.history.replaceState(
      { screen: 'launcher' },
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    authDebug('restore-failed', {
      serverUrl: profile.serverUrl,
      error: sshErrorText(error),
    });
    showConnections({
      serverUrl: profile.serverUrl,
      message: localizedError(error),
      preserveSavedToken: sshErrorText(error) !== 'missing-token',
      ...recoveryFocusForError(error),
    });
    return false;
  }
}

async function switchConnection(serverUrl) {
  const plan = planConnectionSwitch(serverUrl, authenticatedTargets);
  if (plan.type === 'none') return;
  const profile = profileForServer(serverUrl);
  if (isSshProfile(profile)) {
    const token = savedTokenForServer(serverUrl);
    if (!token) {
      showConnections({
        serverUrl,
        message: text('remote.switchNeedsTokenMessage'),
        focusToken: true,
      });
      return;
    }
    switchingTarget = serverUrl;
    renderSwitchTargets();
    try {
      await navigateToSshProfile(profile, token, {}, { pushHistory: false });
    } catch (error) {
      switchingTarget = '';
      renderSwitchTargets();
      elements.remoteNotice.textContent = localizedError(error);
    }
    return;
  }
  if (plan.type === 'connect') {
    switchingTarget = serverUrl;
    renderSwitchTargets();
    try {
      await navigateToServer(plan.targetUrl, '', { pushHistory: false });
    } catch (error) {
      switchingTarget = '';
      renderSwitchTargets();
      elements.remoteNotice.textContent = localizedError(error);
    }
    return;
  }
  window.history.replaceState(
    { screen: 'launcher' },
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  showConnections({
    serverUrl: plan.serverUrl,
    message: plan.serverUrl ? text('remote.switchNeedsTokenMessage') : '',
    focusToken: Boolean(plan.serverUrl),
  });
}

function addConnection() {
  window.history.replaceState(
    { screen: 'launcher' },
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  showConnections({ serverUrl: '' });
}

async function exitNativeApp() {
  if (exitRequested) return;
  const invoke = nativeInvoke();
  if (!invoke) {
    elements.remoteNotice.textContent = text('remote.exitUnavailable');
    return;
  }
  exitRequested = true;
  elements.exitApp.disabled = true;
  try {
    if (!await drainCredentialPersistence()) {
      exitRequested = false;
      elements.exitApp.disabled = false;
      const message = text('error.storageUnavailable');
      if (elements.remoteShell.classList.contains('is-hidden')) setError(message);
      else elements.remoteNotice.textContent = message;
      return;
    }
    await invoke('exit_app');
  } catch {
    exitRequested = false;
    elements.exitApp.disabled = false;
    const message = text('remote.exitFailed');
    if (elements.remoteShell.classList.contains('is-hidden')) setError(message);
    else elements.remoteNotice.textContent = message;
  }
}

async function reloadRemoteConnection() {
  if (!remoteSession?.targetUrl) return;
  if (isSshProfile(remoteSession.profile)) {
    const token = savedTokenForServer(remoteSession.serverUrl);
    try {
      await navigateToSshProfile(remoteSession.profile, token, {}, { pushHistory: false });
    } catch (error) {
      setError(localizedError(error));
    }
    return;
  }
  const connection = buildRemoteConnection(remoteSession.targetUrl);
  elements.remoteNotice.textContent = text('remote.validatingToken');
  try {
    await navigateToServer(connection.serverUrl, connection.token, { pushHistory: false });
  } catch (error) {
    setError(localizedError(error));
  }
}

function recentServerRow(serverUrl) {
  const profile = profileForServer(serverUrl);
  const row = document.createElement('li');
  row.className = 'recent-item';

  const details = document.createElement('div');
  details.className = 'recent-details';
  const name = document.createElement('strong');
  name.textContent = connectionLabel(serverUrl);
  const url = document.createElement('span');
  url.textContent = isSshProfile(profile)
    ? sshRouteLabel(profile)
    : serverUrl;
  details.append(name, url);

  const actions = document.createElement('div');
  actions.className = 'recent-actions';
  const openButton = document.createElement('button');
  openButton.className = 'recent-open';
  openButton.type = 'button';
  openButton.textContent = text('recent.open');
  openButton.addEventListener('click', async () => {
    if (!initializationSettled) connectionOperations.begin();
    setError('');
    if (isSshProfile(profile)) loadSshProfileIntoForm(profile);
    else {
      elements.connectionTransport.value = 'direct';
      elements.serverUrl.value = serverUrl;
      setSshFormVisibility();
    }
    const savedToken = savedTokenForServer(serverUrl);
    if (!savedToken) {
      elements.accessToken.value = '';
      elements.accessToken.focus();
      return;
    }
    try {
      if (isSshProfile(profile)) {
        await navigateToSshProfile(profile, savedToken, sshCredentialsFromForm());
      } else {
        await navigateToServer(serverUrl, savedToken);
      }
    } catch (error) {
      setError(localizedError(error));
    }
  });

  const removeButton = document.createElement('button');
  removeButton.className = 'recent-remove';
  removeButton.type = 'button';
  removeButton.textContent = '×';
  removeButton.setAttribute('aria-label', text('recent.remove'));
  removeButton.title = text('recent.remove');
  removeButton.addEventListener('click', async () => {
    connectionOperations.begin();
    connectionValidations.begin(serverUrl);
    connectionAttempts.delete(serverUrl);
    const credentialDeleted = await deleteConnectionToken(serverUrl);
    if (!credentialDeleted) {
      setError(text('error.storageUnavailable'));
      return;
    }
    legacyConnectionTokens = legacyConnectionTokens.filter((item) => item.serverUrl !== serverUrl);
    if (isSshProfile(profile)) {
      const invoke = await nativeCredentialInvokeWithRetry();
      try {
        await stopSshTunnel();
        for (const profileId of sshCredentialProfileIds(profile)) {
          await invoke?.('delete_ssh_secrets', { profileId });
        }
      } catch {
        // The profile is still removed locally; stale native state is harmless on next launch.
      }
    }
    connectionProfiles = removeConnectionProfile(connectionProfiles, serverUrl);
    if (!persistConnectionProfiles()) setError(text('error.storageUnavailable'));
    renderRecentServers();
  });

  const renameButton = document.createElement('button');
  renameButton.className = 'recent-rename';
  renameButton.type = 'button';
  renameButton.textContent = '✎';
  renameButton.setAttribute('aria-label', text('recent.rename'));
  renameButton.title = text('recent.rename');
  renameButton.addEventListener('click', () => openConnectionNameDialog(serverUrl));

  actions.append(openButton, renameButton, removeButton);
  row.append(details, actions);
  return row;
}

function renderRecentServers() {
  elements.recentList.replaceChildren(...recentServers.map(recentServerRow));
  elements.recentCount.textContent = String(recentServers.length);
  elements.recentEmpty.classList.toggle('is-hidden', recentServers.length > 0);
  renderSwitchTargets();
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  connectionOperations.begin();
  setError('');
  try {
    if (elements.connectionTransport.value === 'ssh') {
      const existing = selectedSshProfileId
        ? connectionProfiles.find((profile) => profile.id === selectedSshProfileId)
        : null;
      const profile = sshProfileFromForm(existing);
      await navigateToSshProfile(
        profile,
        elements.accessToken.value,
        sshCredentialsFromForm(),
      );
    } else {
      await navigateToServer(elements.serverUrl.value, elements.accessToken.value);
    }
  } catch (error) {
    elements.connectButton.disabled = false;
    elements.connectButton.classList.remove('is-loading');
    setLocalizedError(error);
  }
});

elements.serverUrl.addEventListener('input', () => {
  if (!initializationSettled) connectionOperations.begin();
  setError('');
  renderSecurityWarning();
});

elements.connectionTransport.addEventListener('change', () => {
  setError('');
  setSshFormVisibility();
});
elements.sshAuthMethod.addEventListener('change', () => {
  setError('');
  setSshFormVisibility();
});
elements.sshJumpEnabled?.addEventListener('change', () => {
  setError('');
  setSshFormVisibility();
});
elements.sshJumpAuthMethod?.addEventListener('change', () => {
  setError('');
  setSshFormVisibility();
});
[
  elements.sshHost,
  elements.sshPort,
  elements.sshUsername,
  elements.sshPassword,
  elements.sshPrivateKey,
  elements.sshKeyPassphrase,
  elements.sshRemotePort,
  elements.sshJumpHost,
  elements.sshJumpPort,
  elements.sshJumpUsername,
  elements.sshJumpPassword,
  elements.sshJumpPrivateKey,
  elements.sshJumpKeyPassphrase,
].forEach((field) => field.addEventListener('input', () => setError('')));

function supersedeStartupForTokenEdit() {
  if (!initializationSettled) connectionOperations.begin();
}

elements.accessToken.addEventListener('focus', supersedeStartupForTokenEdit);
elements.accessToken.addEventListener('input', () => {
  supersedeStartupForTokenEdit();
  setError('');
});

elements.toggleToken.addEventListener('click', () => {
  const showing = elements.accessToken.type === 'text';
  elements.accessToken.type = showing ? 'password' : 'text';
  renderTokenVisibility();
});

elements.languageButtons.forEach((button) => {
  button.addEventListener('click', () => setLanguage(button.dataset.language));
});

window.addEventListener('message', receiveRemoteLanguage);

elements.connectionNameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!renamingServerUrl) {
    closeConnectionNameDialog();
    return;
  }
  if (!profileForServer(renamingServerUrl)) {
    const remembered = rememberConnectionProfile(
      null,
      CONNECTION_PROFILES_KEY,
      connectionProfiles,
      { serverUrl: renamingServerUrl },
    );
    connectionProfiles = remembered.connectionProfiles;
  }
  connectionProfiles = renameConnectionProfile(
    connectionProfiles,
    renamingServerUrl,
    elements.connectionName.value,
  );
  const persisted = persistConnectionProfiles();
  renderRecentServers();
  closeConnectionNameDialog({ restoreFocus: false });
  if (!persisted) {
    if (elements.remoteShell.classList.contains('is-hidden')) setError(text('error.storageUnavailable'));
    else elements.remoteNotice.textContent = text('error.storageUnavailable');
  }
});

elements.cancelConnectionName.addEventListener('click', closeConnectionNameDialog);
elements.connectionNameDialog.addEventListener('close', () => {
  renamingServerUrl = '';
  if (elements.remoteDrawer.classList.contains('is-open')) {
    requestAnimationFrame(() => elements.closeRemoteDrawer.focus());
  }
});

elements.refreshRemote.addEventListener('click', () => {
  void reloadRemoteConnection();
});

elements.addConnection.addEventListener('click', addConnection);
elements.exitApp.addEventListener('click', exitNativeApp);

elements.retryRemote.addEventListener('click', () => {
  void reloadRemoteConnection();
});

elements.remoteMenuToggle.addEventListener('click', (event) => {
  if (suppressRemoteHandleClick) {
    event.preventDefault();
    suppressRemoteHandleClick = false;
    return;
  }
  openRemoteDrawer();
});
elements.remoteMenuToggle.addEventListener('pointerdown', beginRemoteHandleDrag);
elements.remoteMenuToggle.addEventListener('pointermove', moveRemoteHandle);
elements.remoteMenuToggle.addEventListener('pointerup', (event) => finishRemoteHandleDrag(event));
elements.remoteMenuToggle.addEventListener('pointercancel', (event) => {
  finishRemoteHandleDrag(event, { cancelled: true });
});
elements.closeRemoteDrawer.addEventListener('click', () => closeRemoteDrawer());
elements.remoteDrawerBackdrop.addEventListener('click', () => closeRemoteDrawer());

elements.drawerEdgeTarget.addEventListener('pointerdown', (event) => {
  drawerGestureStart = event.clientX;
  elements.drawerEdgeTarget.setPointerCapture?.(event.pointerId);
});

elements.drawerEdgeTarget.addEventListener('pointerup', (event) => {
  if (drawerGestureStart !== null && event.clientX - drawerGestureStart >= 48) openRemoteDrawer();
  drawerGestureStart = null;
});

elements.drawerEdgeTarget.addEventListener('pointercancel', () => {
  drawerGestureStart = null;
});

elements.remoteDrawer.addEventListener('pointerdown', (event) => {
  if (!shouldBeginDrawerSwipe(event.target)) return;
  drawerGestureStart = event.clientX;
  elements.remoteDrawer.setPointerCapture?.(event.pointerId);
});

elements.remoteDrawer.addEventListener('pointerup', (event) => {
  if (drawerGestureStart !== null && event.clientX - drawerGestureStart <= -48) closeRemoteDrawer();
  drawerGestureStart = null;
});

elements.remoteDrawer.addEventListener('pointercancel', () => {
  drawerGestureStart = null;
});

document.addEventListener('keydown', (event) => {
  keepFocusInRemoteDrawer(event);
  if (event.key === 'Escape' && elements.remoteDrawer.classList.contains('is-open')) {
    closeRemoteDrawer();
  }
});

window.addEventListener('popstate', () => {
  if (window.history.state?.screen === 'remote' && remoteSession) {
    if (isSshProfile(remoteSession.profile)) {
      void navigateToSshProfile(
        remoteSession.profile,
        savedTokenForServer(remoteSession.serverUrl),
        {},
        { pushHistory: false },
      );
      return;
    }
    const connection = buildRemoteConnection(remoteSession.targetUrl);
    void navigateToServer(connection.serverUrl, connection.token, { pushHistory: false });
  } else {
    showConnections();
  }
});

window.addEventListener('resize', applyRemoteViewportHeight);
window.visualViewport?.addEventListener('resize', applyRemoteViewportHeight);
window.addEventListener(NATIVE_VIEWPORT_EVENT_TYPE, updateNativeViewport);

window.history.replaceState({ screen: 'launcher' }, '', `${window.location.pathname}${window.location.search}`);
applyLanguage();

async function initializeNativeApp() {
  const initializationOperation = connectionOperations.current();
  await initializeConnections({
    operation: initializationOperation,
    isCurrent: (operation) => connectionOperations.isCurrent(operation),
    hydrateCredentials: hydrateConnectionTokens,
    migrateLegacyCredentials: migrateLegacyConnectionTokens,
    applyHydratedState: () => {
      initializationSettled = true;
      rebuildAuthenticatedTargets();
      renderRecentServers();
      applyLanguage();
    },
    applyCompletedState: async ({ hydration, migrated }) => {
      rebuildAuthenticatedTargets();
      initializationSettled = true;
      if (recentServers[0]) elements.serverUrl.value = recentServers[0];
      applyLanguage();
      const restored = await restoreMostRecentConnection();
      if (!restored && (!migrated || (connectionProfiles.length > 0 && !hydration.complete))) {
        setError(text('error.storageUnavailable'));
      }
    },
  });
}

async function bootNativeApp() {
  try {
    await ensureShellSession();
  } catch {
    authDebug('shell-unavailable-during-boot');
  }
  try {
    await initializeNativeApp();
  } catch {
    initializationSettled = true;
    setError(text('error.storageUnavailable'));
    authDebug('native-app-initialization-failed');
  }
}

void bootNativeApp();
