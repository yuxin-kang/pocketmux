import {
  buildConnection,
  isInsecureServer,
  requireAccessToken,
} from './connection.js';
import { NEW_SERVER_TARGET, planConnectionSwitch } from './connection-switch.js';
import { shouldBeginDrawerSwipe } from './drawer-gesture.js';
import { messages, normalizeLanguage } from './i18n.js';
import { beginRemoteSession, transitionRemoteSession } from './remote-session.js';
import {
  loadConnectionProfiles,
  readStoredValue,
  rememberConnectionProfile,
  removeConnectionProfile,
  saveConnectionProfiles,
  writeStoredValue,
} from './storage.js';

const LANGUAGE_KEY = 'pocketmux-native-language';
const CONNECTION_PROFILES_KEY = 'pocketmux-native-connection-profiles-v1';
const LEGACY_RECENT_SERVERS_KEY = 'pocketmux-native-recent-servers';
const REMOTE_LOAD_TIMEOUT_MS = 15000;
const REMOTE_REVEAL_DELAY_MS = 1600;
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
  remoteServer: document.querySelector('#remote-server'),
  remoteStatus: document.querySelector('#remote-status'),
  remoteNotice: document.querySelector('#remote-notice'),
  remoteLoadingCover: document.querySelector('#remote-loading-cover'),
  remoteLoadingSpinner: document.querySelector('#remote-loading-spinner'),
  remoteLoadingTitle: document.querySelector('#remote-loading-title'),
  remoteLoadingHint: document.querySelector('#remote-loading-hint'),
  retryRemote: document.querySelector('#retry-remote'),
  refreshRemote: document.querySelector('#refresh-remote'),
  switchTargetList: document.querySelector('#switch-target-list'),
  switchConnection: document.querySelector('#switch-connection'),
  exitApp: document.querySelector('#exit-app'),
  languageButtons: [...document.querySelectorAll('[data-language]')],
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
let recentServers = connectionProfiles.map((profile) => profile.serverUrl);
let remoteSession = null;
let remoteLoadTimer = null;
let remoteRevealTimer = null;
let drawerGestureStart = null;
let selectedSwitchTarget = '';
const authenticatedTargets = new Map();

function text(key) {
  return messages[language][key] || messages.zh[key] || key;
}

function setError(message = '') {
  elements.error.textContent = message;
}

function localizedError(error) {
  if (error?.message === 'invalid-url') return text('error.invalidUrl');
  if (error?.message === 'public-http') return text('error.publicHttp');
  if (error?.message === 'android-http') return text('error.androidHttp');
  if (error?.message === 'native-origin') return text('error.nativeOrigin');
  if (error?.message === 'missing-token') return text('error.missingToken');
  return text('error.unsupportedUrl');
}

function buildRemoteConnection(serverInput, tokenInput = '') {
  const connection = buildConnection(serverInput, tokenInput, connectionPolicy);
  if (new URL(connection.serverUrl).origin === window.location.origin) {
    throw new Error('native-origin');
  }
  return connection;
}

function profileForServer(serverUrl) {
  return connectionProfiles.find((profile) => profile.serverUrl === serverUrl);
}

function rebuildAuthenticatedTargets() {
  authenticatedTargets.clear();
  for (const profile of connectionProfiles) {
    if (!profile.token) continue;
    try {
      const connection = requireAccessToken(buildRemoteConnection(profile.serverUrl, profile.token));
      authenticatedTargets.set(connection.serverUrl, connection.targetUrl);
    } catch {
      // Keep malformed or platform-incompatible legacy profiles out of direct switching.
    }
  }
}

function persistConnectionProfiles() {
  recentServers = connectionProfiles.map((profile) => profile.serverUrl);
  rebuildAuthenticatedTargets();
  return saveConnectionProfiles(storage, CONNECTION_PROFILES_KEY, connectionProfiles);
}

function rememberConnection(connection) {
  const remembered = rememberConnectionProfile(
    storage,
    CONNECTION_PROFILES_KEY,
    connectionProfiles,
    connection,
  );
  connectionProfiles = remembered.connectionProfiles;
  recentServers = connectionProfiles.map((profile) => profile.serverUrl);
  rebuildAuthenticatedTargets();
  return remembered.persisted;
}

function forgetRejectedToken(connection) {
  const profile = profileForServer(connection.serverUrl);
  if (!profile || profile.token !== connection.token) return true;
  connectionProfiles = connectionProfiles.map((item) => (
    item.serverUrl === connection.serverUrl ? { ...item, token: '' } : item
  ));
  return persistConnectionProfiles();
}

async function validateSavedToken(connection) {
  const invoke = window.__TAURI__?.core?.invoke;
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

function keepFocusInRemoteDrawer(event) {
  if (event.key !== 'Tab' || !elements.remoteDrawer.classList.contains('is-open')) return;
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

function switchTargetButton(serverUrl) {
  const isNewServer = serverUrl === NEW_SERVER_TARGET;
  const selected = selectedSwitchTarget === serverUrl;
  const button = document.createElement('button');
  button.className = 'switch-target';
  button.type = 'button';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(selected));

  const name = document.createElement('strong');
  name.textContent = isNewServer ? text('remote.switchOther') : new URL(serverUrl).host;
  const hint = document.createElement('span');
  hint.textContent = isNewServer
    ? text('remote.switchOtherHint')
    : text(authenticatedTargets.has(serverUrl) ? 'remote.switchReady' : 'remote.switchNeedsToken');
  button.append(name, hint);
  button.addEventListener('click', () => {
    selectedSwitchTarget = serverUrl;
    renderSwitchTargets();
  });
  return button;
}

function renderSwitchTargets() {
  if (!remoteSession) {
    elements.switchTargetList.replaceChildren();
    elements.switchConnection.disabled = true;
    return;
  }
  const alternatives = recentServers.filter((serverUrl) => serverUrl !== remoteSession.serverUrl);
  const targets = [...alternatives, NEW_SERVER_TARGET];
  if (!targets.includes(selectedSwitchTarget)) selectedSwitchTarget = targets[0];
  elements.switchTargetList.replaceChildren(...targets.map(switchTargetButton));
  elements.switchConnection.disabled = !selectedSwitchTarget;
}

function renderRemoteState() {
  if (!remoteSession) return;
  const loading = remoteSession.state === 'loading';
  const failed = remoteSession.state === 'failed';
  elements.remoteShell.setAttribute('aria-busy', String(loading));
  elements.refreshRemote.disabled = loading;
  elements.remoteStatus.textContent = text(`remote.${remoteSession.state}`);
  elements.remoteNotice.textContent = remoteSession.state === 'failed'
    ? text('remote.timeout')
    : (remoteSession.storageWarning ? text('error.storageUnavailable') : '');
  elements.remoteLoadingCover.classList.toggle('is-hidden', remoteSession.state === 'loaded');
  elements.remoteLoadingSpinner.classList.toggle('is-hidden', failed);
  elements.retryRemote.classList.toggle('is-hidden', !failed);
  elements.remoteLoadingTitle.textContent = text(failed ? 'remote.failedTitle' : 'remote.loadingTitle');
  elements.remoteLoadingHint.textContent = text(failed ? 'remote.timeout' : 'remote.loadingHint');
}

function setRemoteState(nextState) {
  if (!remoteSession) return;
  clearRemoteLoadTimer();
  if (nextState !== 'loading') clearRemoteRevealTimer();
  remoteSession = transitionRemoteSession(remoteSession, nextState);
  renderRemoteState();
  if (nextState === 'loading') {
    remoteLoadTimer = window.setTimeout(() => setRemoteState('failed'), REMOTE_LOAD_TIMEOUT_MS);
  }
}

function showRemote(serverUrl, targetUrl, { pushHistory = true, storageWarning = false } = {}) {
  remoteSession = beginRemoteSession(serverUrl, targetUrl, storageWarning);
  selectedSwitchTarget = '';
  elements.remoteServer.textContent = new URL(serverUrl).host;
  elements.remoteServer.title = serverUrl;
  elements.launcher.classList.add('is-hidden');
  elements.footer.classList.add('is-hidden');
  elements.remoteShell.classList.remove('is-hidden');
  elements.appFrame.classList.add('is-remote');
  renderSwitchTargets();
  closeRemoteDrawer({ restoreFocus: false });
  setRemoteState('loading');
  elements.remoteFrame.src = targetUrl;
  if (pushHistory) window.history.pushState({ screen: 'remote' }, '', '#connected');
}

function showConnections({ serverUrl, message = '', focusToken = false } = {}) {
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

async function navigateToServer(serverInput, tokenInput = '') {
  const connection = buildRemoteConnection(serverInput, tokenInput);
  requireAccessToken(connection);
  elements.connectButton.disabled = true;
  elements.connectButton.classList.add('is-loading');
  const validationPromise = validateSavedToken(connection);
  elements.serverUrl.value = connection.serverUrl;
  elements.accessToken.value = '';
  showRemote(connection.serverUrl, connection.targetUrl);

  const validation = await validationPromise;
  const isCurrentConnection = remoteSession?.serverUrl === connection.serverUrl
    && remoteSession?.targetUrl === connection.targetUrl;
  if (validation === 'invalid') {
    forgetRejectedToken(connection);
    renderRecentServers();
    if (!isCurrentConnection) return false;
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
    return false;
  }
  if (validation === 'valid' && isCurrentConnection) {
    const persisted = rememberConnection(connection);
    renderRecentServers();
    if (!persisted && remoteSession) {
      remoteSession = { ...remoteSession, storageWarning: true };
      renderRemoteState();
    }
  }
  return true;
}

async function switchConnection() {
  const plan = planConnectionSwitch(selectedSwitchTarget, authenticatedTargets);
  if (plan.type === 'none') return;
  if (plan.type === 'connect') {
    const connection = buildRemoteConnection(plan.targetUrl);
    elements.switchConnection.disabled = true;
    elements.remoteNotice.textContent = text('remote.validatingToken');
    const validation = await validateSavedToken(connection);
    if (validation === 'invalid') {
      const persisted = forgetRejectedToken(connection);
      window.history.replaceState(
        { screen: 'launcher' },
        '',
        `${window.location.pathname}${window.location.search}`,
      );
      showConnections({
        serverUrl: plan.serverUrl,
        message: text('error.invalidToken'),
        focusToken: true,
      });
      if (!persisted) setError(text('error.storageUnavailable'));
      renderRecentServers();
      return;
    }
    showRemote(plan.serverUrl, plan.targetUrl, { pushHistory: false });
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

async function exitNativeApp() {
  const invoke = window.__TAURI__?.core?.invoke;
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
  setRemoteState('loading');
  elements.remoteNotice.textContent = text('remote.validatingToken');
  const validation = await validateSavedToken(connection);
  if (validation === 'invalid') {
    const persisted = forgetRejectedToken(connection);
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
  elements.remoteFrame.src = remoteSession.targetUrl;
}

function recentServerRow(serverUrl) {
  const profile = profileForServer(serverUrl);
  const row = document.createElement('li');
  row.className = 'recent-item';

  const details = document.createElement('div');
  details.className = 'recent-details';
  const name = document.createElement('strong');
  name.textContent = new URL(serverUrl).host;
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
    setError('');
    elements.serverUrl.value = serverUrl;
    renderSecurityWarning();
    if (!profile?.token) {
      elements.accessToken.value = '';
      elements.accessToken.focus();
      return;
    }
    try {
      await navigateToServer(serverUrl, profile.token);
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
  removeButton.addEventListener('click', () => {
    connectionProfiles = removeConnectionProfile(connectionProfiles, serverUrl);
    if (!persistConnectionProfiles()) setError(text('error.storageUnavailable'));
    renderRecentServers();
  });

  actions.append(openButton, removeButton);
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
  setError('');
  try {
    await navigateToServer(elements.serverUrl.value, elements.accessToken.value);
  } catch (error) {
    elements.connectButton.disabled = false;
    elements.connectButton.classList.remove('is-loading');
    setError(localizedError(error));
  }
});

elements.serverUrl.addEventListener('input', () => {
  setError('');
  renderSecurityWarning();
});

elements.toggleToken.addEventListener('click', () => {
  const showing = elements.accessToken.type === 'text';
  elements.accessToken.type = showing ? 'password' : 'text';
  renderTokenVisibility();
});

elements.languageButtons.forEach((button) => {
  button.addEventListener('click', () => setLanguage(button.dataset.language));
});

elements.remoteFrame.addEventListener('load', () => {
  if (elements.remoteShell.classList.contains('is-hidden')) return;
  clearRemoteRevealTimer();
  remoteRevealTimer = window.setTimeout(() => setRemoteState('loaded'), REMOTE_REVEAL_DELAY_MS);
});

elements.remoteFrame.addEventListener('error', () => {
  if (!elements.remoteShell.classList.contains('is-hidden')) setRemoteState('failed');
});

elements.refreshRemote.addEventListener('click', () => {
  void reloadRemoteConnection();
});

elements.switchConnection.addEventListener('click', () => {
  void switchConnection();
});
elements.exitApp.addEventListener('click', exitNativeApp);

elements.retryRemote.addEventListener('click', () => {
  void reloadRemoteConnection();
});

elements.remoteMenuToggle.addEventListener('click', openRemoteDrawer);
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

window.history.replaceState({ screen: 'launcher' }, '', `${window.location.pathname}${window.location.search}`);
rebuildAuthenticatedTargets();
if (recentServers[0]) elements.serverUrl.value = recentServers[0];
applyLanguage();
