'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const {
  buildSessionTree,
  createRemoteToolServer,
  isAllowedKey,
  PANE_FORMAT,
  parsePaneRows,
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
  const [app, styles, html, manifest] = await Promise.all([
    fsp.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'),
    fsp.readFile(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'),
  ]);

  assert.match(app, /window\.visualViewport\?\.addEventListener\('resize', scheduleMessageInputVisibility\)/);
  assert.match(app, /Math\.min\(elements\.messageInput\.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT\)/);
  assert.match(app, /shouldAutoScrollTerminal\(\{/);
  assert.match(styles, /body\.message-input-active \.app-shell \{ padding-bottom: var\(--keyboard-inset\); \}/);
  assert.match(styles, /\.composer-form textarea \{[^}]*overflow-y: auto;/);
  assert.match(html, /app-helpers\.js\?v=20260809-review-fixes/);
  assert.match(html, /app\.js\?v=20260809-review-fixes/);
  assert.equal((html.match(/\/favicon\.ico\?v=20260809-pocketmux-bmp/g) || []).length, 2);
  assert.match(html, /sizes="16x16 32x32 48x48"/);
  assert.equal((html.match(/\/assets\/pocketmux-icon-192\.png\?v=20260809-pocketmux/g) || []).length, 1);
  assert.equal((html.match(/\/assets\/pocketmux-icon\.png/g) || []).length, 2);
  assert.match(styles, /\.brand-mark img \{/);
  assert.match(manifest, /"src": "\/assets\/pocketmux-icon-192\.png"/);
  assert.match(manifest, /"src": "\/assets\/pocketmux-icon-512\.png"/);
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

  const icon = await fetch(`${base}/assets/pocketmux-icon.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.ok((await icon.arrayBuffer()).byteLength > 1000);

  const favicon = await fetch(`${base}/favicon.ico`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get('content-type'), 'image/x-icon');
  const faviconBytes = Buffer.from(await favicon.arrayBuffer());
  assert.equal(Number(favicon.headers.get('content-length')), faviconBytes.byteLength);
  assert.ok(faviconBytes.byteLength > 1000);
  assert.deepEqual([...faviconBytes.subarray(0, 4)], [0, 0, 1, 0]);

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
