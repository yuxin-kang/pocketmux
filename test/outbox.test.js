'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const { createRemoteToolServer } = require('../server');
const {
  acknowledgeOutboxFile,
  getOutboxFile,
  listOutboxFiles,
  stageOutboxFile,
} = require('../outbox');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('stages a Markdown file durably and records acknowledgement state', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-outbox-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'release-notes.md');
  await fsp.writeFile(source, '# Pocketmux\n');

  const staged = await stageOutboxFile(directory, source);
  assert.match(staged.id, /^[a-f0-9]{32}$/);
  assert.equal(staged.contentType, 'text/markdown');
  assert.equal((await listOutboxFiles(directory)).length, 1);
  assert.equal((await getOutboxFile(directory, staged.id)).name, 'release-notes.md');

  const acknowledged = await acknowledgeOutboxFile(directory, staged.id);
  assert.ok(acknowledged.viewedAt);
  assert.ok((await listOutboxFiles(directory))[0].viewedAt);
});

test('serves the authenticated file inbox and supports download, acknowledgement, and delete', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pocketmux-inbox-api-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'notes.md');
  await fsp.writeFile(source, '# From Codex\n');
  const staged = await stageOutboxFile(directory, source);
  const instance = createRemoteToolServer({
    token: 'inbox-token',
    tmuxRunner: async () => '',
    outboxDirectory: directory,
  });
  const base = await listen(instance.server);
  t.after(() => new Promise((resolve) => instance.server.close(resolve)));
  const headers = { Authorization: 'Bearer inbox-token' };

  assert.equal((await fetch(`${base}/api/inbox`)).status, 401);
  const list = await fetch(`${base}/api/inbox`, { headers });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).unreadCount, 1);

  const download = await fetch(`${base}/api/inbox/${staged.id}`, { headers });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'text/markdown');
  assert.match(download.headers.get('content-disposition') || '', /attachment/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await download.text(), '# From Codex\n');

  const ack = await fetch(`${base}/api/inbox/${staged.id}/ack`, { method: 'POST', headers });
  assert.equal(ack.status, 200);
  assert.ok((await ack.json()).file.viewedAt);

  const deleted = await fetch(`${base}/api/inbox/${staged.id}`, { method: 'DELETE', headers });
  assert.equal(deleted.status, 200);
  assert.equal((await fetch(`${base}/api/inbox`, { headers }).then((response) => response.json())).files.length, 0);
});
