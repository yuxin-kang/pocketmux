import assert from 'node:assert/strict';
import test from 'node:test';

import { NEW_SERVER_TARGET, planConnectionSwitch } from '../src/connection-switch.js';

test('switches directly when the selected server has a saved authenticated target', () => {
  const authenticatedTargets = new Map([
    ['https://second.example/', 'https://second.example/?token=saved-token'],
  ]);

  assert.deepEqual(
    planConnectionSwitch('https://second.example/', authenticatedTargets),
    {
      type: 'connect',
      serverUrl: 'https://second.example/',
      targetUrl: 'https://second.example/?token=saved-token',
    },
  );
});

test('historical and new servers return to authentication without inventing a token', () => {
  assert.deepEqual(
    planConnectionSwitch('https://history.example/', new Map()),
    { type: 'authenticate', serverUrl: 'https://history.example/' },
  );
  assert.deepEqual(
    planConnectionSwitch(NEW_SERVER_TARGET, new Map()),
    { type: 'authenticate', serverUrl: '' },
  );
  assert.deepEqual(planConnectionSwitch('', new Map()), { type: 'none' });
});
