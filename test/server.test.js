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
  assert.match(loadedBuffers.at(-1), /^Image path: .*pocketmux-uploads.*\.png\n请分析这张截图$/);
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
  assert.match(loadedBuffers.at(-1), /^File path: .*pocketmux-uploads.*\.txt\n请总结这个文件$/);
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
