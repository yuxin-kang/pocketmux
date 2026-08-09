'use strict';

((root, factory) => {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  else root.PocketmuxAppHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function shouldAutoScrollTerminal({ forceScrollBottom, mobileLayout, inputFocused, atBottom }) {
    return Boolean(forceScrollBottom || (atBottom && (!mobileLayout || !inputFocused)));
  }

  function findPaneById(sessions, paneId) {
    for (const session of sessions || []) {
      const pane = (session.panes || []).find((candidate) => candidate.id === paneId);
      if (pane) return pane;
    }
    return null;
  }

  function createAttachmentSelection(file, clientId, url = '') {
    return { clientId, file, url, upload: null };
  }

  async function resolveAttachmentUploads(attachments, uploadFile) {
    const results = await Promise.allSettled(attachments.map(async (attachment) => {
      if (attachment.upload?.attachmentId) return attachment.upload;
      const upload = await uploadFile(attachment.file);
      attachment.upload = upload;
      return upload;
    }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    return results.map((result) => result.value);
  }

  return {
    createAttachmentSelection,
    findPaneById,
    resolveAttachmentUploads,
    shouldAutoScrollTerminal,
  };
});
