'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  createAttachmentSelection,
  findPaneById,
  resolveAttachmentUploads,
  shouldAutoScrollTerminal,
} = require('../public/app-helpers');
const {
  catalogs,
  htmlLanguage,
  normalizeLanguage,
  translate,
} = require('../public/i18n');

test('keeps Chinese and English translation catalogs complete and aligned', () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.zh).sort());
  assert.ok(Object.keys(catalogs.zh).length >= 100);
});

test('defaults unsupported or missing language preferences to Chinese', () => {
  assert.equal(normalizeLanguage(null), 'zh');
  assert.equal(normalizeLanguage('fr'), 'zh');
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(htmlLanguage('zh'), 'zh-CN');
  assert.equal(htmlLanguage('en'), 'en');
});

test('translates static and dynamic UI messages in both languages', () => {
  assert.equal(translate('zh', 'action.logout'), '退出');
  assert.equal(translate('en', 'action.logout'), 'Log out');
  assert.equal(translate('zh', 'sessions.emptyTitle'), '没有发现 tmux 会话');
  assert.equal(translate('en', 'sessions.emptyTitle'), 'No tmux sessions found');
  assert.equal(translate('zh', 'attachment.added', { count: 2 }), '已添加 2 个附件');
  assert.equal(translate('en', 'attachment.added', { count: 2 }), 'Added 2 attachments');
  assert.equal(
    translate('en', 'panes.count', { panes: 2, codex: 1 }),
    '2 panes · 1 Codex',
  );
});

test('only pauses terminal auto-follow for a focused mobile composer', () => {
  assert.equal(shouldAutoScrollTerminal({
    forceScrollBottom: false,
    mobileLayout: true,
    inputFocused: true,
    atBottom: true,
  }), false);
  assert.equal(shouldAutoScrollTerminal({
    forceScrollBottom: false,
    mobileLayout: false,
    inputFocused: true,
    atBottom: true,
  }), true);
  assert.equal(shouldAutoScrollTerminal({
    forceScrollBottom: true,
    mobileLayout: true,
    inputFocused: true,
    atBottom: false,
  }), true);
});

test('keeps a rename dialog bound to its original pane', () => {
  const paneA = { id: '%1', windowName: 'alpha' };
  const paneB = { id: '%2', windowName: 'beta' };
  const sessions = [{ name: 'work', panes: [paneB, paneA] }];

  assert.equal(findPaneById(sessions, '%1'), paneA);
  assert.equal(findPaneById(sessions, '%missing'), null);
});

test('allows distinct files even when their visible metadata collides', () => {
  const firstFile = { name: 'report.txt', size: 4, lastModified: 1, type: 'text/plain' };
  const secondFile = { name: 'report.txt', size: 4, lastModified: 1, type: 'text/plain' };
  const selections = [
    createAttachmentSelection(firstFile, 1),
    createAttachmentSelection(secondFile, 2),
  ];

  assert.equal(selections.length, 2);
  assert.notEqual(selections[0].clientId, selections[1].clientId);
  assert.notEqual(selections[0].file, selections[1].file);
});

test('reuses successful uploads when another attachment initially fails', async () => {
  const attachments = [
    createAttachmentSelection({ name: 'first.txt' }, 1),
    createAttachmentSelection({ name: 'second.txt' }, 2),
  ];
  const uploadCalls = [];
  let failSecond = true;
  const uploadFile = async (file) => {
    uploadCalls.push(file.name);
    if (file.name === 'second.txt' && failSecond) throw new Error('temporary upload failure');
    return { attachmentId: `${file.name}-id` };
  };

  await assert.rejects(resolveAttachmentUploads(attachments, uploadFile), /temporary upload failure/);
  assert.equal(attachments[0].upload.attachmentId, 'first.txt-id');
  assert.equal(attachments[1].upload, null);

  failSecond = false;
  const uploads = await resolveAttachmentUploads(attachments, uploadFile);
  assert.deepEqual(uploads.map((upload) => upload.attachmentId), ['first.txt-id', 'second.txt-id']);
  assert.deepEqual(uploadCalls, ['first.txt', 'second.txt', 'second.txt']);
});

test('client wiring uses the reviewed helpers and no metadata deduplication key', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /findPaneById\(state\.sessions, state\.renameTargetPaneId\)/);
  assert.match(source, /resolveAttachmentUploads\(messageAttachments, uploadAttachment\)/);
  assert.doesNotMatch(source, /attachmentSelectionKey|selectedKeys/);
  assert.doesNotMatch(source, /[\u4e00-\u9fff]/, 'dynamic UI copy belongs in the translation catalog');
});
