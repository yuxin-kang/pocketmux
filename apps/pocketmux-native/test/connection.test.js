import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConnection,
  isInsecureServer,
  isPrivateLanHost,
  normalizeRecentServers,
  requireAccessToken,
  rememberServer,
  removeRememberedServer,
} from '../src/connection.js';

test('extracts a Pocketmux token from a complete tunnel URL without persisting it in the server URL', () => {
  const connection = buildConnection('https://demo.trycloudflare.com/?token=secret-value');
  assert.equal(connection.serverUrl, 'https://demo.trycloudflare.com/');
  assert.equal(connection.targetUrl, 'https://demo.trycloudflare.com/?token=secret-value');
  assert.equal(connection.hasToken, true);
});

test('prefers an explicitly entered token and defaults a bare host to HTTPS', () => {
  const connection = buildConnection('demo.example.com/?token=old', 'new token');
  assert.equal(connection.serverUrl, 'https://demo.example.com/');
  assert.equal(connection.targetUrl, 'https://demo.example.com/?token=new+token');
});

test('requires authentication before the native shell opens a remote page', () => {
  assert.throws(
    () => requireAccessToken(buildConnection('https://demo.example.com/')),
    /missing-token/,
  );
  assert.equal(
    requireAccessToken(buildConnection('https://demo.example.com/?token=secret')).hasToken,
    true,
  );
});

test('preserves a reverse-proxy base path while removing token-bearing query data', () => {
  const connection = buildConnection('https://example.com/tools/pocketmux?token=secret#terminal');

  assert.equal(connection.serverUrl, 'https://example.com/tools/pocketmux/');
  assert.equal(connection.targetUrl, 'https://example.com/tools/pocketmux/?token=secret');
});

test('rejects unsupported protocols and embedded credentials', () => {
  assert.throws(() => buildConnection('ftp://example.com'), /unsupported-url/);
  assert.throws(() => buildConnection('https://user:pass@example.com'), /unsupported-url/);
  assert.throws(() => buildConnection('   '), /invalid-url/);
});

test('allows cleartext HTTP only for local, private-LAN, and Tailscale addresses', () => {
  assert.equal(isInsecureServer(buildConnection('http://192.168.1.5:3789').serverUrl), true);
  assert.equal(buildConnection('http://192.168.1.20:3789').serverUrl, 'http://192.168.1.20:3789/');
  assert.equal(buildConnection('http://100.64.1.2:3789').serverUrl, 'http://100.64.1.2:3789/');
  assert.equal(buildConnection('http://pocketmux.local:3789').serverUrl, 'http://pocketmux.local:3789/');
  assert.equal(buildConnection('http://[fd00::1]:3789').serverUrl, 'http://[fd00::1]:3789/');
  assert.equal(isInsecureServer(buildConnection('https://pocketmux.example.com').serverUrl), false);
});

test('rejects public cleartext HTTP without confusing public domains for private IPv6', () => {
  assert.throws(() => buildConnection('http://example.com'), /public-http/);
  assert.throws(() => buildConnection('http://fc-example.com'), /public-http/);
  assert.throws(() => buildConnection('http://8.8.8.8'), /public-http/);
  assert.equal(isPrivateLanHost('fd00::5'), true);
  assert.equal(isPrivateLanHost('fc-example.com'), false);
});

test('rejects the reserved Tauri application host for both schemes', () => {
  assert.throws(() => buildConnection('http://tauri.localhost'), /native-origin/);
  assert.throws(() => buildConnection('https://tauri.localhost'), /native-origin/);
});

test('can enforce an HTTPS-only platform policy after private-host validation', () => {
  assert.throws(
    () => buildConnection('http://192.168.1.5:3789', '', { allowPrivateHttp: false }),
    /android-http/,
  );
  assert.equal(
    buildConnection('https://pocketmux.example.com', '', { allowPrivateHttp: false }).serverUrl,
    'https://pocketmux.example.com/',
  );
});

test('stores at most five unique recent server URLs and never stores tokens', () => {
  let recent = [];
  for (let index = 0; index < 7; index += 1) {
    recent = rememberServer(recent, `https://server-${index}.example/?token=secret-${index}`);
  }
  assert.equal(recent.length, 5);
  assert.deepEqual(recent.slice(0, 2), [
    'https://server-6.example/',
    'https://server-5.example/',
  ]);
  assert.equal(recent.some((item) => item.includes('token')), false);
  assert.deepEqual(normalizeRecentServers([...recent, recent[0], 'bad url']), recent);
});

test('removes a remembered server using its normalized address', () => {
  const recent = ['https://one.example/', 'https://two.example/'];
  assert.deepEqual(removeRememberedServer(recent, 'two.example'), ['https://one.example/']);
});
