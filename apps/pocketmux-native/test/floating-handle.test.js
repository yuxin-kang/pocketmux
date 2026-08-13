import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampHandleCenter,
  handlePositionRatio,
  hasHandleMoved,
  normalizeHandlePosition,
} from '../src/floating-handle.js';

test('normalizes a persisted floating handle position', () => {
  assert.equal(normalizeHandlePosition('0.65'), 0.65);
  assert.equal(normalizeHandlePosition('-1'), 0);
  assert.equal(normalizeHandlePosition('2'), 1);
  assert.equal(normalizeHandlePosition('invalid'), 0.42);
});

test('keeps the handle inside the visible container margins', () => {
  assert.equal(clampHandleCenter(0, 800, 58, 12), 41);
  assert.equal(clampHandleCenter(400, 800, 58, 12), 400);
  assert.equal(clampHandleCenter(900, 800, 58, 12), 759);
  assert.equal(clampHandleCenter(100, 40, 58, 12), 20);
});

test('stores position as a container-relative ratio', () => {
  assert.equal(handlePositionRatio(400, 800), 0.5);
  assert.equal(handlePositionRatio(400, 0), 0.42);
});

test('distinguishes a tap from an intentional drag', () => {
  assert.equal(hasHandleMoved(10, 10, 13, 14), false);
  assert.equal(hasHandleMoved(10, 10, 16, 10), true);
});
