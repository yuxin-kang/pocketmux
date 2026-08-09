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
});
