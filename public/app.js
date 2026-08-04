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
    sending: false,
  };

  const TERMINAL_BOTTOM_THRESHOLD = 24;

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
    currentPaneMeta: document.querySelector('#current-pane-meta'),
    terminalOutput: document.querySelector('#terminal-output'),
    terminalWrap: document.querySelector('#terminal-wrap'),
    terminalEmpty: document.querySelector('#terminal-empty'),
    lastUpdated: document.querySelector('#last-updated'),
    targetLabel: document.querySelector('#target-label'),
    messageInput: document.querySelector('#message-input'),
    composerForm: document.querySelector('#composer-form'),
    sendButton: document.querySelector('#send-button'),
    connectionStatus: document.querySelector('#connection-status'),
    refreshButton: document.querySelector('#refresh-button'),
    logoutButton: document.querySelector('#logout-button'),
    quickSessionSelect: document.querySelector('#quick-session-select'),
    quickPaneSelect: document.querySelector('#quick-pane-select'),
    toast: document.querySelector('#toast'),
  };

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
      const name = makeElement('strong', 'pane-name', pane.windowName || `window ${pane.windowIndex}`);
      const stateLabel = makeElement('span', 'pane-state', pane.dead ? '已退出' : pane.busy ? '运行中' : '就绪');
      top.append(name, stateLabel);
      const sub = makeElement('span', 'pane-subtitle', pane.title || pane.currentCommand || pane.id);
      const footer = makeElement('span', 'pane-footer', `${pane.id} · ${pane.width}×${pane.height}`);
      button.append(top, sub, footer);
      button.addEventListener('click', () => selectPane(pane.id));
      elements.paneList.append(button);
    }
  }

  function renderTerminalMeta() {
    const pane = selectedPane();
    if (!pane) {
      elements.currentPaneMeta.textContent = '未选择 pane';
      elements.targetLabel.textContent = '—';
      elements.terminalEmpty.classList.remove('is-hidden');
      elements.terminalOutput.classList.add('is-empty');
      return;
    }
    elements.currentPaneMeta.textContent = `${pane.windowName} · ${pane.title || pane.currentCommand || 'tmux pane'} · ${pane.id}`;
    elements.targetLabel.textContent = `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
    elements.terminalEmpty.classList.toggle('is-hidden', Boolean(state.output));
    elements.terminalOutput.classList.toggle('is-empty', !state.output);
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
        const label = `${pane.windowName || `window ${pane.windowIndex}`} · ${pane.id}`;
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
    if (state.refreshing) return;
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
    state.output = '';
    renderAll();
    await loadOutput({ forceScrollBottom: true });
  }

  async function selectPane(id) {
    state.selectedPane = id;
    state.output = '';
    renderAll();
    await loadOutput({ forceScrollBottom: true });
  }

  async function sendKey(key) {
    if (!state.selectedPane) {
      showToast('请先选择一个 pane。', 'error');
      return;
    }
    try {
      await api(`/api/panes/${encodeURIComponent(state.selectedPane)}/key`, {
        method: 'POST',
        body: { key },
      });
      showToast(`${key} 已发送`, 'success');
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
    if (!state.selectedPane) {
      showToast('请先选择一个 pane。', 'error');
      return;
    }
    if (!text) return;
    const paneId = state.selectedPane;
    state.sending = true;
    elements.sendButton.disabled = true;
    try {
      await api(`/api/panes/${encodeURIComponent(paneId)}/input`, {
        method: 'POST',
        body: { text, submit: true },
      });
      elements.messageInput.value = '';
      elements.messageInput.style.height = 'auto';
      showToast('消息已发送', 'success');
      if (state.selectedPane === paneId) await loadOutput({ quiet: true });
    } catch (error) {
      if (error.unauthorized) forgetToken();
      else showToast(error.message, 'error');
    } finally {
      state.sending = false;
      elements.sendButton.disabled = false;
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
  elements.composerForm.addEventListener('submit', sendMessage);
  elements.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !state.sending) {
      event.preventDefault();
      elements.composerForm.requestSubmit();
    }
  });
  elements.messageInput.addEventListener('input', () => {
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 140)}px`;
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
