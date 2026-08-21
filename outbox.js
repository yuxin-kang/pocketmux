'use strict';

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;
const { randomBytes } = require('node:crypto');

const OUTBOX_ROOT_DIRECTORY = path.join(os.homedir(), '.local', 'share', 'pocketmux', 'outbox');
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OUTBOX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_OUTBOX_FILES = 100;
const MAX_OUTBOX_BYTES = 500 * 1024 * 1024;
const OUTBOX_ID_PATTERN = /^[a-f0-9]{32}$/;
const PDF_SIGNATURE = Buffer.from('%PDF-');

const OUTBOX_TYPES = new Map([
  ['pdf', { extension: 'pdf', contentType: 'application/pdf', maxBytes: MAX_OUTBOX_FILE_BYTES }],
  ['md', { extension: 'md', contentType: 'text/markdown', maxBytes: 10 * 1024 * 1024 }],
  ['markdown', { extension: 'md', contentType: 'text/markdown', maxBytes: 10 * 1024 * 1024 }],
  ['txt', { extension: 'txt', contentType: 'text/plain', maxBytes: 10 * 1024 * 1024 }],
  ['log', { extension: 'log', contentType: 'text/plain', maxBytes: 10 * 1024 * 1024 }],
]);

function outboxError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function sanitizeOutboxName(name) {
  const safeName = path.basename(String(name || '').replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  return safeName || 'file';
}

function outboxTypeForName(name) {
  const extension = path.extname(String(name || '')).slice(1).toLowerCase();
  return OUTBOX_TYPES.get(extension) || null;
}

function assertOutboxId(id) {
  if (typeof id !== 'string' || !OUTBOX_ID_PATTERN.test(id)) {
    throw outboxError('inbox_file_not_found', 'Invalid inbox file id.', 404);
  }
}

async function ensureOutboxDirectory(directory = OUTBOX_ROOT_DIRECTORY) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fsp.chmod(directory, 0o700);
  } catch (error) {
    if (!['EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
  }
  return directory;
}

function metadataPath(directory, id) {
  assertOutboxId(id);
  return path.join(directory, `${id}.json`);
}

function dataPath(directory, id, extension) {
  assertOutboxId(id);
  if (!/^[a-z0-9]+$/i.test(extension || '')) {
    throw outboxError('inbox_file_not_found', 'Invalid inbox file type.', 404);
  }
  return path.join(directory, `${id}.${extension}`);
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fsp.rename(temporaryPath, filePath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readMetadata(directory, id) {
  const filePath = metadataPath(directory, id);
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      throw outboxError('inbox_file_not_found', 'Inbox file not found.', 404);
    }
    throw error;
  }
  if (metadata?.id !== id || !OUTBOX_TYPES.has(String(metadata.extension || '').toLowerCase())) {
    throw outboxError('inbox_file_not_found', 'Inbox file not found.', 404);
  }
  const type = OUTBOX_TYPES.get(String(metadata.extension).toLowerCase());
  const filePathForData = dataPath(directory, id, type.extension);
  try {
    const stat = await fsp.stat(filePathForData);
    if (!stat.isFile()) throw outboxError('inbox_file_not_found', 'Inbox file not found.', 404);
    return {
      ...metadata,
      name: sanitizeOutboxName(metadata.name),
      extension: type.extension,
      contentType: type.contentType,
      size: stat.size,
      path: filePathForData,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw outboxError('inbox_file_not_found', 'Inbox file not found.', 404);
    }
    throw error;
  }
}

async function listOutboxFiles(directory = OUTBOX_ROOT_DIRECTORY) {
  await ensureOutboxDirectory(directory);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!OUTBOX_ID_PATTERN.test(id)) continue;
    try {
      const file = await readMetadata(directory, id);
      files.push({
        id: file.id,
        name: file.name,
        contentType: file.contentType,
        extension: file.extension,
        size: file.size,
        createdAt: file.createdAt,
        viewedAt: file.viewedAt || null,
      });
    } catch (error) {
      if (error?.code !== 'inbox_file_not_found') throw error;
    }
  }
  return files.sort((a, b) => (
    Number(b.createdAt || 0) - Number(a.createdAt || 0)
  ));
}

async function pruneOutboxFiles(directory = OUTBOX_ROOT_DIRECTORY, {
  now = Date.now(),
  ttlMs = OUTBOX_TTL_MS,
} = {}) {
  const files = await listOutboxFiles(directory);
  let removed = 0;
  for (const file of files) {
    if (Number(file.createdAt) > now - ttlMs) continue;
    await removeOutboxFile(directory, file.id);
    removed += 1;
  }
  return removed;
}

async function stageOutboxFile(directory = OUTBOX_ROOT_DIRECTORY, sourcePath, { name } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw outboxError('source_file_required', 'A source file path is required.');
  }
  const resolvedSourcePath = path.resolve(sourcePath);
  const originalName = sanitizeOutboxName(name || path.basename(resolvedSourcePath));
  const type = outboxTypeForName(originalName) || outboxTypeForName(resolvedSourcePath);
  if (!type) {
    throw outboxError('unsupported_file_type', 'Only PDF, Markdown, TXT, and LOG files can be sent to Pocketmux.');
  }
  let stat;
  try {
    stat = await fsp.stat(resolvedSourcePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw outboxError('source_file_missing', 'The source file does not exist.', 404);
    throw error;
  }
  if (!stat.isFile()) throw outboxError('source_file_invalid', 'The source path is not a regular file.');
  if (stat.size <= 0) throw outboxError('source_file_empty', 'The source file is empty.');
  if (stat.size > type.maxBytes) {
    throw outboxError('source_file_too_large', `The file is larger than the ${Math.round(type.maxBytes / 1024 / 1024)} MB limit.`, 413);
  }
  if (type.extension === 'pdf') {
    const handle = await fsp.open(resolvedSourcePath, 'r');
    try {
      const header = Buffer.alloc(PDF_SIGNATURE.length);
      await handle.read(header, 0, header.length, 0);
      if (!header.equals(PDF_SIGNATURE)) throw outboxError('invalid_pdf', 'The file does not contain a valid PDF signature.');
    } finally {
      await handle.close();
    }
  }

  await ensureOutboxDirectory(directory);
  await pruneOutboxFiles(directory);
  const existing = await listOutboxFiles(directory);
  const existingBytes = existing.reduce((total, file) => total + Number(file.size || 0), 0);
  if (existing.length >= MAX_OUTBOX_FILES) {
    throw outboxError('inbox_storage_full', 'The Pocketmux inbox has reached its file limit.', 429);
  }
  if (existingBytes + stat.size > MAX_OUTBOX_BYTES) {
    throw outboxError('inbox_storage_full', 'The Pocketmux inbox has reached its size limit.', 429);
  }

  const id = randomBytes(16).toString('hex');
  const targetPath = dataPath(directory, id, type.extension);
  const temporaryPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
  const metadata = {
    version: 1,
    id,
    name: originalName,
    extension: type.extension,
    contentType: type.contentType,
    size: stat.size,
    createdAt: Date.now(),
    viewedAt: null,
  };
  try {
    await fsp.copyFile(resolvedSourcePath, temporaryPath);
    await fsp.chmod(temporaryPath, 0o600).catch(() => undefined);
    await fsp.rename(temporaryPath, targetPath);
    await writeJsonAtomically(metadataPath(directory, id), metadata);
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    await fsp.rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return metadata;
}

async function getOutboxFile(directory = OUTBOX_ROOT_DIRECTORY, id) {
  return readMetadata(directory, id);
}

async function acknowledgeOutboxFile(directory = OUTBOX_ROOT_DIRECTORY, id) {
  const file = await readMetadata(directory, id);
  const metadataFilePath = metadataPath(directory, id);
  const metadata = {
    version: 1,
    id: file.id,
    name: file.name,
    extension: file.extension,
    contentType: file.contentType,
    size: file.size,
    createdAt: file.createdAt,
    viewedAt: file.viewedAt || new Date().toISOString(),
  };
  await writeJsonAtomically(metadataFilePath, metadata);
  return { ...file, viewedAt: metadata.viewedAt };
}

async function removeOutboxFile(directory = OUTBOX_ROOT_DIRECTORY, id) {
  const metadata = await readMetadata(directory, id).catch((error) => {
    if (error?.code === 'inbox_file_not_found') return null;
    throw error;
  });
  if (!metadata) return false;
  await Promise.all([
    fsp.rm(metadata.path, { force: true }),
    fsp.rm(metadataPath(directory, id), { force: true }),
  ]);
  return true;
}

module.exports = {
  MAX_OUTBOX_BYTES,
  MAX_OUTBOX_FILE_BYTES,
  MAX_OUTBOX_FILES,
  OUTBOX_ID_PATTERN,
  OUTBOX_ROOT_DIRECTORY,
  OUTBOX_TTL_MS,
  OUTBOX_TYPES,
  acknowledgeOutboxFile,
  ensureOutboxDirectory,
  getOutboxFile,
  listOutboxFiles,
  outboxTypeForName,
  pruneOutboxFiles,
  removeOutboxFile,
  sanitizeOutboxName,
  stageOutboxFile,
};
