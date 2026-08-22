#!/usr/bin/env node
'use strict';

const {
  OUTBOX_ROOT_DIRECTORY,
  stageOutboxFile,
} = require('../outbox');

const outboxDirectory = process.env.POCKETMUX_OUTBOX_DIR || OUTBOX_ROOT_DIRECTORY;

function usage() {
  console.error('Usage: pocketmux-send-file <file> [--name <display-name>]');
  console.error('Supported files: PDF, common images, videos, Markdown, TXT, and LOG.');
}

async function main(argv = process.argv.slice(2)) {
  const sourcePath = argv.find((argument) => !argument.startsWith('--'));
  const nameIndex = argv.indexOf('--name');
  const displayName = nameIndex >= 0 ? argv[nameIndex + 1] : undefined;
  if (!sourcePath || (nameIndex >= 0 && !displayName)) {
    usage();
    process.exitCode = 2;
    return null;
  }
  const file = await stageOutboxFile(outboxDirectory, sourcePath, { name: displayName });
  console.log(`Pocketmux file queued: ${file.name} (${file.id})`);
  return file;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Pocketmux file send failed: ${error.message}`);
    process.exitCode = error.statusCode && error.statusCode >= 400 ? 1 : 1;
  });
}

module.exports = { main };
