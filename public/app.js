'use strict';

(() => {
  const state = {
    token: localStorage.getItem('tmux-relay-token') || '',
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
    deletingWindow: false,
    zshSuggestion: null,
    selectedAttachmentFile: null,
    selectedAttachmentUrl: '',
  };

  const TERMINAL_BOTTOM_THRESHOLD = 24;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
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
    deleteWindowButton: document.querySelector('#delete-window-button'),
    newWindowDialog: document.querySelector('#new-window-dialog, #new-pane-dialog'),
    newWindowForm: document.querySelector('#new-window-form, #new-pane-form'),
    newWindowName: document.querySelector('#new-window-name, #new-pane-name'),
    cancelNewWindow: document.querySelector('#cancel-new-window, #cancel-new-pane'),
    createWindowButton: document.querySelector('#create-window-button, #create-pane-button'),
    currentPaneMeta: document.querySelector('#current-pane-meta'),
    terminalOutput: document.querySelector('#terminal-output'),
    terminalWrap: document.querySelector('#terminal-wrap'),
    terminalEmpty: document.querySelector('#terminal-empty'),
    lastUpdated: document.querySelector('#last-updated'),
    messageInput: document.querySelector('#message-input'),
    attachmentInput: document.querySelector('#attachment-input'),
    attachmentPreview: document.querySelector('#attachment-preview'),
    attachmentThumbnail: document.querySelector('#attachment-thumbnail'),
    attachmentFileIcon: document.querySelector('#attachment-file-icon'),
    attachmentName: document.querySelector('#attachment-name'),
    removeAttachment: document.querySelector('#remove-attachment'),
    composerForm: document.querySelector('#composer-form'),
    sendButton: document.querySelector('#send-button'),
    zshCompleteButton: document.querySelector('#zsh-complete-button'),
    connectionStatus: document.querySelector('#connection-status'),
    refreshButton: document.querySelector('#refresh-button'),
    logoutButton: document.querySelector('#logout-button'),
    quickSessionSelect: document.querySelector('#quick-session-select'),
    quickPaneSelect: document.querySelector('#quick-pane-select'),
    toast: document.querySelector('#toast'),
  };

  elements.attachmentPreview.querySelectorAll('.attachment-details span').forEach((node) => node.remove());

  let toastTimer;

  function showToast(message, kind = 'info') {
    elements.toast.textContent = message;
    elements.toast.dataset.kind = kind;
    elements.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 3200);
  }

  function setConnection(label, kind = 'online') {
    const labelNode = elements.connectionStatus.querySelector('span:last-child');
    labelNode.textContent = label;
    elements.connectionStatus.dataset.kind = kind;
  }

  function showAuth(errorMessage = '') {
    elements.authGate.classList.remove('is-hidden');
    elements.appShell.classList.add('is-hidden');
    elements.authError.textContent = errorMessage;
    elements.tokenInput.value = state.token;
    setTimeout(() => elements.tokenInput.focus(), 0);
  }

  function showShell() {
    elements.authGate.classList.add('is-hidden');
    elements.appShell.classList.remove('is-hidden');
  }

  function forgetToken() {
    state.token = '';
    state.sessions = [];
    state.selectedSession = '';
    state.selectedPane = '';
    localStorage.removeItem('tmux-relay-token');
    showAuth();
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body && typeof options.body !== 'string') {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, { ...options, headers });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (response.status === 401) {
      const error = new Error(payload.message || '令牌无效。');
      error.unauthorized = true;
      throw error;
    }
    if (!response.ok) {
      throw new Error(payload.message || `请求失败（${response.status}）`);
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
    const response = await fetch('/api/uploads', {
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
    if (response.status === 401) {
      const error = new Error(payload.message || '令牌无效。');
      error.unauthorized = true;
      throw error;
    }
    if (!response.ok) {
      throw new Error(payload.message || `附件上传失败（${response.status}）`);
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

  function clearSelectedAttachment() {
    if (state.selectedAttachmentUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(state.selectedAttachmentUrl);
    }
    state.selectedAttachmentFile = null;
    state.selectedAttachmentUrl = '';
    elements.attachmentInput.value = '';
    elements.attachmentThumbnail.removeAttribute('src');
    elements.attachmentThumbnail.classList.add('is-hidden');
    elements.attachmentFileIcon.classList.add('is-hidden');
    elements.attachmentName.textContent = '附件';
    elements.attachmentPreview.classList.add('is-hidden');
  }

  function selectAttachment(file) {
    if (!file) return;
    const image = isImageAttachment(file);
    const maxBytes = image ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
    if (file.size > maxBytes) {
      elements.attachmentInput.value = '';
      showToast(image ? '图片不能超过 10 MB。' : '附件不能超过 25 MB。', 'error');
      return;
    }
    if (!isSupportedAttachment(file)) {
      elements.attachmentInput.value = '';
      showToast('支持图片、PDF、TXT/MD/CSV/JSON、Word 和 Excel 等常见文件。', 'error');
      return;
    }
    if (state.selectedAttachmentUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(state.selectedAttachmentUrl);
    }
    state.selectedAttachmentFile = file;
    state.selectedAttachmentUrl = image && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(file)
      : '';
    elements.attachmentThumbnail.classList.toggle('is-hidden', !state.selectedAttachmentUrl);
    elements.attachmentFileIcon.classList.toggle('is-hidden', image);
    if (state.selectedAttachmentUrl) elements.attachmentThumbnail.src = state.selectedAttachmentUrl;
    elements.attachmentName.textContent = file.name || '已选择附件';
    elements.attachmentPreview.classList.remove('is-hidden');
    elements.messageInput.focus();
  }

  function selectedSession() {
    return state.sessions.find((session) => session.name === state.selectedSession) || null;
  }

  function pageScrollElement() {
    return document.scrollingElement || document.documentElement;
  }

  function terminalScrollElement() {
    const isMobileLayout = typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 780px)').matches;
    return isMobileLayout ? pageScrollElement() : elements.terminalWrap;
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
    const canDeleteWindow = Boolean(pane && !pane.dead);
    const completionText = elements.messageInput.value;
    const canComplete = zsh && isCompletableZshText(completionText);
    const suggestionReady = canComplete
      && hasCurrentZshSuggestion(completionText)
      && state.zshSuggestion.phase === 'previewed';
    const suggestionAccepted = canComplete && hasAcceptedZshSuggestion(completionText);
    if (elements.newWindowButton) {
      elements.newWindowButton.disabled = !canCreateWindow || state.creatingWindow || state.deletingWindow;
    }
    if (elements.deleteWindowButton) {
      elements.deleteWindowButton.classList.toggle('is-hidden', !canDeleteWindow);
      elements.deleteWindowButton.disabled = !canDeleteWindow || state.deletingWindow;
    }
    if (elements.createWindowButton) elements.createWindowButton.disabled = state.creatingWindow;
    if (elements.zshCompleteButton) {
      elements.zshCompleteButton.classList.toggle('is-hidden', !zsh);
      elements.zshCompleteButton.disabled = !canComplete || state.sending;
      elements.zshCompleteButton.textContent = suggestionAccepted
        ? '执行 Enter'
        : suggestionReady
          ? '接受 →'
          : '显示补全';
      elements.zshCompleteButton.setAttribute(
        'aria-label',
        suggestionAccepted
          ? '执行已接受的 zsh 命令'
          : suggestionReady
            ? '接受 zsh 补全建议'
            : '显示 zsh 补全建议',
      );
      elements.zshCompleteButton.title = suggestionReady
        ? '发送 Right 接受当前 zsh 补全建议'
        : suggestionAccepted
          ? '发送 Enter 执行当前命令'
          : '先显示 zsh 的灰色补全建议，不会执行命令';
    }
    elements.sendButton.disabled = !pane || state.sending;
    elements.messageInput.placeholder = zsh
      ? '输入命令…（补全后接受，再点击 Enter 执行）'
      : '给当前 pane 发送消息…（Enter 发送，Shift+Enter 换行）';
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
      empty.append(makeElement('strong', '', '没有发现 tmux 会话'), makeElement('span', '', '请确认服务与 tmux 使用的是同一个系统用户。'));
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
      content.append(makeElement('span', 'session-detail', `${session.codexCount} Codex · ${session.paneCount} pane`));
      const marker = makeElement('span', 'session-marker', session.attached ? '在用' : '');
      button.append(icon, content, marker);
      button.addEventListener('click', () => selectSession(session.name));
      elements.sessionList.append(button);
    }
  }

  function renderPanes() {
    const session = selectedSession();
    elements.paneList.replaceChildren();
    if (!session) {
      elements.currentSessionName.textContent = '等待选择';
      elements.sessionMeta.textContent = '—';
      elements.paneCount.textContent = '0 个 pane';
      elements.paneList.append(makeElement('div', 'pane-empty', '从左侧选择一个 tmux 会话。'));
      return;
    }

    elements.currentSessionName.textContent = session.name;
    elements.sessionMeta.textContent = `${session.attached ? 'attached' : 'detached'} · ${session.windows} 个 window`;
    elements.paneCount.textContent = `${session.paneCount} 个 pane · ${session.codexCount} 个 Codex`;
    if (session.panes.length === 0) {
      elements.paneList.append(makeElement('div', 'pane-empty', '这个会话当前没有可用 pane。'));
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
      const name = makeElement('strong', 'pane-name', pane.pocketmuxName || pane.windowName || `window ${pane.windowIndex}`);
      const stateLabel = makeElement('span', 'pane-state', pane.dead ? '已退出' : pane.busy ? '运行中' : '就绪');
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
      elements.currentPaneMeta.textContent = '未选择 pane';
      elements.terminalEmpty.classList.remove('is-hidden');
      elements.terminalOutput.classList.add('is-empty');
      renderComposerState();
      return;
    }
    const paneName = pane.pocketmuxName || pane.windowName || `window ${pane.windowIndex}`;
    elements.currentPaneMeta.textContent = `${paneName} · ${pane.title || pane.currentCommand || 'tmux pane'} · ${pane.id}`;
    elements.terminalEmpty.classList.toggle('is-hidden', Boolean(state.output));
    elements.terminalOutput.classList.toggle('is-empty', !state.output);
    renderComposerState();
  }

  function renderQuickSwitcher() {
    const sessionSelect = elements.quickSessionSelect;
    const paneSelect = elements.quickPaneSelect;
    if (!sessionSelect || !paneSelect) return;

    sessionSelect.replaceChildren();
    if (state.sessions.length === 0) {
      const option = makeElement('option', '', '暂无会话');
      option.value = '';
      sessionSelect.append(option);
      sessionSelect.disabled = true;
    } else {
      for (const session of state.sessions) {
        const option = makeElement('option', '', session.name);
        option.value = session.name;
        sessionSelect.append(option);
      }
      sessionSelect.disabled = false;
      sessionSelect.value = state.selectedSession;
    }

    paneSelect.replaceChildren();
    const session = selectedSession();
    const panes = session?.panes || [];
    if (panes.length === 0) {
      const option = makeElement('option', '', '暂无 Pane');
      option.value = '';
      paneSelect.append(option);
      paneSelect.disabled = true;
    } else {
      for (const pane of panes) {
        const label = `${pane.pocketmuxName || pane.windowName || `window ${pane.windowIndex}`} · ${pane.id}`;
        const option = makeElement('option', '', label);
        option.value = pane.id;
        paneSelect.append(option);
      }
      paneSelect.disabled = false;
      paneSelect.value = state.selectedPane;
    }
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
      if (!quiet) setConnection('同步中', 'loading');
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
        setConnection('已连接', 'online');
        if (state.selectedPane && (!quiet || selectionChanged)) {
          await loadOutput({ quiet: true, forceScrollBottom: selectionChanged });
        }
      } catch (error) {
        if (error.unauthorized) {
          forgetToken();
        } else {
          setConnection('离线', 'offline');
          if (!quiet) showToast(error.message, 'error');
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
      const shouldScrollToBottom = forceScrollBottom || isTerminalAtBottom();
      state.output = payload.output || '';
      elements.terminalOutput.textContent = state.output;
      renderTerminalMeta();
      elements.lastUpdated.textContent = `更新于 ${new Date(payload.now || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      if (shouldScrollToBottom) scheduleScrollTerminalToBottom();
      setConnection('已连接', 'online');
    } catch (error) {
      if (error.unauthorized) {
        forgetToken();
      } else if (!quiet) {
        setConnection('输出读取失败', 'offline');
        showToast(error.message, 'error');
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
      showToast('请先选择一个可用的 pane。', 'error');
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
      showToast('请先选择一个可用的 pane。', 'error');
      return;
    }
    if (!name) {
      elements.newWindowName.focus();
      showToast('请输入窗口名称。', 'error');
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
      showToast(`zsh 窗口「${payload.name || name}」已创建`, 'success');
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showToast(error.message, 'error');
    } finally {
      state.creatingWindow = false;
      renderComposerState();
      elements.messageInput.focus();
    }
  }

  async function deleteSelectedWindow() {
    if (state.deletingWindow) return;
    const pane = selectedPane();
    if (!pane || pane.dead) return;

    const windowLabel = pane.pocketmuxName || pane.windowName || `window ${pane.windowIndex}`;
    if (typeof window.confirm === 'function'
      && !window.confirm(`确定删除窗口「${windowLabel}」吗？窗口中的进程也会被终止。`)) {
      return;
    }

    state.deletingWindow = true;
    state.zshSuggestion = null;
    renderComposerState();
    try {
      await api(`/api/windows/${encodeURIComponent(pane.id)}`, { method: 'DELETE' });
      state.output = '';
      await refreshSessions({ quiet: true });
      showToast(`窗口「${windowLabel}」已删除`, 'success');
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showToast(error.message, 'error');
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
    if (state.selectedAttachmentFile) {
      showToast('zsh 补全不支持附件，请先移除附件。', 'error');
      return;
    }

    const paneId = state.selectedPane;
    const text = elements.messageInput.value;
    if (!isCompletableZshText(text)) {
      showToast('请输入单行命令片段后再补全。', 'error');
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
        showToast('补全建议已显示，请确认后点击“接受 →”。', 'success');
        if (state.selectedPane === paneId) {
          await loadOutput({ quiet: true, forceScrollBottom: true });
        }
      } else if (suggestion.phase === 'previewed') {
        await api(`/api/panes/${encodeURIComponent(paneId)}/key`, {
          method: 'POST',
          body: { key: 'Right' },
        });
        state.zshSuggestion = { ...suggestion, phase: 'accepted' };
        showToast('zsh 补全已接受，请点击“执行 Enter”运行。', 'success');
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
        showToast('zsh 命令已执行', 'success');
        if (state.selectedPane === paneId) {
          await loadOutput({ quiet: true, forceScrollBottom: true });
        }
      }
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showToast(error.message, 'error');
    } finally {
      state.sending = false;
      renderComposerState();
      elements.messageInput.focus();
    }
  }

  async function sendKey(key) {
    if (!state.selectedPane) {
      showToast('请先选择一个 pane。', 'error');
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
        showToast('zsh 命令已执行', 'success');
      } else {
        showToast(`${key} 已发送`, 'success');
      }
      await loadOutput({ quiet: true });
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showToast(error.message, 'error');
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.sending) return;
    const text = elements.messageInput.value;
    const attachmentFile = state.selectedAttachmentFile;
    if (!state.selectedPane) {
      showToast('请先选择一个 pane。', 'error');
      return;
    }
    const pane = selectedPane();
    const executeAcceptedZsh = !attachmentFile
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
        showToast('zsh 命令已执行', 'success');
        if (state.selectedPane === paneId) {
          await loadOutput({ quiet: true, forceScrollBottom: true });
        }
      } catch (error) {
        if (error.unauthorized) forgetToken();
        else showToast(error.message, 'error');
      } finally {
        state.sending = false;
        renderComposerState();
        elements.messageInput.focus();
      }
      return;
    }
    if (!text && !attachmentFile) return;
    const paneId = state.selectedPane;
    state.zshSuggestion = null;
    state.sending = true;
    renderComposerState();
    try {
      let attachmentId;
      if (attachmentFile) {
        showToast('附件上传中…');
        const upload = await uploadAttachment(attachmentFile);
        attachmentId = upload.attachmentId;
      }
      await api(`/api/panes/${encodeURIComponent(paneId)}/input`, {
        method: 'POST',
        body: { text, submit: true, ...(attachmentId ? { attachmentId } : {}) },
      });
      elements.messageInput.value = '';
      elements.messageInput.style.height = 'auto';
      clearSelectedAttachment();
      showToast('消息已发送', 'success');
      if (state.selectedPane === paneId) await loadOutput({ quiet: true });
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showToast(error.message, 'error');
    } finally {
      state.sending = false;
      renderComposerState();
      elements.messageInput.focus();
    }
  }

  async function unlock(token) {
    state.token = token.trim();
    if (!state.token) return;
    elements.authError.textContent = '';
    try {
      await api('/api/health');
      localStorage.setItem('tmux-relay-token', state.token);
      showShell();
      await refreshSessions();
    } catch (error) {
      state.token = '';
      if (error.unauthorized) localStorage.removeItem('tmux-relay-token');
      elements.authError.textContent = error.unauthorized ? '令牌无效，请重新粘贴。' : error.message;
    }
  }

  elements.tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    unlock(elements.tokenInput.value);
  });
  elements.refreshButton.addEventListener('click', () => refreshSessions());
  elements.logoutButton.addEventListener('click', forgetToken);
  elements.quickSessionSelect.addEventListener('change', () => {
    if (elements.quickSessionSelect.value) selectSession(elements.quickSessionSelect.value);
  });
  elements.quickPaneSelect.addEventListener('change', () => {
    if (elements.quickPaneSelect.value) selectPane(elements.quickPaneSelect.value);
  });
  elements.newWindowButton?.addEventListener('click', openNewWindowDialog);
  elements.deleteWindowButton?.addEventListener('click', deleteSelectedWindow);
  elements.cancelNewWindow?.addEventListener('click', closeNewWindowDialog);
  elements.newWindowForm?.addEventListener('submit', createNewWindow);
  elements.attachmentInput.addEventListener('change', () => selectAttachment(elements.attachmentInput.files?.[0]));
  elements.removeAttachment.addEventListener('click', clearSelectedAttachment);
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
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 140)}px`;
    renderComposerState();
  });
  document.querySelectorAll('[data-key]').forEach((button) => {
    button.addEventListener('click', () => sendKey(button.dataset.key));
  });

  const queryToken = new URLSearchParams(window.location.search).get('token');
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
