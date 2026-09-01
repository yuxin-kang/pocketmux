'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const vm = require('node:vm');

const {
  ATTACHMENT_TTL_MS,
  buildSessionTree,
  createRemoteToolServer,
  isAllowedKey,
  PANE_FORMAT,
  parsePaneRows,
  pruneExpiredAttachments,
  readRequestBody,
  removeStaleUploads,
  renamePane,
} = require('../server');

const delimiter = '\t';

function paneRow({ id = '%1', session = 'leo_lab', window = '0', windowName = 'exec', index = '0', command = 'node', title = 'codex | leo_lab', inMode = '0', mode = '', pocketmuxName = '' } = {}) {
  return [id, session, window, windowName, index, command, title, '120', '40', '0', '1', '1234', inMode, mode, pocketmuxName].join(delimiter);
}

function fakeTmux({ pane = {}, otherPanes } = {}) {
  const calls = [];
  const loadedBuffers = [];
  const paneRows = [
    paneRow(pane),
    ...(otherPanes || [{ id: '%2', window: '1', windowName: 'box', title: 'codex | leo_lab' }]).map((otherPane) => paneRow(otherPane)),
  ];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return ['deploy', '5', '1'].join(delimiter) + '\n' + ['leo_lab', '9', '1'].join(delimiter) + '\n';
    if (args[0] === 'list-panes') return `${paneRows.join('\n')}\n`;
    if (args[0] === 'new-window') return '%3\n';
    if (args[0] === 'load-buffer') {
      loadedBuffers.push(await fsp.readFile(args.at(-1), 'utf8'));
    }
    if (args[0] === 'capture-pane') return 'latest codex output';
    return '';
  };
  return { calls, loadedBuffers, runner };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('mobile composer keeps long input visible above the soft keyboard', async () => {
  const [app, i18n, styles, html, manifest] = await Promise.all([
    fsp.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'),
  ]);

  assert.match(app, /window\.visualViewport\?\.addEventListener\('resize', scheduleMessageInputVisibility\)/);
  assert.match(app, /Math\.min\(elements\.messageInput\.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT\)/);
  assert.match(app, /shouldAutoScrollTerminal\(\{/);
  assert.match(styles, /body\.message-input-active \.app-shell \{ padding-bottom: var\(--keyboard-inset\); \}/);
  assert.match(styles, /\.composer-form textarea \{[^}]*overflow-y: auto;/);
  assert.match(html, /i18n\.js\?v=20260829-ios-1/);
  assert.match(html, /app-helpers\.js\?v=20260809-review-fixes/);
  assert.match(html, /app\.js\?v=20260829-ios-1/);
  assert.match(html, /window\.location\.replace\(`\$\{window\.location\.pathname\}\/\$\{window\.location\.search\}\$\{window\.location\.hash\}`\)/);
  assert.match(i18n, /PocketmuxI18n/);
  assert.equal((html.match(/\.\/favicon\.ico\?v=20260812-pocket-terminal/g) || []).length, 2);
  assert.match(html, /sizes="16x16 32x32 48x48 64x64"/);
  assert.equal((html.match(/\.\/assets\/pocketmux-icon-32\.png\?v=20260812-pocket-terminal/g) || []).length, 1);
  assert.equal((html.match(/\.\/assets\/pocketmux-icon-180\.png\?v=20260812-pocket-terminal/g) || []).length, 1);
  assert.equal((html.match(/\.\/assets\/pocketmux-icon\.png\?v=20260812-pocket-terminal/g) || []).length, 2);
  assert.match(styles, /\.brand-mark img \{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain;/);
  assert.doesNotMatch(styles, /\.brand-mark img \{[^}]*16[05]%/);
  assert.match(manifest, /"start_url": "\."/);
  assert.match(manifest, /"src": "\.\/assets\/pocketmux-icon-192\.png"/);
  assert.match(manifest, /"src": "\.\/assets\/pocketmux-icon-512\.png"/);
  assert.match(manifest, /"src": "\.\/assets\/pocketmux-icon-maskable-512\.png"/);
});

test('provides a persistent and accessible Chinese-English language switch', async () => {
  const [app, html, styles] = await Promise.all([
    fsp.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8'),
  ]);

  assert.match(html, /id="language-switch"/);
  assert.match(html, /id="auth-language-switch"/);
  assert.equal((html.match(/data-language="zh"/g) || []).length, 2);
  assert.equal((html.match(/data-language="en"/g) || []).length, 2);
  assert.match(html, /data-i18n-aria-label="language\.label"/);
  assert.match(app, /localStorage\.getItem\(LANGUAGE_STORAGE_KEY\)/);
  assert.match(app, /localStorage\.setItem\(LANGUAGE_STORAGE_KEY, state\.language\)/);
  assert.match(app, /document\.documentElement\.lang = htmlLanguage\(state\.language\)/);
  assert.match(app, /window\.parent\.postMessage\(\{[\s\S]*?type: NATIVE_LANGUAGE_MESSAGE_TYPE,[\s\S]*?language: state\.language/);
  assert.match(app, /payload\.messageEn/);
  assert.match(app, /state\.quickSwitchKind = kind/);
  assert.match(app, /renderQuickSwitchHeading\(\)/);
  assert.match(styles, /\.language-switch \{/);
  assert.match(styles, /\.icon-button \{ width: 35px; height: 35px;/);
  assert.match(styles, /\.language-switch \{[^}]*height: 35px;/);
  assert.match(styles, /\.language-button \{[^}]*min-width: 29px;[^}]*height: 31px;/);
  assert.match(html, /styles\.css\?v=20260829-ios-1/);
});

test('serves the browser helper loaded by the main app', async (t) => {
  const { runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const helper = await fetch(`${base}/app-helpers.js`);
  assert.equal(helper.status, 200);
  assert.match(helper.headers.get('content-type'), /^text\/javascript/);
  assert.match(await helper.text(), /PocketmuxAppHelpers/);

  const i18n = await fetch(`${base}/i18n.js`);
  assert.equal(i18n.status, 200);
  assert.match(i18n.headers.get('content-type'), /^text\/javascript/);
  assert.match(await i18n.text(), /PocketmuxI18n/);

  const icon = await fetch(`${base}/assets/pocketmux-icon.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.ok((await icon.arrayBuffer()).byteLength > 1000);

  for (const asset of [
    'pocketmux-icon-32.png',
    'pocketmux-icon-180.png',
    'pocketmux-icon-192.png',
    'pocketmux-icon-512.png',
    'pocketmux-icon-maskable-512.png',
  ]) {
    const response = await fetch(`${base}/assets/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get('content-type'), 'image/png', asset);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], asset);
  }

  const favicon = await fetch(`${base}/favicon.ico`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get('content-type'), 'image/x-icon');
  const faviconBytes = Buffer.from(await favicon.arrayBuffer());
  assert.equal(Number(favicon.headers.get('content-length')), faviconBytes.byteLength);
  assert.ok(faviconBytes.byteLength > 1000);
  assert.deepEqual([...faviconBytes.subarray(0, 4)], [0, 0, 1, 0]);

});

test('loads static assets and APIs behind a stripping path-prefix proxy', async (t) => {
  const { runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const upstreamBase = await listen(server);
  const upstream = new URL(upstreamBase);
  const prefix = '/tools/pocketmux';
  const proxy = http.createServer((req, res) => {
    const incomingUrl = new URL(req.url || '/', 'http://proxy.local');
    if (incomingUrl.pathname !== prefix && !incomingUrl.pathname.startsWith(`${prefix}/`)) {
      res.writeHead(404).end();
      return;
    }
    const strippedPath = incomingUrl.pathname.slice(prefix.length) || '/';
    const upstreamRequest = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: `${strippedPath}${incomingUrl.search}`,
      headers: { ...req.headers, host: upstream.host },
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstreamRequest.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(error.message);
    });
    req.pipe(upstreamRequest);
  });
  const proxyBase = await listen(proxy);
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => server.close(resolve)),
    ]);
  });

  const noSlashUrl = `${proxyBase}${prefix}?token=test-token`;
  const noSlashResponse = await fetch(noSlashUrl);
  assert.equal(noSlashResponse.status, 200);
  const noSlashHtml = await noSlashResponse.text();
  const canonicalScript = noSlashHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(canonicalScript);
  let canonicalLocation = '';
  const noSlashLocation = new URL(noSlashUrl);
  vm.runInNewContext(canonicalScript, {
    window: {
      location: {
        pathname: noSlashLocation.pathname,
        search: noSlashLocation.search,
        hash: noSlashLocation.hash,
        replace: (location) => { canonicalLocation = location; },
      },
    },
  });
  assert.equal(canonicalLocation, `${prefix}/?token=test-token`);

  const pageUrl = `${proxyBase}${canonicalLocation}`;
  const pageResponse = await fetch(pageUrl);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  const relativeAssets = [...html.matchAll(/(?:href|src)="(\.\/[^"#]+)"/g)]
    .map((match) => match[1]);
  assert.ok(relativeAssets.length >= 8);
  for (const asset of new Set(relativeAssets)) {
    const response = await fetch(new URL(asset, pageUrl));
    assert.equal(response.status, 200, asset);
  }

  const health = await fetch(new URL('./api/health', pageUrl), {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).product, 'pocketmux');
});

test('health endpoint identifies Pocketmux for native connection validation', async (t) => {
  const { runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/health`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    (({ ok, product, protocolVersion }) => ({ ok, product, protocolVersion }))(await response.json()),
    { ok: true, product: 'pocketmux', protocolVersion: 1 },
  );
  assert.equal(response.headers.get('x-pocketmux-product'), 'pocketmux');
  assert.equal(response.headers.get('x-pocketmux-protocol-version'), '1');
});

test('parses tmux pane rows and identifies Codex panes', () => {
  const [codex, shell] = parsePaneRows(`${paneRow()}\n${paneRow({ id: '%2', command: 'zsh', title: 'venus' })}\n`);
  assert.equal(codex.id, '%1');
  assert.equal(codex.codex, true);
  assert.equal(shell.codex, false);
  assert.equal(codex.width, 120);

  const [namedPane] = parsePaneRows(paneRow({ pocketmuxName: 'shell-tools' }));
  assert.equal(namedPane.pocketmuxName, 'shell-tools');

  const [copyModePane] = parsePaneRows(paneRow({ inMode: '1', mode: 'copy-mode' }));
  assert.equal(copyModePane.inMode, true);
  assert.equal(copyModePane.mode, 'copy-mode');
});

test('builds a sorted session tree with pane counts', () => {
  const tree = buildSessionTree(
    [
      { name: 'zeta', windows: 1, attached: 0 },
      { name: 'leo_lab', windows: 9, attached: 1 },
    ],
    parsePaneRows(`${paneRow()}\n${paneRow({ id: '%2', window: '1', windowName: 'box' })}\n`),
  );
  assert.deepEqual(tree.map((session) => session.name), ['leo_lab', 'zeta']);
  assert.equal(tree[0].paneCount, 2);
  assert.equal(tree[0].codexCount, 2);
  assert.equal(tree[0].attached, true);
});

test('only allows the explicit control-key allowlist', () => {
  assert.equal(isAllowedKey('C-c'), true);
  assert.equal(isAllowedKey('Enter'), true);
  assert.equal(isAllowedKey('rm -rf /'), false);
  assert.equal(isAllowedKey('C-x'), false);
});

test('creates a named zsh window after the selected session last window', async (t) => {
  const { calls, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/windows`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ paneId: '%1', name: ' shell-tools ' }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    paneId: '%3',
    sessionName: 'leo_lab',
    name: 'shell-tools',
  });

  assert.deepEqual(calls.at(-2), [
    'new-window',
    '-a',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-c',
    os.homedir(),
    '-n',
    'shell-tools',
    '-t',
    'leo_lab:1',
    'zsh',
  ]);
  assert.deepEqual(calls.at(-1), ['set-option', '-p', '-t', '%3', '@pocketmux_name', 'shell-tools']);

  const callsBeforeInvalidName = calls.length;
  const invalidName = await fetch(`${base}/api/windows`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ paneId: '%1', name: '   ' }),
  });
  assert.equal(invalidName.status, 400);
  assert.equal((await invalidName.json()).messageEn, 'Window name is empty');
  assert.equal(calls.length, callsBeforeInvalidName);

  const legacyRoute = await fetch(`${base}/api/panes`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ paneId: '%1', name: 'legacy-shell' }),
  });
  assert.equal(legacyRoute.status, 201);
  assert.equal((await legacyRoute.json()).name, 'legacy-shell');
  assert.equal(calls.at(-2)[0], 'new-window');
});

test('deletes any live standalone window, including existing non-Pocketmux windows', async (t) => {
  const { calls, runner } = fakeTmux({
    pane: { command: 'zsh', title: 'zsh', pocketmuxName: 'shell-tools' },
  });
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());
  const headers = { Authorization: 'Bearer test-token' };

  const response = await fetch(`${base}/api/windows/%251`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    paneId: '%1',
    sessionName: 'leo_lab',
    windowIndex: 0,
    name: 'shell-tools',
  });
  assert.deepEqual(calls.at(-1), ['kill-window', '-t', 'leo_lab:0']);

  const existingResponse = await fetch(`${base}/api/windows/%252`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(existingResponse.status, 200);
  assert.deepEqual(await existingResponse.json(), {
    ok: true,
    paneId: '%2',
    sessionName: 'leo_lab',
    windowIndex: 1,
    name: 'box',
  });
  assert.deepEqual(calls.at(-1), ['kill-window', '-t', 'leo_lab:1']);
});

test('renames any standalone pane and keeps its tmux window name in sync', async (t) => {
  const { calls, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/panes/%252`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ' -review-shell ' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    paneId: '%2',
    sessionName: 'leo_lab',
    windowIndex: 1,
    previousName: 'box',
    name: '-review-shell',
    windowRenamed: true,
  });
  assert.deepEqual(calls.at(-2), ['set-option', '-p', '-t', '%2', '@pocketmux_name', '-review-shell']);
  assert.deepEqual(calls.at(-1), ['rename-window', '-t', 'leo_lab:1', '--', '-review-shell']);
});

test('escapes literal hashes for tmux window renames while preserving metadata', async (t) => {
  const { calls, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/panes/%252`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '#{session_name}' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, '#{session_name}');
  assert.deepEqual(calls.at(-2), [
    'set-option', '-p', '-t', '%2', '@pocketmux_name', '#{session_name}',
  ]);
  assert.deepEqual(calls.at(-1), [
    'rename-window', '-t', 'leo_lab:1', '--', '##{session_name}',
  ]);
});

test('surfaces both the rename and metadata rollback failures', async () => {
  const { calls, runner: baseRunner } = fakeTmux();
  const renameError = new Error('rename failed');
  const rollbackError = new Error('rollback failed');
  const runner = async (args) => {
    if (args[0] === 'rename-window') throw renameError;
    if (args[0] === 'set-option' && args.includes('-u')) throw rollbackError;
    return baseRunner(args);
  };

  await assert.rejects(
    renamePane(runner, '%2', 'new-name'),
    (error) => {
      assert.equal(error.code, 'TMUX_RENAME_ROLLBACK_FAILED');
      assert.equal(error.renameError, renameError);
      assert.equal(error.rollbackError, rollbackError);
      assert.deepEqual(error.errors, [renameError, rollbackError]);
      return true;
    },
  );
  assert.deepEqual(calls.at(-1), ['set-option', '-p', '-t', '%2', '@pocketmux_name', 'new-name']);
});

test('renames one pane in a split window without changing sibling window names', async (t) => {
  const { calls, runner } = fakeTmux({
    otherPanes: [{ id: '%2', window: '0', windowName: 'split', index: '1', command: 'zsh', title: 'zsh' }],
  });
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/windows/%251`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'main-pane' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).windowRenamed, false);
  assert.deepEqual(calls.at(-1), ['set-option', '-p', '-t', '%1', '@pocketmux_name', 'main-pane']);
  assert.equal(calls.some((args) => args[0] === 'rename-window'), false);
});

test('rejects an invalid pane name before changing tmux state', async (t) => {
  const { calls, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/panes/%251`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '   ' }),
  });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('deletes an existing zsh window without Pocketmux metadata', async (t) => {
  const { calls, runner } = fakeTmux({
    pane: { command: 'zsh', title: 'zsh' },
  });
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/windows/%251`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, 'exec');
  assert.deepEqual(calls.at(-1), ['kill-window', '-t', 'leo_lab:0']);
});

test('protects windows containing multiple panes from deletion', async (t) => {
  const { calls, runner } = fakeTmux({
    pane: { command: 'zsh', title: 'zsh' },
    otherPanes: [{ id: '%2', window: '0', windowName: 'split', index: '1', command: 'zsh', title: 'zsh' }],
  });
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/windows/%251`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(calls.at(-1), ['list-panes', '-a', '-F', PANE_FORMAT]);
});

test('previews and accepts autosuggestions only on an interactive zsh pane', async (t) => {
  const { calls, loadedBuffers, runner } = fakeTmux({ pane: { command: 'zsh', title: 'zsh' } });
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };

  const preview = await fetch(`${base}/api/panes/%251/suggest`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'git che' }),
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(loadedBuffers, []);
  const previewMutations = calls.filter((args) => args[0] === 'send-keys');
  assert.deepEqual(previewMutations, [['send-keys', '-l', '-t', '%1', '--', 'git che']]);

  const completion = await fetch(`${base}/api/panes/%251/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'git che' }),
  });
  assert.equal(completion.status, 200);
  assert.deepEqual(loadedBuffers, []);
  const completionMutations = calls.filter((args) => args[0] === 'send-keys');
  assert.deepEqual(completionMutations, [
    ['send-keys', '-l', '-t', '%1', '--', 'git che'],
    ['send-keys', '-l', '-t', '%1', '--', 'git che'],
    ['send-keys', '-t', '%1', 'Right'],
  ]);

  const execute = await fetch(`${base}/api/panes/%251/key`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: 'Enter' }),
  });
  assert.equal(execute.status, 200);
  assert.deepEqual(calls.filter((args) => args[0] === 'send-keys').at(-1), [
    'send-keys', '-t', '%1', 'Enter',
  ]);

  const codexCompletion = await fetch(`${base}/api/panes/%252/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'git che' }),
  });
  assert.equal(codexCompletion.status, 409);
  assert.deepEqual(loadedBuffers, []);

  const emptyCompletion = await fetch(`${base}/api/panes/%251/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'git\nche' }),
  });
  assert.equal(emptyCompletion.status, 400);
  assert.deepEqual(loadedBuffers, []);
});

test('protects APIs with a token and supports session/output/input flows', async (t) => {
  const { calls, loadedBuffers, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const unauthorized = await fetch(`${base}/api/sessions`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('x-pocketmux-product'), 'pocketmux');
  assert.equal(unauthorized.headers.get('x-pocketmux-protocol-version'), '1');
  assert.equal((await unauthorized.json()).messageEn, 'An access token is required.');

  const headers = { Authorization: 'Bearer test-token' };
  const sessions = await fetch(`${base}/api/sessions`, { headers });
  assert.equal(sessions.status, 200);
  assert.equal((await sessions.json()).sessions[1].name, 'leo_lab');

  const output = await fetch(`${base}/api/panes/%251/output`, { headers });
  assert.equal(output.status, 200);
  assert.equal((await output.json()).output, 'latest codex output');

  const input = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello from phone', submit: true }),
  });
  assert.equal(input.status, 200);
  const inputCalls = calls.filter((args) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0]));
  assert.deepEqual(inputCalls.map((args) => args[0]), ['load-buffer', 'paste-buffer', 'send-keys']);
  assert.equal(inputCalls[1][0], 'paste-buffer');
  assert.ok(inputCalls[1].includes('-p'));
  assert.equal(inputCalls[1][4], inputCalls[0][2]);
  assert.equal(inputCalls[2].at(-1), 'Enter');
  assert.deepEqual(loadedBuffers, ['hello from phone']);

  const invalidKey = await fetch(`${base}/api/panes/%251/key`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'rm -rf /' }),
  });
  assert.equal(invalidKey.status, 400);
});

test('returns a retryable tmux-unavailable error when pane discovery fails', async (t) => {
  const runner = async (args) => {
    if (args[0] === 'list-panes') {
      const error = new Error('no server running on /tmp/tmux-1000/default');
      error.stderr = error.message;
      throw error;
    }
    return '';
  };
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'retry me', submit: true }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'tmux_unavailable');
});

test('keeps attachment sends safe when a pane disappears during paste', async (t) => {
  const { runner: baseRunner } = fakeTmux();
  const runner = async (args) => {
    if (args[0] === 'paste-buffer') {
      const error = new Error("can't find pane: %1");
      error.stderr = error.message;
      throw error;
    }
    return baseRunner(args);
  };
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'attachment path', submit: true }),
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.code, 'pane_stale');
  assert.match(payload.message, /附件仍会保留/);
});

test('uploads a supported image and sends it with the prompt', async (t) => {
  const { calls, loadedBuffers, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'image/png' };
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const upload = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers,
    body: image,
  });
  assert.equal(upload.status, 201);
  const uploadPayload = await upload.json();
  assert.match(uploadPayload.attachmentId, /^[a-f0-9]{32}$/);
  assert.equal(uploadPayload.contentType, 'image/png');

  const input = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '请分析这张截图',
      attachmentId: uploadPayload.attachmentId,
      submit: true,
    }),
  });
  assert.equal(input.status, 200);
  assert.match(
    loadedBuffers.at(-1),
    /^Image path: .*pocketmux-uploads.*\.png \(original filename: attachment\)\n请分析这张截图$/,
  );
  const mutationCalls = calls.filter((args) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0]));
  assert.deepEqual(mutationCalls.map((args) => args[0]), ['load-buffer', 'paste-buffer', 'send-keys']);
  assert.equal(mutationCalls.at(-1).at(-1), 'Enter');
});

test('enforces aggregate attachment storage limits and removes process files on close', async (t) => {
  const uploadRootDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-upload-quota-'));
  t.after(() => fsp.rm(uploadRootDirectory, { recursive: true, force: true }));
  const { runner } = fakeTmux();
  const instance = createRemoteToolServer({
    token: 'test-token',
    tmuxRunner: runner,
    uploadRootDirectory,
    maxStoredAttachments: 2,
    maxStoredAttachmentBytes: 8,
  });
  const base = await listen(instance.server);
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'text/plain',
    'X-File-Name': 'note.txt',
  };

  const first = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers,
    body: Buffer.from('12345'),
  });
  assert.equal(first.status, 201);
  const second = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers,
    body: Buffer.from('6789'),
  });
  assert.equal(second.status, 413);
  assert.equal((await second.json()).messageEn, 'Temporary attachment storage has reached its size limit. Try again later.');

  await new Promise((resolve) => instance.server.close(resolve));
  await instance.cleanup();
  await assert.rejects(fsp.access(instance.uploadDirectory), { code: 'ENOENT' });
});

test('keeps attachment accounting intact when shutdown cleanup must be retried', async (t) => {
  const uploadRootDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-upload-cleanup-retry-'));
  t.after(() => fsp.rm(uploadRootDirectory, { recursive: true, force: true }));
  const { runner } = fakeTmux();
  let removalAttempts = 0;
  const instance = createRemoteToolServer({
    token: 'test-token',
    tmuxRunner: runner,
    uploadRootDirectory,
    maxStoredAttachments: 1,
    removeUploadDirectory: async (_root, directory) => {
      removalAttempts += 1;
      if (removalAttempts === 1) throw new Error('directory busy');
      await fsp.rm(directory, { recursive: true, force: true });
    },
  });
  const base = await listen(instance.server);
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'text/plain',
    'X-File-Name': 'note.txt',
  };

  const first = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers,
    body: Buffer.from('first'),
  });
  assert.equal(first.status, 201);
  await assert.rejects(instance.cleanup(), /directory busy/);

  const second = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers,
    body: Buffer.from('second'),
  });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).messageEn, 'Temporary attachment storage has reached its file limit. Try again later.');

  await instance.cleanup();
  assert.equal(removalAttempts, 2);
  await assert.rejects(fsp.access(instance.uploadDirectory), { code: 'ENOENT' });
  await new Promise((resolve) => instance.server.close(resolve));
});

test('removes stale process directories and legacy orphan files on startup cleanup', async (t) => {
  const uploadRootDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-upload-stale-'));
  t.after(() => fsp.rm(uploadRootDirectory, { recursive: true, force: true }));
  const staleDirectory = path.join(uploadRootDirectory, '12345-old-0123456789ab');
  const staleFile = path.join(uploadRootDirectory, 'legacy-orphan.txt');
  const freshFile = path.join(uploadRootDirectory, 'fresh.txt');
  await fsp.mkdir(staleDirectory);
  await fsp.writeFile(path.join(staleDirectory, 'attachment.txt'), 'old');
  await fsp.writeFile(staleFile, 'old');
  await fsp.writeFile(freshFile, 'new');
  const now = Date.now();
  const oldTime = new Date(now - ATTACHMENT_TTL_MS - 1000);
  await Promise.all([
    fsp.utimes(staleDirectory, oldTime, oldTime),
    fsp.utimes(staleFile, oldTime, oldTime),
  ]);

  await removeStaleUploads(uploadRootDirectory, ATTACHMENT_TTL_MS, now);

  await assert.rejects(fsp.access(staleDirectory), { code: 'ENOENT' });
  await assert.rejects(fsp.access(staleFile), { code: 'ENOENT' });
  await fsp.access(freshFile);
});

test('stale cleanup recognizes every supported legacy attachment extension', async (t) => {
  const uploadRootDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-upload-legacy-types-'));
  t.after(() => fsp.rm(uploadRootDirectory, { recursive: true, force: true }));
  const oldTime = new Date(Date.now() - ATTACHMENT_TTL_MS - 1000);
  const extensions = [
    'png', 'jpg', 'jpeg', 'gif', 'webp',
    'pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml', 'rtf', 'log',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  ];
  await Promise.all(extensions.map(async (extension) => {
    const file = path.join(uploadRootDirectory, `legacy.${extension}`);
    await fsp.writeFile(file, 'old');
    await fsp.utimes(file, oldTime, oldTime);
  }));

  await removeStaleUploads(uploadRootDirectory, ATTACHMENT_TTL_MS);

  assert.deepEqual(await fsp.readdir(uploadRootDirectory), []);
});

test('does not follow a symlink used as the upload root', { skip: process.platform === 'win32' }, async (t) => {
  const targetDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-upload-target-'));
  const uploadRootDirectory = path.join(os.tmpdir(), `pocketmux-upload-root-link-${process.pid}-${Date.now()}`);
  t.after(async () => {
    await fsp.rm(uploadRootDirectory, { force: true });
    await fsp.rm(targetDirectory, { recursive: true, force: true });
  });
  await fsp.writeFile(path.join(targetDirectory, 'keep.txt'), 'keep');
  await fsp.symlink(targetDirectory, uploadRootDirectory, 'dir');

  await assert.rejects(removeStaleUploads(uploadRootDirectory, ATTACHMENT_TTL_MS), /symlink/);
  await fsp.access(path.join(targetDirectory, 'keep.txt'));
});

test('does not follow a symlink entry during upload cleanup', { skip: process.platform === 'win32' }, async (t) => {
  const uploadRootDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-upload-entry-link-'));
  const targetDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-upload-target-'));
  t.after(async () => {
    await fsp.rm(uploadRootDirectory, { recursive: true, force: true });
    await fsp.rm(targetDirectory, { recursive: true, force: true });
  });
  const oldTime = new Date(Date.now() - ATTACHMENT_TTL_MS - 1000);
  await fsp.writeFile(path.join(targetDirectory, 'keep.txt'), 'keep');
  const entryPath = path.join(uploadRootDirectory, '12345-old-0123456789ab');
  await fsp.symlink(targetDirectory, entryPath, 'dir');
  await fsp.lutimes(entryPath, oldTime, oldTime);

  await assert.rejects(removeStaleUploads(uploadRootDirectory, ATTACHMENT_TTL_MS), /symlink/);
  await fsp.access(path.join(targetDirectory, 'keep.txt'));
  const entryStats = await fsp.lstat(entryPath);
  assert.equal(entryStats.isSymbolicLink(), true);
});

test('keeps an expired attachment accounted for when disk deletion fails', async () => {
  const attachment = {
    id: 'expired',
    path: '/tmp/pocketmux-expired',
    size: 42,
    createdAt: 1,
  };
  const attachments = new Map([[attachment.id, attachment]]);
  await assert.rejects(
    pruneExpiredAttachments(attachments, 2, async () => { throw new Error('busy'); }),
    /busy/,
  );
  assert.equal(attachments.get(attachment.id), attachment);

  const removedBytes = await pruneExpiredAttachments(attachments, 2, async () => undefined);
  assert.equal(removedBytes, 42);
  assert.equal(attachments.size, 0);
});

test('rejects an aborted attachment body without waiting for an end event', async () => {
  const { PassThrough } = require('node:stream');
  const request = new PassThrough();
  request.headers = {};
  const reading = readRequestBody(request, 1024, 'too large');
  request.write('partial');
  request.emit('aborted');
  await assert.rejects(reading, /Request aborted/);
});

test('rejects an attachment request that aborted before its queued body read began', async () => {
  const { PassThrough } = require('node:stream');
  const request = new PassThrough();
  request.headers = {};
  request.aborted = true;
  await assert.rejects(readRequestBody(request, 1024, 'too large'), /Request aborted/);
});

test('drains oversized declared bodies without exposing a late socket error', async () => {
  const { PassThrough } = require('node:stream');
  const request = new PassThrough();
  request.headers = { 'content-length': '2048' };
  await assert.rejects(readRequestBody(request, 1024, 'too large'), /Request body too large/);
  request.emit('close');
  assert.doesNotThrow(() => request.emit('error', new Error('late disconnect')));
});

test('times out a stalled upload without blocking pane input', async (t) => {
  const { runner } = fakeTmux();
  const instance = createRemoteToolServer({
    token: 'test-token',
    tmuxRunner: runner,
    uploadReadTimeoutMs: 150,
    maxConcurrentUploadReads: 1,
  });
  const base = await listen(instance.server);
  t.after(() => instance.server.close());

  let stalledRequest;
  const stalledResponse = new Promise((resolve, reject) => {
    stalledRequest = http.request(`${base}/api/uploads`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'text/plain',
        'Content-Length': '8',
        'X-File-Name': 'stalled.txt',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    stalledRequest.on('error', reject);
    stalledRequest.flushHeaders();
    stalledRequest.write('x');
  });

  const input = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'still responsive', submit: true }),
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(input.status, 200);

  const competingUpload = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'text/plain',
      'X-File-Name': 'competing.txt',
    },
    body: Buffer.from('competing'),
  });
  assert.equal(competingUpload.status, 429);
  assert.equal(
    (await competingUpload.json()).messageEn,
    'Too many attachments are uploading at once. Try again shortly.',
  );

  const timedOut = await stalledResponse;
  assert.equal(timedOut.status, 408);
  assert.equal(timedOut.payload.messageEn, 'The attachment upload timed out. Select it and try again.');
  stalledRequest.destroy();
});

test('bounds the default upload read concurrency at four near-limit requests', async (t) => {
  const { runner } = fakeTmux();
  const instance = createRemoteToolServer({
    token: 'test-token',
    tmuxRunner: runner,
    uploadReadTimeoutMs: 250,
  });
  const base = await listen(instance.server);
  t.after(() => instance.server.close());

  const openStalledUpload = (index) => {
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request(`${base}/api/uploads`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'text/plain',
          'Content-Length': String(25 * 1024 * 1024),
          'X-File-Name': `stalled-${index}.txt`,
        },
      }, (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => resolve({
          status: incoming.statusCode,
          payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      });
      request.on('error', reject);
      request.flushHeaders();
      request.write('x');
    });
    return { request, response };
  };

  const stalled = Array.from({ length: 4 }, (_, index) => openStalledUpload(index));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rejected = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'text/plain',
      'X-File-Name': 'fifth.txt',
    },
    body: Buffer.from('fifth'),
  });
  assert.equal(rejected.status, 429);

  const timedOut = await Promise.all(stalled.map(({ response }) => response));
  assert.deepEqual(timedOut.map(({ status }) => status), [408, 408, 408, 408]);
  stalled.forEach(({ request }) => request.destroy());
});

test('uploads common documents through the same attachment endpoint', async (t) => {
  const { runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const cases = [
    {
      name: 'notes.txt',
      contentType: 'text/plain',
      body: Buffer.from('notes for codex'),
      extension: 'txt',
    },
    {
      name: 'report.pdf',
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.7\n'),
      extension: 'pdf',
    },
    {
      name: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      extension: 'docx',
    },
    {
      name: 'data.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      extension: 'xlsx',
    },
    {
      name: 'legacy.xls',
      contentType: 'application/vnd.ms-excel',
      body: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      extension: 'xls',
    },
  ];

  for (const file of cases) {
    const upload = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': file.contentType,
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file.body,
    });
    assert.equal(upload.status, 201, file.name);
    const payload = await upload.json();
    assert.equal(payload.kind, 'file');
    assert.equal(payload.name, file.name);
    assert.equal(payload.extension, file.extension);
  }
});

test('sends a document path followed by its prompt to the current pane', async (t) => {
  const { loadedBuffers, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const upload = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'text/plain',
      'X-File-Name': encodeURIComponent('notes.txt'),
    },
    body: Buffer.from('notes for codex'),
  });
  const { attachmentId } = await upload.json();

  const input = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '请总结这个文件',
      attachmentId,
      submit: true,
    }),
  });
  assert.equal(input.status, 200);
  assert.match(
    loadedBuffers.at(-1),
    /^File path: .*pocketmux-uploads.*\.txt \(original filename: notes\.txt\)\n请总结这个文件$/,
  );
});

test('sends multiple mixed attachments with one prompt in selection order', async (t) => {
  const { loadedBuffers, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const uploads = [];
  for (const file of [
    { name: 'screen.png', contentType: 'image/png', body: image },
    { name: 'notes.txt', contentType: 'text/plain', body: Buffer.from('notes for codex') },
  ]) {
    const response = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': file.contentType,
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file.body,
    });
    assert.equal(response.status, 201);
    uploads.push(await response.json());
  }

  const input = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '结合图片和文档一起分析',
      attachmentIds: uploads.map((upload) => upload.attachmentId),
      submit: true,
    }),
  });
  assert.equal(input.status, 200);
  assert.match(
    loadedBuffers.at(-1),
    /^Image path: .*pocketmux-uploads.*\.png \(original filename: screen\.png\)\nFile path: .*pocketmux-uploads.*\.txt \(original filename: notes\.txt\)\n结合图片和文档一起分析$/,
  );
});

test('sanitizes attachment filenames before adding them to prompt lines', async (t) => {
  const { loadedBuffers, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const upload = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'text/plain',
      'X-File-Name': encodeURIComponent('folder/notes\n\t.txt'),
    },
    body: Buffer.from('notes for codex'),
  });
  assert.equal(upload.status, 201);
  const payload = await upload.json();
  assert.equal(payload.name, 'notes.txt');

  const input = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'read it', attachmentId: payload.attachmentId }),
  });
  assert.equal(input.status, 200);
  assert.match(
    loadedBuffers.at(-1),
    /^File path: .*pocketmux-uploads.*\.txt \(original filename: notes\.txt\)\nread it$/,
  );
});

test('rejects messages with too many attachments before touching tmux', async (t) => {
  const { calls, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'too many',
      attachmentIds: Array.from({ length: 11 }, (_, index) => index.toString(16).padStart(32, '0')),
      submit: true,
    }),
  });
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('rejects invalid image uploads before touching tmux', async (t) => {
  const { calls, runner } = fakeTmux();
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'image/png' },
    body: Buffer.from('not an image'),
  });
  assert.equal(response.status, 415);
  assert.equal(calls.length, 0);
});

test('exits tmux copy mode before submitting input', async (t) => {
  const { calls, runner } = fakeTmux({ pane: { inMode: '1', mode: 'copy-mode' } });
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello from copy mode', submit: true }),
  });
  assert.equal(response.status, 200);

  const mutationCalls = calls.filter((args) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0]));
  assert.deepEqual(mutationCalls.map((args) => args[0]), ['send-keys', 'load-buffer', 'paste-buffer', 'send-keys']);
  assert.deepEqual(mutationCalls[0], ['send-keys', '-X', '-t', '%1', 'cancel']);
  assert.equal(mutationCalls.at(-1).at(-1), 'Enter');
});

test('serializes concurrent input mutations for one pane', async (t) => {
  const calls = [];
  let releaseFirstPaste;
  let firstPasteStarted;
  const firstPasteReady = new Promise((resolve) => {
    firstPasteStarted = resolve;
  });
  const firstPasteRelease = new Promise((resolve) => {
    releaseFirstPaste = resolve;
  });
  let blockedFirstPaste = false;
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === 'list-panes') return paneRow() + '\n';
    if (args[0] === 'load-buffer') await fsp.readFile(args.at(-1), 'utf8');
    if (args[0] === 'paste-buffer' && !blockedFirstPaste) {
      blockedFirstPaste = true;
      firstPasteStarted();
      await firstPasteRelease;
    }
    return '';
  };
  const { server } = createRemoteToolServer({ token: 'test-token', tmuxRunner: runner });
  const base = await listen(server);
  t.after(() => server.close());
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const submit = (text) => fetch(`${base}/api/panes/%251/input`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, submit: true }),
  });

  const first = submit('first');
  await firstPasteReady;
  const second = submit('second');
  await new Promise((resolve) => setImmediate(resolve));
  const beforeRelease = calls.filter((args) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0]));
  assert.deepEqual(beforeRelease.map((args) => args[0]), ['load-buffer', 'paste-buffer']);

  releaseFirstPaste();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const mutations = calls.filter((args) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0]));
  assert.deepEqual(mutations.map((args) => args[0]), [
    'load-buffer', 'paste-buffer', 'send-keys',
    'load-buffer', 'paste-buffer', 'send-keys',
  ]);
});
