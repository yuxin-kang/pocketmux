'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  OUTBOX_ROOT_DIRECTORY,
  OUTBOX_TTL_MS,
  OUTBOX_ID_PATTERN,
  acknowledgeOutboxFile,
  ensureOutboxDirectory,
  getOutboxFile,
  listOutboxFiles,
  pruneOutboxFiles,
  removeOutboxFile,
} = require('./outbox');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(os.tmpdir(), 'pocketmux-uploads');
// tmux escapes other control characters such as 0x1f as the literal text
// "\\037". A tab is emitted verbatim by tmux 3.x and is not valid in the
// session/window/pane metadata we expose.
const DELIMITER = '\t';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_COMBINED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_STORED_ATTACHMENTS = 100;
const MAX_STORED_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_READ_TIMEOUT_MS = 30 * 1000;
const MAX_CONCURRENT_UPLOAD_READS = 4;
const PROCESS_UPLOAD_DIRECTORY_PATTERN = /^\d+-[a-z0-9]+-[a-f0-9]{12}$/;
const MAX_INPUT_CHARS = 8000;
const MAX_COMPOSED_INPUT_CHARS = 12000;
const MAX_WINDOW_NAME_CHARS = 64;
const DEFAULT_OUTPUT_LINES = 240;
const MAX_OUTPUT_LINES = 600;
const DEFAULT_PORT = 3789;
const POCKETMUX_API_HEADERS = Object.freeze({
  'X-Pocketmux-Product': 'pocketmux',
  'X-Pocketmux-Protocol-Version': '1',
});

const IMAGE_TYPES = new Map([
  ['image/png', { extension: 'png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
  ['image/jpeg', { extension: 'jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) }],
  ['image/gif', { extension: 'gif', signature: Buffer.from('GIF') }],
  ['image/webp', { extension: 'webp', signature: Buffer.from('RIFF') }],
]);
const IMAGE_EXTENSION_CONTENT_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const FILE_TYPE_DEFINITIONS = new Map([
  ['application/pdf', { extension: 'pdf', contentType: 'application/pdf', signature: Buffer.from('%PDF-') }],
  ['text/plain', { extension: 'txt', contentType: 'text/plain' }],
  ['text/markdown', { extension: 'md', contentType: 'text/markdown' }],
  ['text/csv', { extension: 'csv', contentType: 'text/csv' }],
  ['application/json', { extension: 'json', contentType: 'application/json' }],
  ['application/xml', { extension: 'xml', contentType: 'application/xml' }],
  ['text/xml', { extension: 'xml', contentType: 'text/xml' }],
  ['text/yaml', { extension: 'yaml', contentType: 'text/yaml' }],
  ['application/x-yaml', { extension: 'yaml', contentType: 'application/x-yaml' }],
  ['text/rtf', { extension: 'rtf', contentType: 'text/rtf', signature: Buffer.from('{\\rtf') }],
  ['application/rtf', { extension: 'rtf', contentType: 'application/rtf', signature: Buffer.from('{\\rtf') }],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', {
    extension: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signature: ZIP_SIGNATURE,
  }],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', {
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    signature: ZIP_SIGNATURE,
  }],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', {
    extension: 'pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    signature: ZIP_SIGNATURE,
  }],
  ['application/msword', { extension: 'doc', contentType: 'application/msword', signature: OLE_SIGNATURE }],
  ['application/vnd.ms-excel', { extension: 'xls', contentType: 'application/vnd.ms-excel', signature: OLE_SIGNATURE }],
  ['application/vnd.ms-powerpoint', { extension: 'ppt', contentType: 'application/vnd.ms-powerpoint', signature: OLE_SIGNATURE }],
]);
const FILE_EXTENSION_DEFINITIONS = new Map([
  ['pdf', FILE_TYPE_DEFINITIONS.get('application/pdf')],
  ['txt', FILE_TYPE_DEFINITIONS.get('text/plain')],
  ['md', FILE_TYPE_DEFINITIONS.get('text/markdown')],
  ['markdown', { extension: 'md', contentType: 'text/markdown' }],
  ['csv', FILE_TYPE_DEFINITIONS.get('text/csv')],
  ['json', FILE_TYPE_DEFINITIONS.get('application/json')],
  ['xml', FILE_TYPE_DEFINITIONS.get('application/xml')],
  ['yaml', FILE_TYPE_DEFINITIONS.get('text/yaml')],
  ['yml', { extension: 'yml', contentType: 'text/yaml' }],
  ['rtf', FILE_TYPE_DEFINITIONS.get('application/rtf')],
  ['log', { extension: 'log', contentType: 'text/plain' }],
  ['docx', FILE_TYPE_DEFINITIONS.get('application/vnd.openxmlformats-officedocument.wordprocessingml.document')],
  ['xlsx', FILE_TYPE_DEFINITIONS.get('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')],
  ['pptx', FILE_TYPE_DEFINITIONS.get('application/vnd.openxmlformats-officedocument.presentationml.presentation')],
  ['doc', FILE_TYPE_DEFINITIONS.get('application/msword')],
  ['xls', FILE_TYPE_DEFINITIONS.get('application/vnd.ms-excel')],
  ['ppt', FILE_TYPE_DEFINITIONS.get('application/vnd.ms-powerpoint')],
]);
const LEGACY_UPLOAD_EXTENSIONS = new Set([
  ...IMAGE_EXTENSION_CONTENT_TYPES.keys(),
  ...FILE_EXTENSION_DEFINITIONS.keys(),
]);
const LEGACY_UPLOAD_FILE_PATTERN = new RegExp(
  `^[a-zA-Z0-9._-]+\\.(?:${[...LEGACY_UPLOAD_EXTENSIONS].join('|')})$`,
  'i',
);
const ATTACHMENT_ID_PATTERN = /^[a-f0-9]{32}$/;

const SESSION_FORMAT = [
  '#{session_name}',
  '#{session_windows}',
  '#{session_attached}',
].join(DELIMITER);

const PANE_FORMAT = [
  '#{pane_id}',
  '#{session_name}',
  '#{window_index}',
  '#{window_name}',
  '#{pane_index}',
  '#{pane_current_command}',
  '#{pane_title}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_dead}',
  '#{pane_active}',
  '#{pane_pid}',
  '#{pane_in_mode}',
  '#{pane_mode}',
  '#{@pocketmux_name}',
].join(DELIMITER);

const ALLOWED_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'C-c',
  'C-d',
  'C-l',
  'C-z',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

class ApiError extends Error {
  constructor(statusCode, message, publicMessage = message, publicMessageEn = message, {
    code = null,
    partial = false,
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.publicMessageEn = publicMessageEn;
    this.apiCode = code;
    this.partial = partial;
  }
}

function runTmux(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, {
      cwd: ROOT,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0 && !timedOut) {
        finish(resolve, out);
        return;
      }
      const failure = new Error(err || `tmux exited with code ${code ?? 'unknown'}`);
      failure.code = timedOut ? 'TMUX_TIMEOUT' : 'TMUX_COMMAND_FAILED';
      failure.exitCode = code;
      failure.signal = signal;
      failure.stderr = err;
      finish(reject, failure);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
  });
}

function parseRows(output, fieldCount) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(DELIMITER))
    .filter((fields) => fields.length >= fieldCount);
}

function parseSessionRows(output) {
  return parseRows(output, 3).map(([name, windows, attached]) => ({
    name,
    windows: Number.parseInt(windows, 10) || 0,
    attached: Number.parseInt(attached, 10) || 0,
  }));
}

function isCodexPane(pane) {
  return /codex/i.test(`${pane.currentCommand} ${pane.title}`);
}

function hasSpinner(title) {
  return /^[\s]*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(title || '');
}

function parsePaneRows(output) {
  return parseRows(output, 15).map(([
    paneId,
    sessionName,
    windowIndex,
    windowName,
    paneIndex,
    currentCommand,
    title,
    width,
    height,
    dead,
    active,
    pid,
    inMode,
    mode,
    pocketmuxName,
  ]) => ({
    id: paneId,
    sessionName,
    windowIndex: Number.parseInt(windowIndex, 10) || 0,
    windowName: windowName || `window-${windowIndex}`,
    paneIndex: Number.parseInt(paneIndex, 10) || 0,
    currentCommand,
    title,
    width: Number.parseInt(width, 10) || 0,
    height: Number.parseInt(height, 10) || 0,
    dead: dead === '1',
    active: active === '1',
    pid: Number.parseInt(pid, 10) || 0,
    inMode: inMode === '1',
    mode: mode || '',
    pocketmuxName: pocketmuxName || '',
    codex: isCodexPane({ currentCommand, title }),
    busy: hasSpinner(title),
  }));
}

function publicPane(pane) {
  return {
    id: pane.id,
    sessionName: pane.sessionName,
    windowIndex: pane.windowIndex,
    windowName: pane.windowName,
    paneIndex: pane.paneIndex,
    currentCommand: pane.currentCommand,
    title: pane.title,
    width: pane.width,
    height: pane.height,
    dead: pane.dead,
    active: pane.active,
    inMode: pane.inMode,
    mode: pane.mode,
    pocketmuxName: pane.pocketmuxName,
    codex: pane.codex,
    busy: pane.busy,
  };
}

function buildSessionTree(sessionRows, paneRows) {
  const sessions = new Map();
  for (const row of sessionRows) {
    sessions.set(row.name, {
      name: row.name,
      windows: row.windows,
      attached: row.attached > 0,
      panes: [],
    });
  }

  for (const pane of paneRows) {
    if (!sessions.has(pane.sessionName)) {
      sessions.set(pane.sessionName, {
        name: pane.sessionName,
        windows: 0,
        attached: false,
        panes: [],
      });
    }
    sessions.get(pane.sessionName).panes.push(publicPane(pane));
  }

  return [...sessions.values()]
    .map((session) => ({
      ...session,
      paneCount: session.panes.length,
      codexCount: session.panes.filter((pane) => pane.codex).length,
      panes: session.panes.sort((a, b) => (
        a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex
      )),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isNoServerError(error) {
  return /no server running|failed to connect to server|no sessions/i.test(
    `${error?.message || ''} ${error?.stderr || ''}`,
  );
}

async function listSessions(tmuxRunner) {
  let sessionOutput = '';
  let paneOutput = '';
  try {
    sessionOutput = await tmuxRunner(['list-sessions', '-F', SESSION_FORMAT]);
  } catch (error) {
    if (!isNoServerError(error)) throw error;
  }
  try {
    paneOutput = await tmuxRunner(['list-panes', '-a', '-F', PANE_FORMAT]);
  } catch (error) {
    if (!isNoServerError(error)) throw error;
  }
  return buildSessionTree(parseSessionRows(sessionOutput), parsePaneRows(paneOutput));
}

function clampLines(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_OUTPUT_LINES;
  return Math.min(MAX_OUTPUT_LINES, Math.max(20, parsed));
}

function isValidPaneId(value) {
  return /^%\d+$/.test(value);
}

function isPaneTargetError(error) {
  return /can't find (?:pane|client)|pane .* not found|no such pane|invalid pane/i.test(
    `${error?.message || ''} ${error?.stderr || ''}`,
  );
}

function tmuxApiError(error, stage, paneId = '') {
  if (error instanceof ApiError) return error;
  const unavailable = isNoServerError(error)
    || error?.code === 'TMUX_TIMEOUT'
    || error?.code === 'ENOENT';
  if (stage === 'find' && unavailable) {
    return new ApiError(
      503,
      'tmux is unavailable',
      '服务端 tmux 暂时不可用，请确认 tmux 仍在运行后重试。',
      'tmux is temporarily unavailable. Make sure it is running on the host and try again.',
      { code: 'tmux_unavailable' },
    );
  }
  if (stage === 'find') {
    return new ApiError(
      502,
      `tmux pane listing failed for ${paneId || 'unknown pane'}`,
      '无法读取服务端 tmux 窗口，请稍后重试。',
      'The host tmux panes could not be read. Try again shortly.',
      { code: 'tmux_unavailable' },
    );
  }
  if (isPaneTargetError(error)) {
    return new ApiError(
      409,
      `tmux pane ${paneId || 'unknown pane'} disappeared during ${stage}`,
      '当前窗口已经变化，请刷新会话后重试；附件仍会保留。',
      'The selected pane changed. Refresh the sessions and try again; your attachment is kept.',
      { code: 'pane_stale' },
    );
  }
  const partial = stage === 'send-key';
  return new ApiError(
    502,
    `tmux ${stage} failed for ${paneId || 'unknown pane'}`,
    partial
      ? '内容可能已经粘贴，但 Enter 发送失败；请先检查终端后再重试。'
      : '附件已上传，但发送到 tmux 失败，请稍后重试。',
    partial
      ? 'The text may have been pasted, but Enter failed. Check the terminal before retrying.'
      : 'The attachment uploaded, but sending it to tmux failed. Try again shortly.',
    { code: 'tmux_injection_failed', partial },
  );
}

function isZshPane(pane) {
  return Boolean(
    pane
    && !pane.dead
    && !pane.codex
    && String(pane.currentCommand || '').trim().toLowerCase() === 'zsh',
  );
}

function normalizeWindowName(value) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'Window name is required', '请输入窗口名称。');
  }
  const name = value.trim();
  if (!name) {
    throw new ApiError(400, 'Window name is empty', '请输入窗口名称。');
  }
  if (name.length > MAX_WINDOW_NAME_CHARS) {
    throw new ApiError(400, 'Window name is too long', '窗口名称不能超过 64 个字符。');
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw new ApiError(400, 'Window name contains control characters', '窗口名称不能包含控制字符。');
  }
  return name;
}

function isAllowedKey(value) {
  return ALLOWED_KEYS.has(value);
}

async function findPane(tmuxRunner, paneId) {
  if (!isValidPaneId(paneId)) {
    throw new ApiError(400, 'Invalid pane id', '无效的 pane 标识。');
  }
  let output;
  try {
    output = await tmuxRunner(['list-panes', '-a', '-F', PANE_FORMAT]);
  } catch (error) {
    throw tmuxApiError(error, 'find', paneId);
  }
  const panes = parsePaneRows(output);
  const pane = panes.find((candidate) => candidate.id === paneId);
  if (!pane) {
    throw new ApiError(
      409,
      'Pane not found',
      '这个 pane 已经不存在，可能被关闭了；请刷新会话后重试。',
      'This pane no longer exists. Refresh the sessions and try again.',
      { code: 'pane_stale' },
    );
  }
  return pane;
}

async function capturePane(tmuxRunner, paneId, lines) {
  await findPane(tmuxRunner, paneId);
  return tmuxRunner([
    'capture-pane',
    '-p',
    '-J',
    '-S',
    `-${clampLines(lines)}`,
    '-t',
    paneId,
  ]);
}

async function pasteText(tmuxRunner, paneId, text) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmux-relay-'));
  const inputPath = path.join(tempDir, 'input.txt');
  const bufferName = `tmux-relay-${randomBytes(8).toString('hex')}`;
  try {
    await fsp.writeFile(inputPath, text, 'utf8');
    await tmuxRunner(['load-buffer', '-b', bufferName, inputPath]);
    await tmuxRunner(['paste-buffer', '-d', '-p', '-b', bufferName, '-t', paneId]);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

// Bracketed paste is deliberately kept for normal messages, but zsh
// autosuggestions do not refresh reliably while a bracketed paste is active.
// Send validated single-line completion text as literal keystrokes instead so
// zsh can render its suggestion in the pane before the user accepts it.
async function typeLiteralText(tmuxRunner, paneId, text) {
  await tmuxRunner(['send-keys', '-l', '-t', paneId, '--', text]);
}

async function sendKey(tmuxRunner, paneId, key) {
  if (!isAllowedKey(key)) {
    throw new ApiError(400, 'Key is not allowed', '这个控制键不在允许列表中。');
  }
  await tmuxRunner(['send-keys', '-t', paneId, key]);
}

async function findLastWindowPane(tmuxRunner, sessionName) {
  const panes = parsePaneRows(await tmuxRunner(['list-panes', '-a', '-F', PANE_FORMAT]))
    .filter((pane) => pane.sessionName === sessionName);
  if (panes.length === 0) {
    throw new ApiError(404, 'Session not found', '这个 tmux 会话已经不存在，可能被关闭了。');
  }
  return panes.reduce((last, pane) => (
    pane.windowIndex > last.windowIndex
      || (pane.windowIndex === last.windowIndex && pane.paneIndex > last.paneIndex)
      ? pane
      : last
  ));
}

async function createZshWindow(tmuxRunner, paneId, name) {
  const parent = await findPane(tmuxRunner, paneId);
  const lastWindowPane = await findLastWindowPane(tmuxRunner, parent.sessionName);
  const output = await tmuxRunner([
    'new-window',
    '-a',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-c',
    os.homedir(),
    '-n',
    name,
    '-t',
    `${lastWindowPane.sessionName}:${lastWindowPane.windowIndex}`,
    'zsh',
  ]);
  const createdPaneId = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((candidate) => isValidPaneId(candidate));
  if (!createdPaneId) {
    throw new ApiError(502, 'tmux did not return the new window pane id', '新 zsh 窗口创建失败，请重试。');
  }
  try {
    await tmuxRunner(['set-option', '-p', '-t', createdPaneId, '@pocketmux_name', name]);
  } catch (error) {
    await tmuxRunner(['kill-pane', '-t', createdPaneId]).catch(() => undefined);
    throw error;
  }
  return {
    paneId: createdPaneId,
    sessionName: parent.sessionName,
    name,
  };
}

async function renamePane(tmuxRunner, paneId, name) {
  const pane = await findPane(tmuxRunner, paneId);
  const windowPanes = parsePaneRows(await tmuxRunner(['list-panes', '-a', '-F', PANE_FORMAT]))
    .filter((candidate) => (
      candidate.sessionName === pane.sessionName
      && candidate.windowIndex === pane.windowIndex
    ));

  await tmuxRunner(['set-option', '-p', '-t', pane.id, '@pocketmux_name', name]);
  const windowRenamed = windowPanes.length === 1;
  if (windowRenamed) {
    try {
      await tmuxRunner([
        'rename-window',
        '-t',
        `${pane.sessionName}:${pane.windowIndex}`,
        '--',
        name.replaceAll('#', '##'),
      ]);
    } catch (error) {
      const rollbackArgs = pane.pocketmuxName
        ? ['set-option', '-p', '-t', pane.id, '@pocketmux_name', pane.pocketmuxName]
        : ['set-option', '-p', '-u', '-t', pane.id, '@pocketmux_name'];
      try {
        await tmuxRunner(rollbackArgs);
      } catch (rollbackError) {
        const consistencyError = new AggregateError(
          [error, rollbackError],
          'tmux window rename failed and Pocketmux metadata rollback also failed',
          { cause: error },
        );
        consistencyError.code = 'TMUX_RENAME_ROLLBACK_FAILED';
        consistencyError.renameError = error;
        consistencyError.rollbackError = rollbackError;
        throw consistencyError;
      }
      throw error;
    }
  }

  return {
    paneId: pane.id,
    sessionName: pane.sessionName,
    windowIndex: pane.windowIndex,
    previousName: pane.pocketmuxName || pane.windowName || `window-${pane.windowIndex}`,
    name,
    windowRenamed,
  };
}

async function deleteWindow(tmuxRunner, paneId) {
  const pane = await findPane(tmuxRunner, paneId);
  if (pane.dead) {
    throw new ApiError(409, 'Pane is dead', '这个窗口中的进程已经退出，无法删除。');
  }

  const windowPanes = parsePaneRows(await tmuxRunner(['list-panes', '-a', '-F', PANE_FORMAT]))
    .filter((candidate) => (
      candidate.sessionName === pane.sessionName
      && candidate.windowIndex === pane.windowIndex
    ));
  if (windowPanes.length !== 1) {
    throw new ApiError(409, 'Window contains multiple panes', '这个窗口包含多个 pane，为避免误删，暂不允许删除。');
  }

  await tmuxRunner([
    'kill-window',
    '-t',
    `${pane.sessionName}:${pane.windowIndex}`,
  ]);
  return {
    paneId: pane.id,
    sessionName: pane.sessionName,
    windowIndex: pane.windowIndex,
    name: pane.pocketmuxName || pane.windowName || `window-${pane.windowIndex}`,
  };
}

function validateZshCompletionText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'Completion text is empty', '请输入要补全的命令片段。');
  }
  if (value.length > MAX_INPUT_CHARS) {
    throw new ApiError(413, 'Completion text is too long', '补全内容不能超过 8000 个字符。');
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ApiError(400, 'Completion text contains control characters', '补全内容不能包含换行或控制字符。');
  }
  return value;
}

async function completeZsh(tmuxRunner, paneId, text) {
  const pane = await findPane(tmuxRunner, paneId);
  if (!isZshPane(pane)) {
    throw new ApiError(409, 'Pane is not an interactive zsh pane', '只有 zsh pane 支持命令补全。');
  }
  await cancelPaneMode(tmuxRunner, pane);
  await typeLiteralText(tmuxRunner, paneId, text);
  await sendKey(tmuxRunner, paneId, 'Right');
}

async function previewZsh(tmuxRunner, paneId, text) {
  const pane = await findPane(tmuxRunner, paneId);
  if (!isZshPane(pane)) {
    throw new ApiError(409, 'Pane is not an interactive zsh pane', '只有 zsh pane 支持命令补全。');
  }
  await cancelPaneMode(tmuxRunner, pane);
  await typeLiteralText(tmuxRunner, paneId, text);
}

async function cancelPaneMode(tmuxRunner, pane) {
  if (!pane.inMode || !['copy-mode', 'view-mode'].includes(pane.mode)) return;
  await tmuxRunner(['send-keys', '-X', '-t', pane.id, 'cancel']);
}

async function sendPaneInput(tmuxRunner, paneId, message, submit) {
  const pane = await findPane(tmuxRunner, paneId);
  if (pane.dead) {
    throw new ApiError(
      409,
      `Pane ${paneId} is dead`,
      '这个窗口中的进程已经退出；请刷新会话后选择可用窗口，附件仍会保留。',
      'The selected pane has exited. Refresh the sessions and choose a live pane; your attachment is kept.',
      { code: 'pane_stale' },
    );
  }
  try {
    await cancelPaneMode(tmuxRunner, pane);
  } catch (error) {
    throw tmuxApiError(error, 'cancel-mode', paneId);
  }
  if (message) {
    try {
      await pasteText(tmuxRunner, paneId, message);
    } catch (error) {
      throw tmuxApiError(error, 'paste', paneId);
    }
  }
  if (submit) {
    try {
      await sendKey(tmuxRunner, paneId, 'Enter');
    } catch (error) {
      throw tmuxApiError(error, 'send-key', paneId);
    }
  }
}

function readRequestBody(req, maxBytes, tooLargeMessage, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (req.aborted || req.destroyed) {
      reject(new ApiError(
        400,
        'Request aborted',
        '上传已中断，请重新选择附件后再试。',
        'The upload was interrupted. Select the attachment and try again.',
      ));
      return;
    }
    const declaredLength = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      drainRequest(req);
      reject(new ApiError(413, 'Request body too large', tooLargeMessage));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      drainRequest(req);
      reject(error);
    };

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new ApiError(413, 'Request body too large', tooLargeMessage));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAborted = () => fail(new ApiError(
      400,
      'Request aborted',
      '上传已中断，请重新选择附件后再试。',
      'The upload was interrupted. Select the attachment and try again.',
    ));
    const onError = (error) => fail(error);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => fail(new ApiError(
        408,
        'Request body timed out',
        '附件上传超时，请重新选择后再试。',
        'The attachment upload timed out. Select it and try again.',
      )), timeoutMs);
      timer.unref?.();
    }
  });
}

function drainRequest(req) {
  // The response may be written before a slow or disconnected client has
  // finished its request stream. Keep a harmless listener for the remaining
  // lifetime of this request because some streams report close before error.
  req.on('error', () => undefined);
  req.resume();
}

async function readJsonBody(req) {
  const body = await readRequestBody(req, MAX_BODY_BYTES, '输入内容太长了。');
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    throw new ApiError(400, 'Invalid JSON body', '请求内容格式不正确。');
  }
}

function normalizedContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function bufferStartsWith(buffer, signature, offset = 0) {
  return buffer.length >= offset + signature.length
    && buffer.subarray(offset, offset + signature.length).equals(signature);
}

function fileExtension(fileName) {
  return path.extname(String(fileName || '')).slice(1).toLowerCase();
}

function detectImageType(contentType, buffer, fileName = '') {
  let normalizedType = normalizedContentType(contentType);
  if (!normalizedType || normalizedType === 'application/octet-stream') {
    const extensionType = IMAGE_EXTENSION_CONTENT_TYPES.get(fileExtension(fileName));
    normalizedType = extensionType || normalizedType;
  }
  if (normalizedType === 'image/jpg') normalizedType = 'image/jpeg';
  const definition = IMAGE_TYPES.get(normalizedType);
  if (!definition) return null;
  if (normalizedType === 'image/webp') {
    return bufferStartsWith(buffer, definition.signature)
      && bufferStartsWith(buffer, Buffer.from('WEBP'), 8)
      ? { ...definition, contentType: normalizedType }
      : null;
  }
  return bufferStartsWith(buffer, definition.signature)
    ? { ...definition, contentType: normalizedType }
    : null;
}

function detectAttachmentType(contentType, fileName, buffer) {
  const normalizedType = normalizedContentType(contentType);
  const extension = fileExtension(fileName);
  const imageType = detectImageType(contentType, buffer, fileName);
  if (imageType) return { ...imageType, kind: 'image' };
  if (normalizedType.startsWith('image/')) return null;

  const typeDefinition = normalizedType && normalizedType !== 'application/octet-stream'
    ? FILE_TYPE_DEFINITIONS.get(normalizedType)
    : null;
  const extensionDefinition = FILE_EXTENSION_DEFINITIONS.get(extension);
  const definition = typeDefinition || extensionDefinition;
  if (!definition) return null;
  if (definition.signature && !bufferStartsWith(buffer, definition.signature)) return null;
  return { ...definition, kind: 'file' };
}

function requestFileName(req) {
  const rawName = req.headers['x-file-name'];
  if (typeof rawName !== 'string') return 'attachment';
  let decodedName = rawName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    // Keep the raw header when a client sends a malformed encoded name.
  }
  const safeName = path.basename(decodedName.replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  return safeName || 'attachment';
}

function isUnix() {
  return process.platform !== 'win32';
}

function assertPrivateUploadDirectory(stats, directory) {
  if (!stats.isDirectory()) throw new Error(`Upload path is not a directory: ${directory}`);
  if (isUnix()) {
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new Error(`Upload directory is not owned by the current user: ${directory}`);
    }
    if ((stats.mode & 0o777) !== 0o700) {
      throw new Error(`Upload directory must have mode 0700: ${directory}`);
    }
  }
}

async function ensureUploadDirectory(uploadDirectory, { create = true, recursive = false } = {}) {
  if (create) {
    await fsp.mkdir(uploadDirectory, { mode: 0o700, recursive });
  }
  const stats = await fsp.lstat(uploadDirectory);
  if (stats.isSymbolicLink()) throw new Error(`Upload path must not be a symlink: ${uploadDirectory}`);
  if (isUnix() && typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`Upload directory is not owned by the current user: ${uploadDirectory}`);
  }
  await fsp.chmod(uploadDirectory, 0o700);
  const verifiedStats = await fsp.lstat(uploadDirectory);
  if (verifiedStats.isSymbolicLink()) throw new Error(`Upload path must not be a symlink: ${uploadDirectory}`);
  assertPrivateUploadDirectory(verifiedStats, uploadDirectory);
}

async function removeProcessUploadDirectory(uploadRootDirectory, uploadDirectory) {
  const rootStats = await fsp.lstat(uploadRootDirectory);
  if (rootStats.isSymbolicLink()) throw new Error(`Upload root must not be a symlink: ${uploadRootDirectory}`);
  assertPrivateUploadDirectory(rootStats, uploadRootDirectory);
  if (path.dirname(path.resolve(uploadDirectory)) !== path.resolve(uploadRootDirectory)
      || !PROCESS_UPLOAD_DIRECTORY_PATTERN.test(path.basename(uploadDirectory))) {
    throw new Error(`Refusing to remove an unrecognized upload directory: ${uploadDirectory}`);
  }
  const directoryStats = await fsp.lstat(uploadDirectory);
  if (directoryStats.isSymbolicLink()) throw new Error(`Upload entry must not be a symlink: ${uploadDirectory}`);
  if (!directoryStats.isDirectory()) throw new Error(`Upload path is not a directory: ${uploadDirectory}`);
  await fsp.rm(uploadDirectory, { recursive: true, force: true });
}

async function removeStaleUploads(uploadRootDirectory, ttlMs, now = Date.now()) {
  await ensureUploadDirectory(uploadRootDirectory, { recursive: true });
  const entries = await fsp.readdir(uploadRootDirectory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(uploadRootDirectory, entry.name);
    try {
      const stats = await fsp.lstat(entryPath);
      if (stats.isSymbolicLink()) throw new Error(`Upload entry must not be a symlink: ${entryPath}`);
      const isProcessDirectory = stats.isDirectory() && PROCESS_UPLOAD_DIRECTORY_PATTERN.test(entry.name);
      const isLegacyFile = stats.isFile() && LEGACY_UPLOAD_FILE_PATTERN.test(entry.name);
      if (stats.mtimeMs < now - ttlMs && (isProcessDirectory || isLegacyFile)) {
        await fsp.rm(entryPath, { recursive: isProcessDirectory, force: true });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }));
}

async function prepareUploadDirectory(uploadRootDirectory, uploadDirectory, ttlMs) {
  await removeStaleUploads(uploadRootDirectory, ttlMs);
  await ensureUploadDirectory(uploadDirectory);
}

async function pruneExpiredAttachments(attachments, expiry, removeFile = fsp.rm) {
  const expired = [...attachments.values()].filter((attachment) => attachment.createdAt < expiry);
  let removedBytes = 0;
  for (const attachment of expired) {
    await removeFile(attachment.path, { force: true });
    if (attachments.get(attachment.id) === attachment) {
      attachments.delete(attachment.id);
      removedBytes += attachment.size;
    }
  }
  return removedBytes;
}

async function readAttachment(req, timeoutMs) {
  const content = await readRequestBody(
    req,
    MAX_ATTACHMENT_BYTES,
    '附件不能超过 25 MB。',
    { timeoutMs },
  );
  if (content.length === 0) {
    throw new ApiError(400, 'Attachment body is empty', '请选择一个附件后再发送。');
  }
  const name = requestFileName(req);
  const attachmentType = detectAttachmentType(req.headers['content-type'], name, content);
  if (!attachmentType) {
    throw new ApiError(415, 'Unsupported attachment type', '仅支持 PNG、JPEG、GIF、WebP、PDF、TXT/MD/CSV/JSON、DOC/DOCX/XLS/XLSX 等文件。');
  }
  if (attachmentType.kind === 'image' && content.length > MAX_IMAGE_BYTES) {
    throw new ApiError(413, 'Image body too large', '图片不能超过 10 MB。');
  }

  return { attachmentType, content, name };
}

async function saveAttachment(uploadDirectory, { attachmentType, content, name }) {
  await ensureUploadDirectory(uploadDirectory, { create: false });
  const id = randomBytes(16).toString('hex');
  const filePath = path.join(uploadDirectory, `${id}.${attachmentType.extension}`);
  await fsp.writeFile(filePath, content, { encoding: null, mode: 0o600, flag: 'wx' });
  return {
    id,
    path: filePath,
    kind: attachmentType.kind,
    name,
    contentType: attachmentType.contentType,
    extension: attachmentType.extension,
    size: content.length,
    createdAt: Date.now(),
  };
}

function sanitizeAttachmentName(name) {
  const safeName = path.basename(String(name || '').replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  return safeName || 'attachment';
}

function buildImagePrompt(userText, attachmentPath, attachmentName = 'attachment') {
  const prompt = typeof userText === 'string' ? userText : '';
  return `Image path: ${attachmentPath} (original filename: ${sanitizeAttachmentName(attachmentName)})\n${prompt}`;
}

function buildAttachmentPrompt(userText, attachment) {
  if (attachment.kind === 'image') return buildImagePrompt(userText, attachment.path, attachment.name);
  const prompt = typeof userText === 'string' ? userText : '';
  return `File path: ${attachment.path} (original filename: ${sanitizeAttachmentName(attachment.name)})\n${prompt}`;
}

function buildAttachmentsPrompt(userText, attachments) {
  const prompt = typeof userText === 'string' ? userText : '';
  const paths = attachments.map((attachment) => (
    `${attachment.kind === 'image' ? 'Image' : 'File'} path: ${attachment.path} (original filename: ${sanitizeAttachmentName(attachment.name)})`
  ));
  if (prompt) paths.push(prompt);
  return paths.join('\n');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...POCKETMUX_API_HEADERS,
  });
  res.end(body);
}

function publicOutboxFile(file) {
  return {
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    extension: file.extension,
    size: file.size,
    createdAt: file.createdAt,
    viewedAt: file.viewedAt || null,
  };
}

function outboxApiError(error, id = '') {
  const code = error?.code || '';
  if (!['inbox_file_not_found', 'unsupported_file_type', 'source_file_missing'].includes(code)) {
    return error;
  }
  const notFound = code === 'inbox_file_not_found';
  return new ApiError(
    error.statusCode || (notFound ? 404 : 400),
    error.message,
    notFound ? '这个文件已经不存在或已过期。' : error.message,
    notFound ? 'This file is no longer available or has expired.' : error.message,
    { code: notFound ? 'inbox_file_not_found' : code },
  );
}

function streamOutboxFile(res, file) {
  const safeName = String(file.name || 'file').replace(/[\r\n"]/g, '_');
  const disposition = `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
  res.writeHead(200, {
    'Content-Type': file.contentType,
    'Content-Length': file.size,
    'Content-Disposition': disposition,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...POCKETMUX_API_HEADERS,
  });
  const stream = fs.createReadStream(file.path);
  stream.on('error', () => {
    if (!res.destroyed) res.destroy();
  });
  stream.pipe(res);
}

function sendText(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function authenticate(req, token) {
  const authorization = req.headers.authorization || '';
  return authorization === `Bearer ${token}`;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath);
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
  }[extension] || 'application/octet-stream';
}

async function serveStatic(res, pathname) {
  const files = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/i18n.js': 'i18n.js',
    '/app-helpers.js': 'app-helpers.js',
    '/app.js': 'app.js',
    '/styles.css': 'styles.css',
    '/favicon.ico': 'favicon.ico',
    '/assets/pocketmux-icon.png': 'assets/pocketmux-icon.png',
    '/assets/pocketmux-icon-32.png': 'assets/pocketmux-icon-32.png',
    '/assets/pocketmux-icon-180.png': 'assets/pocketmux-icon-180.png',
    '/assets/pocketmux-icon-192.png': 'assets/pocketmux-icon-192.png',
    '/assets/pocketmux-icon-512.png': 'assets/pocketmux-icon-512.png',
    '/assets/pocketmux-icon-maskable-512.png': 'assets/pocketmux-icon-maskable-512.png',
    '/manifest.webmanifest': 'manifest.webmanifest',
  };
  const fileName = files[pathname];
  if (!fileName) {
    sendText(res, 404, 'Not found\n', 'text/plain; charset=utf-8');
    return;
  }
  try {
    const filePath = path.join(PUBLIC_DIR, fileName);
    const body = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch (error) {
    sendText(res, 500, 'Static asset unavailable\n', 'text/plain; charset=utf-8');
  }
}

function routePath(pathname) {
  const parts = pathname.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  return parts;
}

function createRemoteToolServer({
  token = process.env.REMOTE_TOOL_TOKEN || randomBytes(24).toString('hex'),
  tmuxRunner = runTmux,
  uploadRootDirectory = UPLOAD_DIR,
  maxStoredAttachments = MAX_STORED_ATTACHMENTS,
  maxStoredAttachmentBytes = MAX_STORED_ATTACHMENT_BYTES,
  attachmentTtlMs = ATTACHMENT_TTL_MS,
  uploadReadTimeoutMs = UPLOAD_READ_TIMEOUT_MS,
  maxConcurrentUploadReads = MAX_CONCURRENT_UPLOAD_READS,
  removeUploadDirectory = removeProcessUploadDirectory,
  outboxDirectory = process.env.POCKETMUX_OUTBOX_DIR || OUTBOX_ROOT_DIRECTORY,
  outboxTtlMs = OUTBOX_TTL_MS,
} = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('A non-empty access token is required.');
  }

  const paneMutationQueues = new Map();
  const attachments = new Map();
  const uploadDirectory = path.join(
    uploadRootDirectory,
    `${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`,
  );
  const uploadDirectoryReady = prepareUploadDirectory(
    uploadRootDirectory,
    uploadDirectory,
    attachmentTtlMs,
  );
  let storedAttachmentBytes = 0;
  let activeUploadReads = 0;
  let attachmentMutationQueue = Promise.resolve();
  let attachmentCleanupPromise = null;
  const outboxDirectoryReady = ensureOutboxDirectory(outboxDirectory);
  const pruneAttachments = async () => {
    const expiry = Date.now() - attachmentTtlMs;
    storedAttachmentBytes -= await pruneExpiredAttachments(attachments, expiry);
  };
  const queueAttachmentMutation = (operation) => {
    const queued = attachmentMutationQueue.catch(() => undefined).then(operation);
    attachmentMutationQueue = queued;
    return queued;
  };
  const attachmentCleanupTimer = setInterval(() => {
    void queueAttachmentMutation(pruneAttachments)
      .catch((error) => console.error('[pocketmux] attachment cleanup failed', error));
  }, 60 * 60 * 1000);
  attachmentCleanupTimer.unref?.();
  const outboxCleanupTimer = setInterval(() => {
    void outboxDirectoryReady
      .then(() => pruneOutboxFiles(outboxDirectory, { ttlMs: outboxTtlMs }))
      .catch((error) => console.error('[pocketmux] inbox cleanup failed', error));
  }, 60 * 60 * 1000);
  outboxCleanupTimer.unref?.();

  const cleanupAttachments = () => {
    clearInterval(attachmentCleanupTimer);
    clearInterval(outboxCleanupTimer);
    if (attachmentCleanupPromise) return attachmentCleanupPromise;
    const cleanup = queueAttachmentMutation(async () => {
      await uploadDirectoryReady.catch(() => undefined);
      try {
        await removeUploadDirectory(uploadRootDirectory, uploadDirectory);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      attachments.clear();
      storedAttachmentBytes = 0;
    });
    attachmentCleanupPromise = cleanup.catch((error) => {
      attachmentCleanupPromise = null;
      throw error;
    });
    return attachmentCleanupPromise;
  };

  const queuePaneMutation = (paneId, operation) => {
    const previous = paneMutationQueues.get(paneId) || Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    const tracked = queued.finally(() => {
      if (paneMutationQueues.get(paneId) === tracked) paneMutationQueues.delete(paneId);
    });
    paneMutationQueues.set(paneId, tracked);
    return tracked;
  };

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = requestUrl.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name',
        'Access-Control-Allow-Methods': 'DELETE, GET, PATCH, POST, OPTIONS',
      });
      res.end();
      return;
    }

    try {
      if (!pathname.startsWith('/api/')) {
        await serveStatic(res, pathname);
        return;
      }

      if (!authenticate(req, token)) {
        sendJson(res, 401, {
          error: 'unauthorized',
          message: '需要访问令牌。',
          messageEn: 'An access token is required.',
        });
        return;
      }

      const parts = routePath(pathname);
      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'health') {
        sendJson(res, 200, {
          ok: true,
          product: 'pocketmux',
          protocolVersion: 1,
          now: new Date().toISOString(),
        });
        return;
      }

      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'sessions') {
        const sessions = await listSessions(tmuxRunner);
        sendJson(res, 200, { sessions, now: new Date().toISOString() });
        return;
      }

      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'inbox') {
        await outboxDirectoryReady;
        await pruneOutboxFiles(outboxDirectory, { ttlMs: outboxTtlMs });
        const files = await listOutboxFiles(outboxDirectory);
        sendJson(res, 200, {
          files,
          unreadCount: files.filter((file) => !file.viewedAt).length,
          now: new Date().toISOString(),
        });
        return;
      }

      if (parts.length === 3 && parts[1] === 'inbox') {
        const fileId = parts[2];
        if (!OUTBOX_ID_PATTERN.test(fileId)) {
          throw new ApiError(
            404,
            'Inbox file not found',
            '这个文件已经不存在或已过期。',
            'This file is no longer available or has expired.',
            { code: 'inbox_file_not_found' },
          );
        }
        await outboxDirectoryReady;
        if (req.method === 'GET') {
          try {
            const file = await getOutboxFile(outboxDirectory, fileId);
            streamOutboxFile(res, file);
          } catch (error) {
            throw outboxApiError(error, fileId);
          }
          return;
        }
      }

      if (parts.length === 4 && parts[1] === 'inbox' && parts[3] === 'ack') {
        const fileId = parts[2];
        if (!OUTBOX_ID_PATTERN.test(fileId)) {
          throw new ApiError(
            404,
            'Inbox file not found',
            '这个文件已经不存在或已过期。',
            'This file is no longer available or has expired.',
            { code: 'inbox_file_not_found' },
          );
        }
        await outboxDirectoryReady;
        if (req.method === 'POST') {
          try {
            const file = await acknowledgeOutboxFile(outboxDirectory, fileId);
            sendJson(res, 200, { ok: true, file: publicOutboxFile(file) });
          } catch (error) {
            throw outboxApiError(error, fileId);
          }
          return;
        }
      }

      if (parts.length === 3 && parts[1] === 'inbox' && req.method === 'DELETE') {
        const fileId = parts[2];
        if (!OUTBOX_ID_PATTERN.test(fileId)) {
          throw new ApiError(
            404,
            'Inbox file not found',
            '这个文件已经不存在或已过期。',
            'This file is no longer available or has expired.',
            { code: 'inbox_file_not_found' },
          );
        }
        await outboxDirectoryReady;
        const removed = await removeOutboxFile(outboxDirectory, fileId);
        if (!removed) {
          throw new ApiError(
            404,
            'Inbox file not found',
            '这个文件已经不存在或已过期。',
            'This file is no longer available or has expired.',
            { code: 'inbox_file_not_found' },
          );
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'uploads') {
        // Reading a potentially slow network body must not hold the shared
        // attachment mutation queue. Only quota checks and disk mutations are
        // serialized after the complete body has arrived.
        if (activeUploadReads >= maxConcurrentUploadReads) {
          drainRequest(req);
          throw new ApiError(
            429,
            'Too many concurrent uploads',
            '同时上传的附件过多，请稍后再试。',
            'Too many attachments are uploading at once. Try again shortly.',
          );
        }
        activeUploadReads += 1;
        let pendingAttachment;
        try {
          pendingAttachment = await readAttachment(req, uploadReadTimeoutMs);
        } finally {
          activeUploadReads -= 1;
        }
        const attachment = await queueAttachmentMutation(async () => {
          await uploadDirectoryReady;
          await pruneAttachments();
          if (attachments.size >= maxStoredAttachments) {
            throw new ApiError(
              429,
              'Attachment storage full',
              '临时附件数量已达到上限，请稍后再试。',
              'Temporary attachment storage has reached its file limit. Try again later.',
            );
          }
          if (storedAttachmentBytes + pendingAttachment.content.length > maxStoredAttachmentBytes) {
            throw new ApiError(
              413,
              'Attachment storage full',
              '临时附件总大小已达到上限，请稍后再试。',
              'Temporary attachment storage has reached its size limit. Try again later.',
            );
          }
          const savedAttachment = await saveAttachment(uploadDirectory, pendingAttachment);
          attachments.set(savedAttachment.id, savedAttachment);
          storedAttachmentBytes += savedAttachment.size;
          return savedAttachment;
        });
        sendJson(res, 201, {
          ok: true,
          attachmentId: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          contentType: attachment.contentType,
          extension: attachment.extension,
          size: attachment.size,
        });
        return;
      }

      // Keep the old route as a compatibility alias for tabs opened before
      // named panes were migrated to standalone zsh windows.
      if (req.method === 'POST' && parts.length === 2 && ['windows', 'panes'].includes(parts[1])) {
        const body = await readJsonBody(req);
        const paneId = typeof body.paneId === 'string' ? body.paneId : '';
        if (!isValidPaneId(paneId)) {
          throw new ApiError(400, 'Invalid pane id', '无效的 pane 标识。');
        }
        const name = normalizeWindowName(body.name);
        const created = await queuePaneMutation(paneId, () => createZshWindow(tmuxRunner, paneId, name));
        sendJson(res, 201, { ok: true, ...created });
        return;
      }

      if (req.method === 'DELETE' && parts.length === 3 && parts[1] === 'windows') {
        const paneId = parts[2];
        if (!isValidPaneId(paneId)) {
          throw new ApiError(400, 'Invalid pane id', '无效的 pane 标识。');
        }
        const deleted = await queuePaneMutation(paneId, () => deleteWindow(tmuxRunner, paneId));
        sendJson(res, 200, { ok: true, ...deleted });
        return;
      }

      if (req.method === 'PATCH' && parts.length === 3 && ['windows', 'panes'].includes(parts[1])) {
        const paneId = parts[2];
        if (!isValidPaneId(paneId)) {
          throw new ApiError(400, 'Invalid pane id', '无效的 pane 标识。');
        }
        const body = await readJsonBody(req);
        const name = normalizeWindowName(body.name);
        const renamed = await queuePaneMutation(paneId, () => renamePane(tmuxRunner, paneId, name));
        sendJson(res, 200, { ok: true, ...renamed });
        return;
      }

      if (parts.length >= 4 && parts[1] === 'panes') {
        const paneId = parts[2];
        const action = parts[3];
        if (req.method === 'GET' && action === 'output' && parts.length === 4) {
          const output = await capturePane(tmuxRunner, paneId, requestUrl.searchParams.get('lines'));
          sendJson(res, 200, {
            paneId,
            output,
            now: new Date().toISOString(),
          });
          return;
        }

        if (req.method === 'POST' && action === 'complete' && parts.length === 4) {
          const body = await readJsonBody(req);
          const text = validateZshCompletionText(body.text);
          await queuePaneMutation(paneId, () => completeZsh(tmuxRunner, paneId, text));
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'POST' && action === 'suggest' && parts.length === 4) {
          const body = await readJsonBody(req);
          const text = validateZshCompletionText(body.text);
          await queuePaneMutation(paneId, () => previewZsh(tmuxRunner, paneId, text));
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'POST' && action === 'input' && parts.length === 4) {
          const body = await readJsonBody(req);
          const text = typeof body.text === 'string' ? body.text : '';
          const submit = body.submit === true;
          if (text.length > MAX_INPUT_CHARS) {
            throw new ApiError(413, 'Input is too long', '单次输入不能超过 8000 个字符。');
          }
          const legacyAttachmentId = body.attachmentId;
          const requestedAttachmentIds = body.attachmentIds === undefined
            ? (legacyAttachmentId === undefined || legacyAttachmentId === null || legacyAttachmentId === ''
              ? []
              : [legacyAttachmentId])
            : body.attachmentIds;
          if (!Array.isArray(requestedAttachmentIds)) {
            throw new ApiError(400, 'Invalid attachment ids', '附件标识列表无效。');
          }
          if (requestedAttachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
            throw new ApiError(413, 'Too many attachments', `每条消息最多发送 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件。`);
          }
          if (requestedAttachmentIds.some((id) => typeof id !== 'string' || !ATTACHMENT_ID_PATTERN.test(id))) {
            throw new ApiError(400, 'Invalid attachment id', '附件标识无效。');
          }

          await queueAttachmentMutation(pruneAttachments);
          const messageAttachments = requestedAttachmentIds.map((id) => attachments.get(id) || null);
          if (messageAttachments.some((attachment) => !attachment)) {
            throw new ApiError(
              404,
              'Attachment not found',
              '部分附件已过期，请重新选择后再发送。',
              'Some attachments expired. Select them again before sending.',
              { code: 'attachment_not_found' },
            );
          }
          const combinedAttachmentBytes = messageAttachments.reduce((total, attachment) => total + attachment.size, 0);
          if (combinedAttachmentBytes > MAX_COMBINED_ATTACHMENT_BYTES) {
            throw new ApiError(413, 'Attachments too large', '每条消息的附件总大小不能超过 50 MB。');
          }

          const message = messageAttachments.length > 0
            ? buildAttachmentsPrompt(text, messageAttachments)
            : text;
          if (message.length > MAX_COMPOSED_INPUT_CHARS) {
            throw new ApiError(413, 'Composed input is too long', '附件提示词不能超过 8000 个字符。');
          }
          if (!message && !submit) {
            throw new ApiError(400, 'Input is empty', '请输入内容，或选择一个控制键。');
          }
          await queuePaneMutation(paneId, () => sendPaneInput(tmuxRunner, paneId, message, submit));
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'POST' && action === 'key' && parts.length === 4) {
          const body = await readJsonBody(req);
          await queuePaneMutation(paneId, async () => {
            await findPane(tmuxRunner, paneId);
            await sendKey(tmuxRunner, paneId, body.key);
          });
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      sendJson(res, 404, {
        error: 'not_found',
        message: '接口不存在。',
        messageEn: 'Endpoint not found.',
      });
    } catch (error) {
      if (req.aborted || res.destroyed) return;
      if (error instanceof ApiError) {
        sendJson(res, error.statusCode, {
          error: error.apiCode || error.name,
          code: error.apiCode || undefined,
          partial: error.partial || undefined,
          message: error.publicMessage,
          messageEn: error.publicMessageEn,
        });
        return;
      }
      console.error('[tmux-relay]', error);
      if (req.method === 'POST' && routePath(pathname).length === 2 && routePath(pathname)[1] === 'uploads') {
        sendJson(res, 500, {
          error: 'attachment_storage_error',
          code: 'attachment_storage_error',
          message: '附件暂存失败，请检查服务端临时目录权限后重试。',
          messageEn: 'The attachment could not be staged. Check the host temporary directory permissions and try again.',
        });
        return;
      }
      sendJson(res, 500, {
        error: 'server_error',
        code: 'server_error',
        message: 'tmux 操作失败，请确认服务所在电脑上的 tmux 仍在运行。',
        messageEn: 'The tmux operation failed. Make sure tmux is still running on the host computer.',
      });
    }
  });
  server.on('close', () => {
    void cleanupAttachments()
      .catch((error) => console.error('[pocketmux] attachment shutdown cleanup failed', error));
  });

  return {
    server,
    token,
    cleanup: cleanupAttachments,
    uploadDirectory,
    uploadDirectoryReady,
    outboxDirectory,
    outboxDirectoryReady,
  };
}

function networkAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces || []) {
      if ((address.family === 'IPv4' || address.family === 4) && !address.internal) {
        addresses.push(address.address);
      }
    }
  }
  return [...new Set(addresses)];
}

function start() {
  const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  const host = process.env.HOST || '0.0.0.0';
  const { server, token, cleanup } = createRemoteToolServer();
  server.listen(port, host, () => {
    const addresses = networkAddresses();
    console.log(`pocketmux listening on ${host}:${port}`);
    console.log(`Access token: ${token}`);
    if (addresses.length > 0) {
      console.log('Open on your phone:');
      for (const address of addresses) {
        console.log(`  http://${address}:${port}/?token=${token}`);
      }
    } else {
      console.log(`Open on this computer: http://127.0.0.1:${port}/?token=${token}`);
    }
    console.log('Security: keep this port on a trusted LAN or use Tailscale/SSH; do not expose it directly to the public internet.');
  });

  const shutdown = () => server.close(async () => {
    await cleanup();
    process.exit(0);
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = {
  ALLOWED_KEYS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_COMBINED_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_STORED_ATTACHMENTS,
  MAX_STORED_ATTACHMENT_BYTES,
  ATTACHMENT_TTL_MS,
  UPLOAD_DIR,
  OUTBOX_ROOT_DIRECTORY,
  OUTBOX_TTL_MS,
  PANE_FORMAT,
  SESSION_FORMAT,
  buildAttachmentPrompt,
  buildAttachmentsPrompt,
  buildImagePrompt,
  buildSessionTree,
  createRemoteToolServer,
  detectAttachmentType,
  detectImageType,
  isAllowedKey,
  isCodexPane,
  parsePaneRows,
  parseSessionRows,
  pruneExpiredAttachments,
  readRequestBody,
  removeStaleUploads,
  renamePane,
  runTmux,
};
