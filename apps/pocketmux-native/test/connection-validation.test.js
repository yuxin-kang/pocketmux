import assert from 'node:assert/strict';
import test from 'node:test';

import { createConnectionValidationTracker } from '../src/connection-validation.js';

test('keeps a validation current across unrelated server switches', () => {
  const tracker = createConnectionValidationTracker();
  const first = tracker.begin('https://first.example/');
  const second = tracker.begin('https://second.example/');

  assert.equal(tracker.isCurrent(first), true);
  assert.equal(tracker.isCurrent(second), true);
});

test('supersedes only an older validation attempt for the same server', () => {
  const tracker = createConnectionValidationTracker();
  const first = tracker.begin('https://first.example/');
  const replacement = tracker.begin('https://first.example/');

  assert.equal(tracker.isCurrent(first), false);
  assert.equal(tracker.isCurrent(replacement), true);
});
