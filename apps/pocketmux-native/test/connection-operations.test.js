import assert from 'node:assert/strict';
import test from 'node:test';

import { createConnectionOperationTracker } from '../src/connection-operations.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('ignores validation results from an older connection after a switch', async () => {
  const tracker = createConnectionOperationTracker();
  const firstResult = deferred();
  const secondResult = deferred();
  const applied = [];

  const applyWhenCurrent = async (operation, pending, label) => {
    await pending;
    if (tracker.isCurrent(operation)) applied.push(label);
  };

  const first = tracker.begin();
  const firstTask = applyWhenCurrent(first, firstResult.promise, 'first');
  const second = tracker.begin();
  const secondTask = applyWhenCurrent(second, secondResult.promise, 'second');

  secondResult.resolve();
  await secondTask;
  firstResult.resolve();
  await firstTask;

  assert.deepEqual(applied, ['second']);
  assert.equal(tracker.current(), second);
});
