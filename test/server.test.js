'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fsp = require('node:fs/promises');

const {
  buildSessionTree,
  createRemoteToolServer,
  isAllowedKey,
  parsePaneRows,
} = require('../server');

const delimiter = '\t';

function paneRow({ id = '%1', session = 'leo_lab', window = '0', windowName = 'exec', index = '0', command = 'node', title = 'codex | leo_lab', inMode = '0', mode = '' } = {}) {
  return [id, session, window, windowName, index, command, title, '120', '40', '0', '1', '1234', inMode, mode].join(delimiter);
}

function fakeTmux({ pane = {} } = {}) {
  const calls = [];
  const loadedBuffers = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return ['deploy', '5', '1'].join(delimiter) + '\n' + ['leo_lab', '9', '1'].join(delimiter) + '\n';
    if (args[0] === 'list-panes') return paneRow(pane) + '\n' + paneRow({ id: '%2', window: '1', windowName: 'box', title: 'codex | leo_lab' }) + '\n';
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

test('parses tmux pane rows and identifies Codex panes', () => {
  const [codex, shell] = parsePaneRows(`${paneRow()}\n${paneRow({ id: '%2', command: 'zsh', title: 'venus' })}\n`);
  assert.equal(codex.id, '%1');
  assert.equal(codex.codex, true);
  assert.equal(shell.codex, false);
  assert.equal(codex.width, 120);

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
