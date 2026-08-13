import {
  buildConnection,
  isInsecureServer,
  requireAccessToken,
} from './connection.js';
import { planConnectionSwitch } from './connection-switch.js';
import { createConnectionOperationTracker } from './connection-operations.js';
import { migrateLegacyCredentials } from './credential-migration.js';
import { initializeConnections } from './connection-initialization.js';
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
  writeStoredValue,
} from './storage.js';

const LANGUAGE_KEY = 'pocketmux-native-language';
const CONNECTION_PROFILES_KEY = 'pocketmux-native-connection-profiles-v1';
const LEGACY_RECENT_SERVERS_KEY = 'pocketmux-native-recent-servers';
const REMOTE_HANDLE_POSITION_KEY = 'pocketmux-native-remote-handle-position-v1';
const REMOTE_HANDLE_HEIGHT_PX = 58;
const REMOTE_HANDLE_MARGIN_PX = 12;
const REMOTE_LOAD_TIMEOUT_MS = 15000;
const REMOTE_REVEAL_DELAY_MS = 1600;
const REMOTE_LANGUAGE_MESSAGE_TYPE = 'pocketmux:language';
const REMOTE_AUTH_REQUIRED_MESSAGE_TYPE = 'pocketmux:authentication-required';
const connectionPolicy = {
  allowPrivateHttp: !/\bAndroid\b/i.test(window.navigator.userAgent),
};

const elements = {
  appFrame: document.querySelector('.app-frame'),
  launcher: document.querySelector('#launcher'),
  footer: document.querySelector('#app-footer'),
  form: document.querySelector('#connection-form'),
  serverUrl: document.querySelector('#server-url'),
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
let currentErrorKey = '';
let initializationSettled = false;
const connectionOperations = createConnectionOperationTracker();
const connectionTokens = new Map();
const authenticatedTargets = new Map();
let credentialMutationQueue = Promise.resolve();
let initializationPromise = Promise.resolve();
let shellSessionToken = '';

function text(key) {
  return messages[language][key] || messages.zh[key] || key;
}

function setError(message = '') {
  currentErrorKey = '';
  elements.error.textContent = message;
}

function localizedError(error) {
  return text(errorMessageKey(error));
}

function setLocalizedError(error) {
  currentErrorKey = errorMessageKey(error);
  elements.error.textContent = text(currentErrorKey);
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

function profileForServer(serverUrl) {
  return connectionProfiles.find((profile) => profile.serverUrl === serverUrl);
}

function connectionLabel(serverUrl) {
  return profileForServer(serverUrl)?.name || new URL(serverUrl).host;
}

function rebuildAuthenticatedTargets() {
  authenticatedTargets.clear();
  for (const profile of connectionProfiles) {
    const token = connectionTokens.get(profile.serverUrl) || '';
    if (!token) continue;
    try {
      const connection = requireAccessToken(buildRemoteConnection(profile.serverUrl, token));
      authenticatedTargets.set(connection.serverUrl, connection.targetUrl);
    } catch {
      // Keep malformed or platform-incompatible legacy profiles out of direct switching.
    }
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
  const remembered = rememberConnectionProfile(
    null,
    CONNECTION_PROFILES_KEY,
    connectionProfiles,
    { serverUrl: connection.serverUrl },
  );
  connectionProfiles = remembered.connectionProfiles;
  recentServers = connectionProfiles.map((profile) => profile.serverUrl);
  return persistConnectionProfiles();
}

function nativeInvoke() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke || !shellSessionToken) return null;
  return (command, arguments_ = {}) => invoke(command, {
    ...arguments_,
    sessionToken: shellSessionToken,
  });
}

function createShellSessionToken() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function initializeShellSession() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  const sessionToken = createShellSessionToken();
  await invoke('register_shell_session', { sessionToken });
  shellSessionToken = sessionToken;
}

function queueCredentialMutation(mutation) {
  const result = credentialMutationQueue.then(mutation, mutation);
  credentialMutationQueue = result.catch(() => undefined);
  return result;
}

async function storeConnectionToken(connection) {
  return queueCredentialMutation(async () => {
    const invoke = nativeInvoke();
    if (!invoke) return false;
    try {
      await invoke('set_connection_token', {
        serverUrl: connection.serverUrl,
        token: connection.token,
      });
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
      return true;
    } catch {
      return false;
    }
  });
}

async function storeLegacyConnectionToken(connection) {
  return queueCredentialMutation(async () => {
    const pendingLegacyToken = legacyConnectionTokens.find(
      (item) => item.serverUrl === connection.serverUrl && item.token === connection.token,
    );
    if (!profileForServer(connection.serverUrl) || !pendingLegacyToken) return true;
    if (connectionTokens.has(connection.serverUrl)) return true;
    const invoke = nativeInvoke();
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
    const invoke = nativeInvoke();
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
    const invoke = nativeInvoke();
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
    const invoke = nativeInvoke();
    if (!invoke) return { complete: false, states: new Map() };
    if (connectionProfiles.length === 0) return { complete: true, states: new Map() };
    const serverUrls = connectionProfiles.map((profile) => profile.serverUrl);
    try {
      const results = await invoke('get_connection_tokens', { serverUrls });
      let complete = true;
      const states = new Map();
      serverUrls.forEach((serverUrl, index) => {
        const result = results?.[index];
        if (!result || typeof result !== 'object' || !('Ok' in result)) {
          complete = false;
          states.set(serverUrl, 'unknown');
          return;
        }
        const token = typeof result.Ok === 'string' ? result.Ok.trim() : '';
        if (token) {
          connectionTokens.set(serverUrl, token);
          states.set(serverUrl, 'present');
        } else {
          states.set(serverUrl, 'missing');
        }
      });
      rebuildAuthenticatedTargets();
      return { complete, states };
    } catch {
      return {
        complete: false,
        states: new Map(serverUrls.map((serverUrl) => [serverUrl, 'unknown'])),
      };
    }
  });
}

async function migrateLegacyConnectionTokens(existingCredentialStates) {
  const durableLegacyRecord = [...legacyConnectionTokens];
  const migration = await migrateLegacyCredentials(legacyConnectionTokens, {
    buildConnection: buildRemoteConnection,
    credentialState: async (connection) => existingCredentialStates.get(connection.serverUrl) || 'unknown',
    validateCredential: validateSavedToken,
    storeCredential: storeLegacyConnectionToken,
    persistMigrationProgress: (remaining) => {
      const activeServers = new Set(connectionProfiles.map((profile) => profile.serverUrl));
      const previous = connectionProfiles;
      legacyConnectionTokens = remaining.filter((item) => activeServers.has(item.serverUrl));
      if (persistConnectionProfiles()) return true;
      connectionProfiles = previous;
      legacyConnectionTokens = durableLegacyRecord;
      return false;
    },
  });
  const activeServers = new Set(connectionProfiles.map((profile) => profile.serverUrl));
  legacyConnectionTokens = migration.complete
    ? []
    : durableLegacyRecord.filter((item) => activeServers.has(item.serverUrl));
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
  const invoke = nativeInvoke();
  if (!invoke) return 'unknown';
  try {
    return await invoke('validate_token', {
      serverUrl: connection.serverUrl,
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

function receiveRemoteLanguage(event) {
  if (!remoteSession || event.source !== elements.remoteFrame.contentWindow) return;
  if (event.origin !== new URL(remoteSession.serverUrl).origin) return;
  if (event.data?.type === REMOTE_LANGUAGE_MESSAGE_TYPE) {
    if (event.data.language !== 'zh' && event.data.language !== 'en') return;
    setLanguage(event.data.language);
    return;
  }
  if (event.data?.type !== REMOTE_AUTH_REQUIRED_MESSAGE_TYPE) return;
  const rejectedConnection = buildRemoteConnection(remoteSession.targetUrl);
  const operation = connectionOperations.current();
  void forgetRejectedToken(rejectedConnection).then((persisted) => {
    if (!connectionOperations.isCurrent(operation)) return;
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
  if (!profile) return;
  renamingServerUrl = serverUrl;
  elements.connectionNameServer.textContent = new URL(serverUrl).host;
  elements.connectionName.value = profile.name || '';
  elements.connectionNameDialog.showModal();
  requestAnimationFrame(() => {
    elements.connectionName.focus();
    elements.connectionName.select();
  });
}

function closeConnectionNameDialog({ restoreFocus = true } = {}) {
  renamingServerUrl = '';
  elements.connectionNameDialog.close();
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
  const host = new URL(serverUrl).host;
  const customName = profileForServer(serverUrl)?.name;
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
  elements.remoteShell.setAttribute('aria-busy', String(loading));
  elements.refreshRemote.disabled = loading;
  elements.remoteNotice.textContent = remoteSession.state === 'failed'
    ? text('remote.timeout')
    : (remoteSession.storageWarning ? text('error.storageUnavailable') : '');
  elements.remoteLoadingCover.classList.toggle('is-hidden', remoteSession.state === 'loaded');
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

function showRemote(serverUrl, targetUrl, { pushHistory = true, storageWarning = false } = {}) {
  const operation = connectionOperations.begin();
  clearRemoteLoadTimer();
  clearRemoteRevealTimer();
  remoteSession = beginRemoteSession(serverUrl, targetUrl, storageWarning);
  switchingTarget = '';
  elements.launcher.classList.add('is-hidden');
  elements.footer.classList.add('is-hidden');
  elements.remoteShell.classList.remove('is-hidden');
  elements.appFrame.classList.add('is-remote');
  requestAnimationFrame(applyRemoteHandlePosition);
  renderSwitchTargets();
  closeRemoteDrawer({ restoreFocus: false });
  setRemoteState('loading', operation);
  const nextFrame = elements.remoteFrame.cloneNode(false);
  nextFrame.removeAttribute('src');
  nextFrame.addEventListener('load', () => {
    if (
      !connectionOperations.isCurrent(operation)
      || elements.remoteShell.classList.contains('is-hidden')
    ) return;
    clearRemoteRevealTimer();
    remoteRevealTimer = window.setTimeout(
      () => setRemoteState('loaded', operation),
      REMOTE_REVEAL_DELAY_MS,
    );
  }, { once: true });
  nextFrame.addEventListener('error', () => setRemoteState('failed', operation), { once: true });
  elements.remoteFrame.replaceWith(nextFrame);
  elements.remoteFrame = nextFrame;
  nextFrame.src = targetUrl;
  if (pushHistory) window.history.pushState({ screen: 'remote' }, '', '#connected');
  return operation;
}

function showConnections({ serverUrl, message = '', focusToken = false } = {}) {
  connectionOperations.begin();
  clearRemoteLoadTimer();
  clearRemoteRevealTimer();
  closeRemoteDrawer({ restoreFocus: false });
  elements.remoteFrame.src = 'about:blank';
  elements.remoteShell.classList.add('is-hidden');
  elements.launcher.classList.remove('is-hidden');
  elements.footer.classList.remove('is-hidden');
  elements.appFrame.classList.remove('is-remote');
  elements.connectButton.disabled = false;
  elements.connectButton.classList.remove('is-loading');
  if (serverUrl !== undefined) elements.serverUrl.value = serverUrl;
  elements.accessToken.value = '';
  setError(message);
  renderSecurityWarning();
  requestAnimationFrame(() => (focusToken ? elements.accessToken : elements.serverUrl).focus());
}

async function monitorConnectionValidation(connection, operation, { persistOnValid = false } = {}) {
  const validation = await validateSavedToken(connection);
  if (!connectionOperations.isCurrent(operation)) return validation;
  if (validation === 'valid' && persistOnValid) {
    const persistence = await persistValidatedCredential({
      initialization: initializationPromise,
      isCurrent: () => connectionOperations.isCurrent(operation),
      persistMetadata: () => rememberConnectionMetadata(connection),
      persistCredential: () => storeConnectionToken(connection),
    });
    if (persistence.cancelled) return validation;
    remoteSession = Object.freeze({
      ...remoteSession,
      storageWarning: !persistence.metadataPersisted || !persistence.credentialPersisted,
    });
    renderRecentServers();
    renderRemoteState();
    return validation;
  }
  if (validation !== 'invalid') return validation;
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

async function navigateToServer(serverInput, tokenInput = '', { pushHistory = true } = {}) {
  const candidate = buildRemoteConnection(serverInput, tokenInput);
  const savedToken = connectionTokens.get(candidate.serverUrl) || '';
  const connection = tokenInput || candidate.hasToken || !savedToken
    ? candidate
    : buildRemoteConnection(candidate.serverUrl, savedToken);
  requireAccessToken(connection);
  elements.connectButton.disabled = true;
  elements.connectButton.classList.add('is-loading');
  elements.serverUrl.value = connection.serverUrl;
  elements.accessToken.value = '';
  const operation = showRemote(connection.serverUrl, connection.targetUrl, {
    pushHistory,
  });
  void monitorConnectionValidation(connection, operation, {
    persistOnValid: connectionTokens.get(connection.serverUrl) !== connection.token,
  });
  return true;
}

async function restoreMostRecentConnection() {
  const profile = connectionProfiles[0];
  const token = profile ? connectionTokens.get(profile.serverUrl) : '';
  if (!profile || !token) return false;
  try {
    window.history.replaceState({ screen: 'remote' }, '', '#connected');
    return await navigateToServer(profile.serverUrl, token, { pushHistory: false });
  } catch (error) {
    window.history.replaceState(
      { screen: 'launcher' },
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    showConnections({
      serverUrl: profile.serverUrl,
      message: localizedError(error),
      focusToken: true,
    });
    return false;
  }
}

async function switchConnection(serverUrl) {
  const plan = planConnectionSwitch(serverUrl, authenticatedTargets);
  if (plan.type === 'none') return;
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
  const invoke = nativeInvoke();
  if (!invoke) {
    elements.remoteNotice.textContent = text('remote.exitUnavailable');
    return;
  }
  elements.exitApp.disabled = true;
  try {
    await invoke('exit_app');
  } catch {
    elements.exitApp.disabled = false;
    elements.remoteNotice.textContent = text('remote.exitFailed');
  }
}

async function reloadRemoteConnection() {
  if (!remoteSession?.targetUrl) return;
  const connection = buildRemoteConnection(remoteSession.targetUrl);
  const operation = connectionOperations.current();
  setRemoteState('loading', operation);
  elements.remoteNotice.textContent = text('remote.validatingToken');
  const validation = await validateSavedToken(connection);
  if (!connectionOperations.isCurrent(operation)) return;
  if (validation === 'invalid') {
    const persisted = await forgetRejectedToken(connection);
    if (!connectionOperations.isCurrent(operation)) return;
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
    renderRecentServers();
    return;
  }
  showRemote(connection.serverUrl, connection.targetUrl, { pushHistory: false });
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
  url.textContent = serverUrl;
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
    elements.serverUrl.value = serverUrl;
    renderSecurityWarning();
    const savedToken = connectionTokens.get(serverUrl) || '';
    if (!savedToken) {
      elements.accessToken.value = '';
      elements.accessToken.focus();
      return;
    }
    try {
      await navigateToServer(serverUrl, savedToken);
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
    const credentialDeleted = await deleteConnectionToken(serverUrl);
    if (!credentialDeleted) {
      setError(text('error.storageUnavailable'));
      return;
    }
    legacyConnectionTokens = legacyConnectionTokens.filter((item) => item.serverUrl !== serverUrl);
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
    await navigateToServer(elements.serverUrl.value, elements.accessToken.value);
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
  if (!renamingServerUrl || !profileForServer(renamingServerUrl)) {
    closeConnectionNameDialog();
    return;
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
    showRemote(remoteSession.serverUrl, remoteSession.targetUrl, {
      pushHistory: false,
      storageWarning: remoteSession.storageWarning,
    });
  } else {
    showConnections();
  }
});

window.addEventListener('resize', applyRemoteHandlePosition);
window.visualViewport?.addEventListener('resize', applyRemoteHandlePosition);

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
    await initializeShellSession();
    await initializeNativeApp();
  } catch {
    initializationSettled = true;
    setError(text('error.storageUnavailable'));
  }
}

initializationPromise = bootNativeApp();
void initializationPromise;
