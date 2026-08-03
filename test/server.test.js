'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const {
  buildSessionTree,
  createRemoteToolServer,
  isAllowedKey,
  parsePaneRows,
} = require('../server');

const delimiter = '\t';

function paneRow({ id = '%1', session = 'leo_lab', window = '0', windowName = 'exec', index = '0', command = 'node', title = 'codex | leo_lab' } = {}) {
  return [id, session, window, windowName, index, command, title, '120', '40', '0', '1', '1234'].join(delimiter);
}

function fakeTmux() {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return ['deploy', '5', '1'].join(delimiter) + '\n' + ['leo_lab', '9', '1'].join(delimiter) + '\n';
    if (args[0] === 'list-panes') return paneRow() + '\n' + paneRow({ id: '%2', window: '1', windowName: 'box', title: 'codex | leo_lab' }) + '\n';
    if (args[0] === 'capture-pane') return 'latest codex output';
    return '';
  };
  return { calls, runner };
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
  const { calls, runner } = fakeTmux();
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
  assert.ok(calls.some((args) => args[0] === 'load-buffer'));
  assert.ok(calls.some((args) => args[0] === 'paste-buffer'));
  assert.ok(calls.some((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter'));

  const invalidKey = await fetch(`${base}/api/panes/%251/key`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'rm -rf /' }),
  });
  assert.equal(invalidKey.status, 400);
});
