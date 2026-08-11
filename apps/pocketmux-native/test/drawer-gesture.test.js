import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldBeginDrawerSwipe } from '../src/drawer-gesture.js';

test('drawer swipe handling never captures taps that begin on controls', () => {
  const control = { closest: () => ({ tagName: 'BUTTON' }) };
  const surface = { closest: () => null };

  assert.equal(shouldBeginDrawerSwipe(control), false);
  assert.equal(shouldBeginDrawerSwipe(surface), true);
});
