'use strict';

(() => {
  const bootstrapParams = new URLSearchParams(window.location.search);
  const queryToken = bootstrapParams.get('token');
  const nativeBootstrap = bootstrapParams.get('native') === '1';
  const {
    LANGUAGE_STORAGE_KEY,
    htmlLanguage,
    normalizeLanguage,
    translate,
  } = window.PocketmuxI18n;
  const {
    createAttachmentSelection,
    findPaneById,
    resolveAppUrl,
    resolveAttachmentUploads,
    shouldAutoScrollTerminal,
  } = window.PocketmuxAppHelpers;
  const state = {
    token: nativeBootstrap ? '' : (localStorage.getItem('tmux-relay-token') || ''),
    language: normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY)),
    sessions: [],
    selectedSession: '',
    selectedPane: '',
    output: '',
    polling: false,
    outputRefreshQueued: false,
    outputRefreshForceBottom: false,
    refreshing: false,
    refreshPromise: null,
    sending: false,
    creatingWindow: false,
    renamingWindow: false,
    renameTargetPaneId: '',
    deletingWindow: false,
    zshSuggestion: null,
    selectedAttachments: [],
    quickSwitchKind: '',
    connectionKey: 'connection.connecting',
    connectionKind: 'loading',
    lastUpdatedAt: 0,
    authErrorKey: '',
    authErrorMessages: null,
    toastDescriptor: null,
  };

  const TERMINAL_BOTTOM_THRESHOLD = 24;
  const MESSAGE_INPUT_MAX_HEIGHT = 140;
  const NATIVE_LANGUAGE_MESSAGE_TYPE = 'pocketmux:language';
  const NATIVE_AUTH_REQUIRED_MESSAGE_TYPE = 'pocketmux:authentication-required';
  const MESSAGE_INPUT_VIEWPORT_MARGIN = 12;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  const MAX_ATTACHMENTS_PER_MESSAGE = 10;
  const MAX_COMBINED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
  const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const ATTACHMENT_CONTENT_TYPES = new Set([
    ...IMAGE_CONTENT_TYPES,
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/xml',
    'text/xml',
    'text/yaml',
    'application/x-yaml',
    'text/rtf',
    'application/rtf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
  ]);
  const ATTACHMENT_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'markdown', 'csv', 'json',
    'xml', 'yaml', 'yml', 'rtf', 'log', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  ]);

  const elements = {
    authGate: document.querySelector('#auth-gate'),
    appShell: document.querySelector('#app-shell'),
    tokenForm: document.querySelector('#token-form'),
    tokenInput: document.querySelector('#token-input'),
    authError: document.querySelector('#auth-error'),
    sessionList: document.querySelector('#session-list'),
    sessionCount: document.querySelector('#session-count'),
    currentSessionName: document.querySelector('#current-session-name'),
    sessionMeta: document.querySelector('#session-meta'),
    paneList: document.querySelector('#pane-list'),
    paneCount: document.querySelector('#pane-count'),
    newWindowButton: document.querySelector('#new-window-button, #new-pane-button'),
    renameWindowButton: document.querySelector('#rename-window-button'),
    deleteWindowButton: document.querySelector('#delete-window-button'),
    newWindowDialog: document.querySelector('#new-window-dialog, #new-pane-dialog'),
    newWindowForm: document.querySelector('#new-window-form, #new-pane-form'),
    newWindowName: document.querySelector('#new-window-name, #new-pane-name'),
    cancelNewWindow: document.querySelector('#cancel-new-window, #cancel-new-pane'),
    createWindowButton: document.querySelector('#create-window-button, #create-pane-button'),
    renameWindowDialog: document.querySelector('#rename-window-dialog'),
    renameWindowForm: document.querySelector('#rename-window-form'),
    renameWindowName: document.querySelector('#rename-window-name'),
    cancelRenameWindow: document.querySelector('#cancel-rename-window'),
    saveWindowNameButton: document.querySelector('#save-window-name-button'),
    currentPaneMeta: document.querySelector('#current-pane-meta'),
    terminalOutput: document.querySelector('#terminal-output'),
    terminalWrap: document.querySelector('#terminal-wrap'),
    terminalEmpty: document.querySelector('#terminal-empty'),
    lastUpdated: document.querySelector('#last-updated'),
    messageInput: document.querySelector('#message-input'),
    attachButton: document.querySelector('#attach-button'),
    attachmentInput: document.querySelector('#attachment-input'),
    attachmentList: document.querySelector('#attachment-list'),
    attachmentCount: document.querySelector('#attachment-count'),
    composerForm: document.querySelector('#composer-form'),
    sendButton: document.querySelector('#send-button'),
    zshCompleteButton: document.querySelector('#zsh-complete-button'),
    connectionStatus: document.querySelector('#connection-status'),
    refreshButton: document.querySelector('#refresh-button'),
    logoutButton: document.querySelector('#logout-button'),
    quickSessionButton: document.querySelector('#quick-session-button'),
    quickSessionValue: document.querySelector('#quick-session-value'),
    quickPaneButton: document.querySelector('#quick-pane-button'),
    quickPaneValue: document.querySelector('#quick-pane-value'),
    quickSwitchDialog: document.querySelector('#quick-switch-dialog'),
    quickSwitchHeading: document.querySelector('#quick-switch-heading'),
    quickSwitchOptions: document.querySelector('#quick-switch-options'),
    closeQuickSwitch: document.querySelector('#close-quick-switch'),
    toast: document.querySelector('#toast'),
    languageButtons: [...document.querySelectorAll('[data-language]')],
  };

  let toastTimer;
  let nextAttachmentClientId = 1;
  let messageInputVisibilityFrame = 0;
  let messageInputVisibilityTimer = 0;

  function t(key, values) {
    return translate(state.language, key, values);
  }

  function applyStaticTranslations() {
    document.documentElement.lang = htmlLanguage(state.language);
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
      node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
    });
    document.querySelectorAll('[data-i18n-content]').forEach((node) => {
      node.setAttribute('content', t(node.dataset.i18nContent));
    });
    for (const button of elements.languageButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.language === state.language));
    }
  }

  function renderConnection() {
    const labelNode = elements.connectionStatus.querySelector('span:last-child');
    labelNode.textContent = t(state.connectionKey);
    elements.connectionStatus.dataset.kind = state.connectionKind;
  }

  function renderLastUpdated() {
    if (!state.lastUpdatedAt) {
      elements.lastUpdated.textContent = '—';
      return;
    }
    const locale = state.language === 'en' ? 'en' : 'zh-CN';
    const time = new Date(state.lastUpdatedAt).toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    elements.lastUpdated.textContent = t('terminal.updatedAt', { time });
  }

  function applyLanguage() {
    applyStaticTranslations();
    renderConnection();
    renderLastUpdated();
    renderAuthError();
    renderAll();
    renderSelectedAttachments();
    renderQuickSwitchHeading();
    renderToast();
    publishLanguageToNativeShell();
  }

  function publishLanguageToNativeShell() {
    if (window.parent === window) return;
    window.parent.postMessage({
      type: NATIVE_LANGUAGE_MESSAGE_TYPE,
      language: state.language,
    }, '*');
  }

  function publishAuthenticationRequiredToNativeShell() {
    if (!nativeBootstrap || window.parent === window) return;
    window.parent.postMessage({
      type: NATIVE_AUTH_REQUIRED_MESSAGE_TYPE,
    }, '*');
  }

  function setLanguage(language) {
    const nextLanguage = normalizeLanguage(language);
    if (nextLanguage === state.language) return;
    state.language = nextLanguage;
    localStorage.setItem(LANGUAGE_STORAGE_KEY, state.language);
    applyLanguage();
  }

  function renderToast() {
    const descriptor = state.toastDescriptor;
    if (!descriptor) return;
    if (descriptor.key) {
      elements.toast.textContent = t(descriptor.key, descriptor.values);
    } else if (descriptor.messages) {
      elements.toast.textContent = descriptor.messages[state.language] || descriptor.messages.zh || '';
    } else {
      elements.toast.textContent = descriptor.message || '';
    }
  }

  function activateToast(descriptor, kind = 'info') {
    state.toastDescriptor = descriptor;
    renderToast();
    elements.toast.dataset.kind = kind;
    elements.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      elements.toast.classList.remove('visible');
      state.toastDescriptor = null;
    }, 3200);
  }

  function showToast(message, kind = 'info') {
    activateToast({ message }, kind);
  }

  function showTranslatedToast(key, kind = 'info', values = {}) {
    activateToast({ key, values }, kind);
  }

  function showErrorToast(error) {
    if (error.localizedMessages) activateToast({ messages: error.localizedMessages }, 'error');
    else showToast(error.message, 'error');
  }

  function responseError(payload, status, fallbackKey) {
    const localizedMessages = {
      zh: payload.message || translate('zh', fallbackKey, { status }),
      en: payload.messageEn || translate('en', fallbackKey, { status }),
    };
    const error = new Error(localizedMessages[state.language]);
    error.localizedMessages = localizedMessages;
    error.status = status;
    return error;
  }

  function setConnection(key, kind = 'online') {
    state.connectionKey = key;
    state.connectionKind = kind;
    renderConnection();
  }

  function renderAuthError() {
    elements.authError.textContent = state.authErrorKey
      ? t(state.authErrorKey)
      : state.authErrorMessages?.[state.language] || '';
  }

  function showAuth() {
    elements.authGate.classList.remove('is-hidden');
    elements.appShell.classList.add('is-hidden');
    renderAuthError();
    elements.tokenInput.value = state.token;
    setTimeout(() => elements.tokenInput.focus(), 0);
  }

  function showShell() {
    elements.authGate.classList.add('is-hidden');
    elements.appShell.classList.remove('is-hidden');
  }

  function forgetToken() {
    clearSelectedAttachments();
    state.token = '';
    state.sessions = [];
    state.selectedSession = '';
    state.selectedPane = '';
    state.authErrorKey = '';
    state.authErrorMessages = null;
    if (!nativeBootstrap) localStorage.removeItem('tmux-relay-token');
    publishAuthenticationRequiredToNativeShell();
    showAuth();
  }

  function isPocketmuxApiResponse(response) {
    return response.headers.get('X-Pocketmux-Product') === 'pocketmux'
      && response.headers.get('X-Pocketmux-Protocol-Version') === '1';
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body && typeof options.body !== 'string') {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(resolveAppUrl(path, window.location.href), { ...options, headers });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (response.status === 401 && isPocketmuxApiResponse(response)) {
      const error = responseError(payload, response.status, 'error.invalidToken');
      error.unauthorized = true;
      throw error;
    }
    if (!response.ok) {
      throw responseError(payload, response.status, 'error.requestFailed');
    }
    return payload;
  }

  async function uploadAttachment(file) {
    const contentType = attachmentContentType(file);
    const headers = new Headers({
      Authorization: `Bearer ${state.token}`,
      'Content-Type': contentType || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'attachment'),
    });
    const response = await fetch(resolveAppUrl('/api/uploads', window.location.href), {
      method: 'POST',
      headers,
      body: file,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (response.status === 401 && isPocketmuxApiResponse(response)) {
      const error = responseError(payload, response.status, 'error.invalidToken');
      error.unauthorized = true;
      throw error;
    }
    if (!response.ok) {
      throw responseError(payload, response.status, 'error.uploadFailed');
    }
    return payload;
  }

  function fileExtension(file) {
    return String(file.name || '').toLowerCase().split('.').pop();
  }

  function attachmentContentType(file) {
    const declaredType = String(file.type || '').toLowerCase();
    if (IMAGE_CONTENT_TYPES.has(declaredType)) return declaredType;
    if (declaredType === 'image/jpg') return 'image/jpeg';
    if (ATTACHMENT_CONTENT_TYPES.has(declaredType)) return declaredType;
    const extension = fileExtension(file);
    return {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      markdown: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      xml: 'application/xml',
      yaml: 'text/yaml',
      yml: 'text/yaml',
      rtf: 'application/rtf',
      log: 'text/plain',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[extension] || '';
  }

  function isImageAttachment(file) {
    const declaredType = String(file.type || '').toLowerCase();
    if (IMAGE_CONTENT_TYPES.has(declaredType) || declaredType === 'image/jpg') return true;
    if (declaredType && declaredType !== 'application/octet-stream') return false;
    return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(fileExtension(file));
  }

  function isSupportedAttachment(file) {
    return Boolean(
      ATTACHMENT_EXTENSIONS.has(fileExtension(file))
      || ATTACHMENT_CONTENT_TYPES.has(attachmentContentType(file)),
    );
  }

  function revokeAttachmentUrl(attachment) {
    if (attachment.url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(attachment.url);
    }
  }

  function renderSelectedAttachments() {
    elements.attachmentList.replaceChildren();
    for (const attachment of state.selectedAttachments) {
      const row = makeElement('div', 'attachment-preview');
      const visual = makeElement('div', 'attachment-visual');
      if (attachment.url) {
        const image = makeElement('img', 'attachment-thumbnail');
        image.src = attachment.url;
        image.alt = t('attachment.imagePreview', {
          name: attachment.file.name || t('attachment.imageFallback'),
        });
        visual.append(image);
      } else {
        const icon = makeElement('span', 'attachment-file-icon', fileExtension(attachment.file).toUpperCase().slice(0, 4) || 'FILE');
        icon.setAttribute('aria-hidden', 'true');
        visual.append(icon);
      }

      const details = makeElement('div', 'attachment-details');
      details.append(makeElement('strong', '', attachment.file.name || t('attachment.selectedFallback')));
      const removeButton = makeElement('button', 'remove-attachment', '×');
      removeButton.type = 'button';
      removeButton.disabled = state.sending;
      removeButton.setAttribute('aria-label', t('attachment.removeAria', { name: attachment.file.name || '' }).trim());
      removeButton.title = t('attachment.removeTitle');
      removeButton.addEventListener('click', () => removeSelectedAttachment(attachment.clientId));
      row.append(visual, details, removeButton);
      elements.attachmentList.append(row);
    }

    const count = state.selectedAttachments.length;
    elements.attachmentList.classList.toggle('is-hidden', count === 0);
    elements.attachmentCount.textContent = String(count);
    elements.attachmentCount.classList.toggle('is-hidden', count === 0);
  }

  function clearSelectedAttachments() {
    state.selectedAttachments.forEach(revokeAttachmentUrl);
    state.selectedAttachments = [];
    elements.attachmentInput.value = '';
    renderSelectedAttachments();
  }

  function removeSelectedAttachment(clientId) {
    const attachment = state.selectedAttachments.find((item) => item.clientId === clientId);
    if (!attachment) return;
    revokeAttachmentUrl(attachment);
    state.selectedAttachments = state.selectedAttachments.filter((item) => item.clientId !== clientId);
    renderSelectedAttachments();
    elements.messageInput.focus();
  }

  function selectAttachments(fileList) {
    const files = [...(fileList || [])];
    elements.attachmentInput.value = '';
    if (files.length === 0) return;

    const additions = [];
    const rejected = [];
    let combinedBytes = state.selectedAttachments.reduce((total, attachment) => total + attachment.file.size, 0);

    for (const file of files) {
      if (state.selectedAttachments.length + additions.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        rejected.push({ key: 'attachment.tooMany', values: { count: MAX_ATTACHMENTS_PER_MESSAGE } });
        continue;
      }

      const image = isImageAttachment(file);
      const maxBytes = image ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
      if (file.size > maxBytes) {
        rejected.push({ key: image ? 'attachment.imageTooLarge' : 'attachment.fileTooLarge' });
        continue;
      }
      if (!isSupportedAttachment(file)) {
        rejected.push({ key: 'attachment.unsupported' });
        continue;
      }
      if (combinedBytes + file.size > MAX_COMBINED_ATTACHMENT_BYTES) {
        rejected.push({ key: 'attachment.totalTooLarge' });
        continue;
      }

      const url = image && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : '';
      additions.push(createAttachmentSelection(file, nextAttachmentClientId, url));
      nextAttachmentClientId += 1;
      combinedBytes += file.size;
    }

    state.selectedAttachments.push(...additions);
    renderSelectedAttachments();
    if (rejected.length > 0) {
      showTranslatedToast(rejected[0].key, 'error', rejected[0].values);
    } else if (additions.length > 0) {
      showTranslatedToast('attachment.added', 'success', { count: additions.length });
    }
    elements.messageInput.focus();
  }

  function selectedSession() {
    return state.sessions.find((session) => session.name === state.selectedSession) || null;
  }

  function pageScrollElement() {
    return document.scrollingElement || document.documentElement;
  }

  function isMobileLayout() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 780px)').matches;
  }

  function isMessageInputFocused() {
    return document.activeElement === elements.messageInput;
  }

  function clearMessageInputViewport() {
    document.body.classList.remove('message-input-active');
    document.documentElement.style.setProperty('--keyboard-inset', '0px');
  }

  function visibleViewportBounds() {
    const viewport = window.visualViewport;
    if (!viewport) return { top: 0, bottom: window.innerHeight };
    return {
      top: viewport.offsetTop,
      bottom: viewport.offsetTop + viewport.height,
    };
  }

  function syncMessageInputViewport() {
    if (!isMobileLayout() || !isMessageInputFocused()) {
      clearMessageInputViewport();
      return;
    }

    const viewport = window.visualViewport;
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const keyboardInset = Math.max(0, layoutHeight - visibleBottom);
    document.documentElement.style.setProperty('--keyboard-inset', `${Math.ceil(keyboardInset)}px`);
    document.body.classList.add('message-input-active');
  }

  function keepMessageInputVisible() {
    if (!isMobileLayout() || !isMessageInputFocused()) return;
    syncMessageInputViewport();

    const input = elements.messageInput;
    if (input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
      input.scrollTop = input.scrollHeight;
    }

    const bounds = visibleViewportBounds();
    const rect = input.getBoundingClientRect();
    const bottomOverlap = rect.bottom + MESSAGE_INPUT_VIEWPORT_MARGIN - bounds.bottom;
    const topOverlap = bounds.top + MESSAGE_INPUT_VIEWPORT_MARGIN - rect.top;
    if (bottomOverlap > 0) {
      window.scrollBy(0, Math.ceil(bottomOverlap));
    } else if (topOverlap > 0) {
      window.scrollBy(0, -Math.ceil(topOverlap));
    }
  }

  function scheduleMessageInputVisibility() {
    if (!isMessageInputFocused()) return;
    const requestFrame = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback) => window.setTimeout(callback, 0);
    const cancelFrame = typeof window.cancelAnimationFrame === 'function'
      ? window.cancelAnimationFrame.bind(window)
      : window.clearTimeout.bind(window);

    if (messageInputVisibilityFrame) cancelFrame(messageInputVisibilityFrame);
    messageInputVisibilityFrame = requestFrame(() => {
      messageInputVisibilityFrame = 0;
      keepMessageInputVisible();
    });
    window.clearTimeout(messageInputVisibilityTimer);
    messageInputVisibilityTimer = window.setTimeout(keepMessageInputVisible, 260);
  }

  function terminalScrollElement() {
    return isMobileLayout() ? pageScrollElement() : elements.terminalWrap;
  }

  function isTerminalAtBottom() {
    const scrollElement = terminalScrollElement();
    const distanceFromBottom = scrollElement.scrollHeight
      - scrollElement.scrollTop
      - scrollElement.clientHeight;
    return distanceFromBottom <= TERMINAL_BOTTOM_THRESHOLD;
  }

  function scrollTerminalToBottom() {
    const scrollElement = terminalScrollElement();
    scrollElement.scrollTop = scrollElement.scrollHeight;
  }

  function scheduleScrollTerminalToBottom() {
    scrollTerminalToBottom();
    const schedule = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback) => window.setTimeout(callback, 0);
    schedule(() => {
      scrollTerminalToBottom();
      schedule(scrollTerminalToBottom);
    });
  }

  function selectedPane() {
    return selectedSession()?.panes.find((pane) => pane.id === state.selectedPane) || null;
  }

  function isZshPane(pane) {
    return Boolean(
      pane
      && !pane.dead
      && !pane.codex
      && String(pane.currentCommand || '').trim().toLowerCase() === 'zsh',
    );
  }

  function isCompletableZshText(text) {
    return Boolean(
      text.trim()
      && !/[\u0000-\u001f\u007f]/u.test(text),
    );
  }

  function hasCurrentZshSuggestion(text) {
    return Boolean(
      state.zshSuggestion
      && state.zshSuggestion.paneId === state.selectedPane
      && state.zshSuggestion.text === text,
    );
  }

  function hasAcceptedZshSuggestion(text) {
    return Boolean(
      hasCurrentZshSuggestion(text)
      && state.zshSuggestion.phase === 'accepted',
    );
  }

  function renderComposerState() {
    const pane = selectedPane();
    const zsh = isZshPane(pane);
    const canCreateWindow = Boolean(pane && !pane.dead);
    const canRenameWindow = Boolean(pane);
    const canDeleteWindow = Boolean(pane && !pane.dead);
    const windowActionBusy = state.creatingWindow || state.renamingWindow || state.deletingWindow;
    const completionText = elements.messageInput.value;
    const canComplete = zsh && isCompletableZshText(completionText);
    const suggestionReady = canComplete
      && hasCurrentZshSuggestion(completionText)
      && state.zshSuggestion.phase === 'previewed';
    const suggestionAccepted = canComplete && hasAcceptedZshSuggestion(completionText);
    if (elements.newWindowButton) {
      elements.newWindowButton.disabled = !canCreateWindow || windowActionBusy;
    }
    if (elements.renameWindowButton) {
      elements.renameWindowButton.classList.toggle('is-hidden', !canRenameWindow);
      elements.renameWindowButton.disabled = !canRenameWindow || windowActionBusy;
    }
    if (elements.deleteWindowButton) {
      elements.deleteWindowButton.classList.toggle('is-hidden', !canDeleteWindow);
      elements.deleteWindowButton.disabled = !canDeleteWindow || windowActionBusy;
    }
    if (elements.createWindowButton) elements.createWindowButton.disabled = windowActionBusy;
    if (elements.saveWindowNameButton) elements.saveWindowNameButton.disabled = windowActionBusy;
    if (elements.zshCompleteButton) {
      elements.zshCompleteButton.classList.toggle('is-hidden', !zsh);
      elements.zshCompleteButton.disabled = !canComplete || state.sending;
      elements.zshCompleteButton.textContent = suggestionAccepted
        ? t('zsh.executeEnter')
        : suggestionReady
          ? t('zsh.acceptCompletion')
          : t('zsh.showCompletion');
      elements.zshCompleteButton.setAttribute(
        'aria-label',
        suggestionAccepted
          ? t('zsh.executeAria')
          : suggestionReady
            ? t('zsh.acceptCompletionAria')
            : t('zsh.showCompletionAria'),
      );
      elements.zshCompleteButton.title = suggestionReady
        ? t('zsh.acceptCompletionTitle')
        : suggestionAccepted
          ? t('zsh.executeTitle')
          : t('zsh.showCompletionTitle');
    }
    elements.sendButton.disabled = !pane || state.sending;
    elements.attachmentInput.disabled = state.sending;
    elements.attachButton.classList.toggle('is-disabled', state.sending);
    elements.attachmentList.querySelectorAll('.remove-attachment').forEach((button) => {
      button.disabled = state.sending;
    });
    elements.messageInput.placeholder = zsh
      ? t('composer.zshPlaceholder')
      : t('composer.messagePlaceholder');
  }

  function makeElement(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderSessions() {
    elements.sessionList.replaceChildren();
    elements.sessionCount.textContent = String(state.sessions.length);
    if (state.sessions.length === 0) {
      const empty = makeElement('div', 'list-empty');
      empty.append(
        makeElement('strong', '', t('sessions.emptyTitle')),
        makeElement('span', '', t('sessions.emptyDetail')),
      );
      elements.sessionList.append(empty);
      return;
    }

    for (const session of state.sessions) {
      const button = makeElement('button', 'session-item');
      button.type = 'button';
      button.dataset.session = session.name;
      button.setAttribute('role', 'listitem');
      if (session.name === state.selectedSession) button.classList.add('selected');
      const icon = makeElement('span', 'session-icon', '◌');
      const content = makeElement('span', 'session-item-content');
      content.append(makeElement('strong', 'session-name', session.name));
      content.append(makeElement('span', 'session-detail', t('sessions.detail', {
        codex: session.codexCount,
        panes: session.paneCount,
      })));
      const marker = makeElement('span', 'session-marker', session.attached ? t('sessions.attached') : '');
      button.append(icon, content, marker);
      button.addEventListener('click', () => selectSession(session.name));
      elements.sessionList.append(button);
    }
  }

  function renderPanes() {
    const session = selectedSession();
    elements.paneList.replaceChildren();
    if (!session) {
      elements.currentSessionName.textContent = t('current.waiting');
      elements.sessionMeta.textContent = '—';
      elements.paneCount.textContent = t('panes.zeroCount');
      elements.paneList.append(makeElement('div', 'pane-empty', t('panes.selectSession')));
      return;
    }

    elements.currentSessionName.textContent = session.name;
    elements.sessionMeta.textContent = t('panes.sessionMeta', {
      state: t(session.attached ? 'sessions.stateAttached' : 'sessions.stateDetached'),
      windows: session.windows,
    });
    elements.paneCount.textContent = t('panes.count', {
      panes: session.paneCount,
      codex: session.codexCount,
    });
    if (session.panes.length === 0) {
      elements.paneList.append(makeElement('div', 'pane-empty', t('panes.empty')));
      return;
    }

    for (const pane of session.panes) {
      const button = makeElement('button', 'pane-item');
      button.type = 'button';
      button.dataset.pane = pane.id;
      button.setAttribute('role', 'listitem');
      if (pane.id === state.selectedPane) button.classList.add('selected');
      if (pane.dead) button.classList.add('dead');
      const top = makeElement('span', 'pane-item-top');
      const name = makeElement('strong', 'pane-name', paneDisplayName(pane));
      const stateLabel = makeElement(
        'span',
        'pane-state',
        t(pane.dead ? 'panes.exited' : pane.busy ? 'panes.running' : 'panes.ready'),
      );
      top.append(name, stateLabel);
      const sub = makeElement('span', 'pane-subtitle', pane.title || pane.currentCommand || pane.id);
      button.append(top, sub);
      button.addEventListener('click', () => selectPane(pane.id));
      elements.paneList.append(button);
    }
  }

  function renderTerminalMeta() {
    const pane = selectedPane();
    if (!pane) {
      elements.currentPaneMeta.textContent = t('terminal.noPane');
      elements.terminalEmpty.classList.remove('is-hidden');
      elements.terminalOutput.classList.add('is-empty');
      renderComposerState();
      return;
    }
    const paneName = paneDisplayName(pane);
    elements.currentPaneMeta.textContent = `${paneName} · ${pane.title || pane.currentCommand || t('terminal.paneFallback')} · ${pane.id}`;
    elements.terminalEmpty.classList.toggle('is-hidden', Boolean(state.output));
    elements.terminalOutput.classList.toggle('is-empty', !state.output);
    renderComposerState();
  }

  function quickSwitchItems(kind) {
    if (kind === 'session') {
      return state.sessions.map((session) => ({ value: session.name, label: session.name }));
    }

    return (selectedSession()?.panes || []).map((pane) => ({
      value: pane.id,
      label: paneDisplayName(pane),
    }));
  }

  function paneDisplayName(pane) {
    return pane.pocketmuxName || pane.windowName || t('panes.windowFallback', { index: pane.windowIndex });
  }

  function renderQuickSwitcher() {
    const session = selectedSession();
    const pane = selectedPane();
    const sessionLabel = session?.name || t('switcher.noSession');
    const paneLabel = pane
      ? paneDisplayName(pane)
      : t('switcher.noPane');

    elements.quickSessionValue.textContent = sessionLabel;
    elements.quickPaneValue.textContent = paneLabel;
    elements.quickSessionButton.disabled = state.sessions.length === 0;
    elements.quickPaneButton.disabled = !session || session.panes.length === 0;
    elements.quickSessionButton.setAttribute('aria-label', t('switcher.currentSessionAria', { label: sessionLabel }));
    elements.quickPaneButton.setAttribute('aria-label', t('switcher.currentPaneAria', { label: paneLabel }));
  }

  function renderQuickSwitchHeading() {
    const key = state.quickSwitchKind === 'session'
      ? 'switcher.chooseSession'
      : state.quickSwitchKind === 'pane'
        ? 'switcher.chooseWindow'
        : 'switcher.choose';
    elements.quickSwitchHeading.textContent = t(key);
  }

  function resetQuickSwitcherState() {
    state.quickSwitchKind = '';
    document.body.classList.remove('quick-switch-open');
    elements.quickSessionButton.setAttribute('aria-expanded', 'false');
    elements.quickPaneButton.setAttribute('aria-expanded', 'false');
  }

  function closeQuickSwitcher() {
    const dialog = elements.quickSwitchDialog;
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
      resetQuickSwitcherState();
    }
  }

  function openQuickSwitcher(kind) {
    const dialog = elements.quickSwitchDialog;
    const items = quickSwitchItems(kind);
    if (!dialog || items.length === 0) return;

    const selectedValue = kind === 'session' ? state.selectedSession : state.selectedPane;
    state.quickSwitchKind = kind;
    renderQuickSwitchHeading();
    elements.quickSwitchOptions.replaceChildren();

    let initialOption = null;
    for (const item of items) {
      const selected = item.value === selectedValue;
      const button = makeElement('button', 'quick-switch-option');
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(selected));
      button.append(
        makeElement('span', 'quick-switch-option-label', item.label),
        makeElement('span', 'quick-switch-option-marker', selected ? '✓' : ''),
      );
      button.addEventListener('click', () => {
        closeQuickSwitcher();
        if (kind === 'session') void selectSession(item.value);
        else void selectPane(item.value);
      });
      elements.quickSwitchOptions.append(button);
      if (selected) initialOption = button;
    }

    initialOption ||= elements.quickSwitchOptions.querySelector('.quick-switch-option');
    if (initialOption) initialOption.tabIndex = 0;

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    document.body.classList.add('quick-switch-open');
    elements.quickSessionButton.setAttribute('aria-expanded', String(kind === 'session'));
    elements.quickPaneButton.setAttribute('aria-expanded', String(kind === 'pane'));

    setTimeout(() => {
      initialOption?.scrollIntoView({ block: 'nearest' });
      initialOption?.focus({ preventScroll: true });
    }, 0);
  }

  function moveQuickSwitcherFocus(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = [...elements.quickSwitchOptions.querySelectorAll('.quick-switch-option')];
    if (options.length === 0) return;

    event.preventDefault();
    const currentIndex = options.indexOf(document.activeElement);
    let nextIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = options.length - 1;
    else if (event.key === 'ArrowUp') nextIndex = currentIndex <= 0 ? options.length - 1 : currentIndex - 1;
    else nextIndex = currentIndex < 0 || currentIndex === options.length - 1 ? 0 : currentIndex + 1;

    options.forEach((option, index) => { option.tabIndex = index === nextIndex ? 0 : -1; });
    options[nextIndex].focus();
  }

  function renderAll() {
    renderSessions();
    renderPanes();
    renderQuickSwitcher();
    renderTerminalMeta();
    elements.terminalOutput.textContent = state.output;
  }

  async function refreshSessions({ quiet = false } = {}) {
    if (state.refreshPromise) return state.refreshPromise;
    const refreshPromise = (async () => {
      state.refreshing = true;
      if (!quiet) setConnection('connection.syncing', 'loading');
      try {
        const payload = await api('/api/sessions');
        state.sessions = payload.sessions || [];
        let selectionChanged = false;
        const current = selectedSession();
        if (!current) {
          const nextSession = state.sessions[0]?.name || '';
          selectionChanged = nextSession !== state.selectedSession;
          state.selectedSession = nextSession;
        }
        const nextSession = selectedSession();
        if (!nextSession?.panes.some((pane) => pane.id === state.selectedPane)) {
          const nextPane = nextSession?.panes.find((pane) => pane.codex)?.id || nextSession?.panes[0]?.id || '';
          selectionChanged = selectionChanged || nextPane !== state.selectedPane;
          state.selectedPane = nextPane;
          state.output = '';
        }
        renderAll();
        setConnection('connection.online', 'online');
        if (state.selectedPane && (!quiet || selectionChanged)) {
          await loadOutput({ quiet: true, forceScrollBottom: selectionChanged });
        }
      } catch (error) {
        if (error.unauthorized) {
          forgetToken();
        } else {
          setConnection('connection.offline', 'offline');
          if (!quiet) showErrorToast(error);
        }
      } finally {
        state.refreshing = false;
      }
    })();
    state.refreshPromise = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (state.refreshPromise === refreshPromise) state.refreshPromise = null;
    }
  }

  async function loadOutput({ quiet = false, forceScrollBottom = false } = {}) {
    const paneId = state.selectedPane;
    if (!paneId) return;
    if (state.polling) {
      state.outputRefreshQueued = true;
      state.outputRefreshForceBottom = state.outputRefreshForceBottom || forceScrollBottom;
      return;
    }
    state.polling = true;
    try {
      const payload = await api(`/api/panes/${encodeURIComponent(paneId)}/output?lines=240`);
      if (state.selectedPane !== paneId) return;
      const shouldScrollToBottom = shouldAutoScrollTerminal({
        forceScrollBottom,
        mobileLayout: isMobileLayout(),
        inputFocused: isMessageInputFocused(),
        atBottom: isTerminalAtBottom(),
      });
      state.output = payload.output || '';
      elements.terminalOutput.textContent = state.output;
      renderTerminalMeta();
      state.lastUpdatedAt = payload.now || Date.now();
      renderLastUpdated();
      if (shouldScrollToBottom) scheduleScrollTerminalToBottom();
      setConnection('connection.online', 'online');
    } catch (error) {
      if (error.unauthorized) {
        forgetToken();
      } else if (!quiet) {
        setConnection('connection.outputFailed', 'offline');
        showErrorToast(error);
      }
    } finally {
      state.polling = false;
      const refreshQueued = state.outputRefreshQueued && Boolean(state.selectedPane);
      const forceQueuedRefreshToBottom = state.outputRefreshForceBottom;
      state.outputRefreshQueued = false;
      state.outputRefreshForceBottom = false;
      if (refreshQueued) {
        void loadOutput({ quiet: true, forceScrollBottom: forceQueuedRefreshToBottom });
      }
    }
  }

  async function selectSession(name) {
    state.selectedSession = name;
    const session = selectedSession();
    state.selectedPane = session?.panes.find((pane) => pane.codex)?.id || session?.panes[0]?.id || '';
    state.zshSuggestion = null;
    state.output = '';
    renderAll();
    await loadOutput({ forceScrollBottom: true });
  }

  async function selectPane(id) {
    state.selectedPane = id;
    state.zshSuggestion = null;
    state.output = '';
    renderAll();
    await loadOutput({ forceScrollBottom: true });
  }

  function openNewWindowDialog() {
    const pane = selectedPane();
    if (!pane || pane.dead) {
      showTranslatedToast('validation.selectAvailablePane', 'error');
      return;
    }
    if (!elements.newWindowDialog || !elements.newWindowName) return;
    elements.newWindowName.value = 'zsh';
    if (typeof elements.newWindowDialog.showModal === 'function') {
      elements.newWindowDialog.showModal();
    } else {
      elements.newWindowDialog.setAttribute('open', '');
    }
    setTimeout(() => elements.newWindowName.focus(), 0);
  }

  function closeNewWindowDialog() {
    if (typeof elements.newWindowDialog.close === 'function' && elements.newWindowDialog.open) {
      elements.newWindowDialog.close();
    } else {
      elements.newWindowDialog.removeAttribute('open');
    }
  }

  async function createNewWindow(event) {
    event.preventDefault();
    if (state.creatingWindow) return;
    const target = selectedPane();
    const name = elements.newWindowName.value.trim();
    if (!target || target.dead) {
      closeNewWindowDialog();
      showTranslatedToast('validation.selectAvailablePane', 'error');
      return;
    }
    if (!name) {
      elements.newWindowName.focus();
      showTranslatedToast('validation.windowName', 'error');
      return;
    }

    state.creatingWindow = true;
    renderComposerState();
    try {
      const payload = await api('/api/windows', {
        method: 'POST',
        body: { paneId: target.id, name },
      });
      await refreshSessions({ quiet: true });
      state.selectedSession = payload.sessionName || target.sessionName;
      state.selectedPane = payload.paneId;
      state.output = '';
      closeNewWindowDialog();
      renderAll();
      await loadOutput({ quiet: true, forceScrollBottom: true });
      showTranslatedToast('window.created', 'success', { name: payload.name || name });
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showErrorToast(error);
    } finally {
      state.creatingWindow = false;
      renderComposerState();
      elements.messageInput.focus();
    }
  }

  function openRenameWindowDialog() {
    const pane = selectedPane();
    if (!pane) {
      showTranslatedToast('validation.selectPane', 'error');
      return;
    }
    state.renameTargetPaneId = pane.id;
    const currentName = paneDisplayName(pane);
    elements.renameWindowName.value = currentName;
    if (typeof elements.renameWindowDialog.showModal === 'function') {
      elements.renameWindowDialog.showModal();
    } else {
      elements.renameWindowDialog.setAttribute('open', '');
    }
    setTimeout(() => {
      elements.renameWindowName.focus();
      elements.renameWindowName.select();
    }, 0);
  }

  function closeRenameWindowDialog() {
    state.renameTargetPaneId = '';
    if (typeof elements.renameWindowDialog.close === 'function' && elements.renameWindowDialog.open) {
      elements.renameWindowDialog.close();
    } else {
      elements.renameWindowDialog.removeAttribute('open');
    }
  }

  async function renameSelectedWindow(event) {
    event.preventDefault();
    if (state.renamingWindow) return;
    const pane = findPaneById(state.sessions, state.renameTargetPaneId);
    const name = elements.renameWindowName.value.trim();
    if (!pane) {
      closeRenameWindowDialog();
      showTranslatedToast('window.renameMissing', 'error');
      return;
    }
    if (!name) {
      elements.renameWindowName.focus();
      showTranslatedToast('validation.name', 'error');
      return;
    }

    const previousName = paneDisplayName(pane);
    if (name === previousName) {
      closeRenameWindowDialog();
      return;
    }

    state.renamingWindow = true;
    renderComposerState();
    try {
      const payload = await api(`/api/panes/${encodeURIComponent(pane.id)}`, {
        method: 'PATCH',
        body: { name },
      });
      await refreshSessions({ quiet: true });
      closeRenameWindowDialog();
      showTranslatedToast('window.renamed', 'success', {
        previous: previousName,
        name: payload.name || name,
      });
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showErrorToast(error);
    } finally {
      state.renamingWindow = false;
      renderAll();
      elements.messageInput.focus();
    }
  }

  async function deleteSelectedWindow() {
    if (state.deletingWindow) return;
    const pane = selectedPane();
    if (!pane || pane.dead) return;

    const windowLabel = paneDisplayName(pane);
    if (typeof window.confirm === 'function'
      && !window.confirm(t('window.deleteConfirm', { name: windowLabel }))) {
      return;
    }

    state.deletingWindow = true;
    state.zshSuggestion = null;
    renderComposerState();
    try {
      await api(`/api/windows/${encodeURIComponent(pane.id)}`, { method: 'DELETE' });
      state.output = '';
      await refreshSessions({ quiet: true });
      showTranslatedToast('window.deleted', 'success', { name: windowLabel });
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showErrorToast(error);
    } finally {
      state.deletingWindow = false;
      renderAll();
      elements.messageInput.focus();
    }
  }

  async function completeZsh() {
    if (state.sending) return;
    const pane = selectedPane();
    if (!isZshPane(pane)) return;
    if (state.selectedAttachments.length > 0) {
      showTranslatedToast('zsh.attachmentsUnsupported', 'error');
      return;
    }

    const paneId = state.selectedPane;
    const text = elements.messageInput.value;
    if (!isCompletableZshText(text)) {
      showTranslatedToast('zsh.enterFragment', 'error');
      return;
    }
    state.sending = true;
    renderComposerState();
    const suggestion = hasCurrentZshSuggestion(text) ? state.zshSuggestion : null;
    try {
      if (!suggestion) {
        await api(`/api/panes/${encodeURIComponent(paneId)}/suggest`, {
          method: 'POST',
          body: { text },
        });
        state.zshSuggestion = { paneId, text, phase: 'previewed' };
        showTranslatedToast('zsh.previewed', 'success');
        if (state.selectedPane === paneId) {
          await loadOutput({ quiet: true, forceScrollBottom: true });
        }
      } else if (suggestion.phase === 'previewed') {
        await api(`/api/panes/${encodeURIComponent(paneId)}/key`, {
          method: 'POST',
          body: { key: 'Right' },
        });
        state.zshSuggestion = { ...suggestion, phase: 'accepted' };
        showTranslatedToast('zsh.accepted', 'success');
        if (state.selectedPane === paneId) {
          await loadOutput({ quiet: true, forceScrollBottom: true });
        }
      } else {
        await api(`/api/panes/${encodeURIComponent(paneId)}/key`, {
          method: 'POST',
          body: { key: 'Enter' },
        });
        state.zshSuggestion = null;
        elements.messageInput.value = '';
        elements.messageInput.style.height = 'auto';
        showTranslatedToast('zsh.executed', 'success');
        if (state.selectedPane === paneId) {
          await loadOutput({ quiet: true, forceScrollBottom: true });
        }
      }
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showErrorToast(error);
    } finally {
      state.sending = false;
      renderComposerState();
      elements.messageInput.focus();
    }
  }

  async function sendKey(key) {
    if (!state.selectedPane) {
      showTranslatedToast('validation.selectPane', 'error');
      return;
    }
    const paneId = state.selectedPane;
    const executeAcceptedZsh = key === 'Enter'
      && hasAcceptedZshSuggestion(elements.messageInput.value);
    try {
      await api(`/api/panes/${encodeURIComponent(paneId)}/key`, {
        method: 'POST',
        body: { key },
      });
      state.zshSuggestion = null;
      if (executeAcceptedZsh) {
        elements.messageInput.value = '';
        elements.messageInput.style.height = 'auto';
        showTranslatedToast('zsh.executed', 'success');
      } else {
        showTranslatedToast('key.sent', 'success', { key });
      }
      await loadOutput({ quiet: true });
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showErrorToast(error);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.sending) return;
    const text = elements.messageInput.value;
    const messageAttachments = [...state.selectedAttachments];
    const hasAttachments = messageAttachments.length > 0;
    if (!state.selectedPane) {
      showTranslatedToast('validation.selectPane', 'error');
      return;
    }
    const pane = selectedPane();
    const executeAcceptedZsh = !hasAttachments
      && isZshPane(pane)
      && hasAcceptedZshSuggestion(text);
    if (executeAcceptedZsh) {
      const paneId = state.selectedPane;
      state.sending = true;
      renderComposerState();
      try {
        await api(`/api/panes/${encodeURIComponent(paneId)}/key`, {
          method: 'POST',
          body: { key: 'Enter' },
        });
        state.zshSuggestion = null;
        elements.messageInput.value = '';
        elements.messageInput.style.height = 'auto';
        showTranslatedToast('zsh.executed', 'success');
        if (state.selectedPane === paneId) {
          await loadOutput({ quiet: true, forceScrollBottom: true });
        }
      } catch (error) {
        if (error.unauthorized) forgetToken();
        else showErrorToast(error);
      } finally {
        state.sending = false;
        renderComposerState();
        elements.messageInput.focus();
      }
      return;
    }
    if (!text && !hasAttachments) return;
    const paneId = state.selectedPane;
    state.zshSuggestion = null;
    state.sending = true;
    renderComposerState();
    try {
      let attachmentIds = [];
      if (hasAttachments) {
        showTranslatedToast('attachment.uploading', 'info', { count: messageAttachments.length });
        const uploads = await resolveAttachmentUploads(messageAttachments, uploadAttachment);
        attachmentIds = uploads.map((upload) => upload.attachmentId);
      }
      await api(`/api/panes/${encodeURIComponent(paneId)}/input`, {
        method: 'POST',
        body: { text, submit: true, ...(attachmentIds.length > 0 ? { attachmentIds } : {}) },
      });
      elements.messageInput.value = '';
      elements.messageInput.style.height = 'auto';
      clearSelectedAttachments();
      showTranslatedToast('message.sent', 'success');
      if (state.selectedPane === paneId) await loadOutput({ quiet: true });
    } catch (error) {
      if (error.status === 404) {
        messageAttachments.forEach((attachment) => { attachment.upload = null; });
      }
      if (error.unauthorized) forgetToken();
      else showErrorToast(error);
    } finally {
      state.sending = false;
      renderComposerState();
      elements.messageInput.focus();
    }
  }

  async function unlock(token) {
    state.token = token.trim();
    if (!state.token) return;
    state.authErrorKey = '';
    state.authErrorMessages = null;
    renderAuthError();
    try {
      await api('/api/health');
      if (!nativeBootstrap) localStorage.setItem('tmux-relay-token', state.token);
      showShell();
      await refreshSessions();
    } catch (error) {
      state.token = '';
      if (error.unauthorized && !nativeBootstrap) localStorage.removeItem('tmux-relay-token');
      if (error.unauthorized) publishAuthenticationRequiredToNativeShell();
      state.authErrorKey = error.unauthorized ? 'auth.invalidToken' : '';
      state.authErrorMessages = error.unauthorized
        ? null
        : error.localizedMessages || { zh: error.message, en: error.message };
      renderAuthError();
    }
  }

  elements.tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    unlock(elements.tokenInput.value);
  });
  elements.refreshButton.addEventListener('click', () => refreshSessions());
  elements.logoutButton.addEventListener('click', forgetToken);
  elements.quickSessionButton.addEventListener('click', () => openQuickSwitcher('session'));
  elements.quickPaneButton.addEventListener('click', () => openQuickSwitcher('pane'));
  elements.closeQuickSwitch.addEventListener('click', closeQuickSwitcher);
  elements.quickSwitchDialog.addEventListener('close', resetQuickSwitcherState);
  elements.quickSwitchDialog.addEventListener('click', (event) => {
    if (event.target === elements.quickSwitchDialog) closeQuickSwitcher();
  });
  elements.quickSwitchOptions.addEventListener('keydown', moveQuickSwitcherFocus);
  elements.newWindowButton?.addEventListener('click', openNewWindowDialog);
  elements.renameWindowButton?.addEventListener('click', openRenameWindowDialog);
  elements.deleteWindowButton?.addEventListener('click', deleteSelectedWindow);
  elements.cancelNewWindow?.addEventListener('click', closeNewWindowDialog);
  elements.newWindowForm?.addEventListener('submit', createNewWindow);
  elements.cancelRenameWindow?.addEventListener('click', closeRenameWindowDialog);
  elements.renameWindowForm?.addEventListener('submit', renameSelectedWindow);
  elements.renameWindowDialog?.addEventListener('close', () => { state.renameTargetPaneId = ''; });
  elements.attachmentInput.addEventListener('change', () => selectAttachments(elements.attachmentInput.files));
  elements.zshCompleteButton?.addEventListener('click', completeZsh);
  elements.composerForm.addEventListener('submit', sendMessage);
  elements.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !state.sending) {
      event.preventDefault();
      elements.composerForm.requestSubmit();
    }
  });
  elements.messageInput.addEventListener('input', () => {
    if (!hasCurrentZshSuggestion(elements.messageInput.value)) state.zshSuggestion = null;
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT)}px`;
    renderComposerState();
    scheduleMessageInputVisibility();
  });
  elements.messageInput.addEventListener('focus', scheduleMessageInputVisibility);
  elements.messageInput.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!isMessageInputFocused()) clearMessageInputViewport();
    }, 0);
  });
  window.addEventListener('resize', scheduleMessageInputVisibility);
  window.visualViewport?.addEventListener('resize', scheduleMessageInputVisibility);
  document.querySelectorAll('[data-key]').forEach((button) => {
    button.addEventListener('click', () => sendKey(button.dataset.key));
  });
  elements.languageButtons.forEach((button) => {
    button.addEventListener('click', () => setLanguage(button.dataset.language));
  });

  applyLanguage();
  if (queryToken) {
    window.history.replaceState({}, document.title, window.location.pathname);
    state.token = queryToken;
  }
  if (state.token) {
    unlock(state.token);
  } else {
    showAuth();
  }

  setInterval(() => {
    if (!elements.appShell.classList.contains('is-hidden')) refreshSessions({ quiet: true });
  }, 5000);
  setInterval(() => {
    if (!elements.appShell.classList.contains('is-hidden')) loadOutput({ quiet: true });
  }, 1500);
})();
