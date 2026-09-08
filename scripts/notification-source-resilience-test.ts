import assert from 'node:assert/strict';

import { settleNotificationSource } from '../app/lib/notifications/source-resilience';

async function main() {
  const available = await settleNotificationSource(Promise.resolve(['notification']), [] as string[]);
  assert.deepEqual(available, {
    value: ['notification'],
    status: { available: true },
  });

  const unavailable = await settleNotificationSource(Promise.reject(new Error('database unavailable')), [] as string[]);
  assert.deepEqual(unavailable, {
    value: [],
    status: { available: false, errorCode: 'source_unavailable' },
  });

  console.log('notification-source-resilience-test: ok');
}

void main();
