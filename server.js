'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// tmux escapes other control characters such as 0x1f as the literal text
// "\\037". A tab is emitted verbatim by tmux 3.x and is not valid in the
// session/window/pane metadata we expose.
const DELIMITER = '\t';
const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_OUTPUT_LINES = 240;
const MAX_OUTPUT_LINES = 600;
const DEFAULT_PORT = 3789;

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
  constructor(statusCode, message, publicMessage = message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
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
  return parseRows(output, 14).map(([
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

function isAllowedKey(value) {
  return ALLOWED_KEYS.has(value);
}

async function findPane(tmuxRunner, paneId) {
  if (!isValidPaneId(paneId)) {
    throw new ApiError(400, 'Invalid pane id', '无效的 pane 标识。');
  }
  const panes = parsePaneRows(await tmuxRunner(['list-panes', '-a', '-F', PANE_FORMAT]));
  const pane = panes.find((candidate) => candidate.id === paneId);
  if (!pane) {
    throw new ApiError(404, 'Pane not found', '这个 pane 已经不存在，可能被关闭了。');
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

async function sendKey(tmuxRunner, paneId, key) {
  if (!isAllowedKey(key)) {
    throw new ApiError(400, 'Key is not allowed', '这个控制键不在允许列表中。');
  }
  await tmuxRunner(['send-keys', '-t', paneId, key]);
}

async function cancelPaneMode(tmuxRunner, pane) {
  if (!pane.inMode || !['copy-mode', 'view-mode'].includes(pane.mode)) return;
  await tmuxRunner(['send-keys', '-X', '-t', pane.id, 'cancel']);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'Request body too large', '输入内容太长了。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new ApiError(400, 'Invalid JSON body', '请求内容格式不正确。'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
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
    '.webmanifest': 'application/manifest+json; charset=utf-8',
  }[extension] || 'application/octet-stream';
}

async function serveStatic(res, pathname) {
  const files = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/styles.css': 'styles.css',
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
      'Cache-Control': 'no-cache',
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
} = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('A non-empty access token is required.');
  }

  const paneMutationQueues = new Map();
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
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
        sendJson(res, 401, { error: 'unauthorized', message: '需要访问令牌。' });
        return;
      }

      const parts = routePath(pathname);
      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'health') {
        sendJson(res, 200, { ok: true, now: new Date().toISOString() });
        return;
      }

      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'sessions') {
        const sessions = await listSessions(tmuxRunner);
        sendJson(res, 200, { sessions, now: new Date().toISOString() });
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

        if (req.method === 'POST' && action === 'input' && parts.length === 4) {
          const body = await readJsonBody(req);
          const text = typeof body.text === 'string' ? body.text : '';
          const submit = body.submit === true;
          if (text.length > 8000) {
            throw new ApiError(413, 'Input is too long', '单次输入不能超过 8000 个字符。');
          }
          if (!text && !submit) {
            throw new ApiError(400, 'Input is empty', '请输入内容，或选择一个控制键。');
          }
          await queuePaneMutation(paneId, async () => {
            const pane = await findPane(tmuxRunner, paneId);
            await cancelPaneMode(tmuxRunner, pane);
            if (text) await pasteText(tmuxRunner, paneId, text);
            if (submit) await sendKey(tmuxRunner, paneId, 'Enter');
          });
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

      sendJson(res, 404, { error: 'not_found', message: '接口不存在。' });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.statusCode, { error: error.name, message: error.publicMessage });
        return;
      }
      console.error('[tmux-relay]', error);
      sendJson(res, 500, {
        error: 'server_error',
        message: 'tmux 操作失败，请确认服务所在电脑上的 tmux 仍在运行。',
      });
    }
  });

  return { server, token };
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
  const { server, token } = createRemoteToolServer();
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

  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = {
  ALLOWED_KEYS,
  PANE_FORMAT,
  SESSION_FORMAT,
  buildSessionTree,
  createRemoteToolServer,
  isAllowedKey,
  isCodexPane,
  parsePaneRows,
  parseSessionRows,
  runTmux,
};
