import assert from 'node:assert/strict';
import test from 'node:test';

import { detectPlatform, getPlatformPolicy } from '../src/platform.js';

test('detects Android, iPhone, and iPad user agents', () => {
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 16)' }).isAndroid, true);
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' }).isIOS, true);
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0)' }).isIPad, true);
});

test('detects iPad desktop mode without treating a Mac as iOS', () => {
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 5 }).isIPad, true);
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 }).isIOS, false);
});

test('requires HTTPS for mobile direct connections while desktop remains configurable', () => {
  assert.equal(getPlatformPolicy({ userAgent: 'Mozilla/5.0 (iPhone)' }).allowPrivateHttp, false);
  assert.equal(getPlatformPolicy({ userAgent: 'Mozilla/5.0 (Linux; Android 16)' }).allowPrivateHttp, false);
  assert.equal(getPlatformPolicy({ userAgent: 'Mozilla/5.0 (Macintosh)' }).allowPrivateHttp, true);
});
