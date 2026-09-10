import assert from 'node:assert/strict';

import {
  createCachedAsyncCheck,
  HealthCheckTimeoutError,
  withHealthCheckTimeout,
} from '../app/lib/health/async-check';

async function main(): Promise<void> {
  let loads = 0;
  let resolveLoad: ((value: string) => void) | undefined;
  const cachedCheck = createCachedAsyncCheck(
    () => {
      loads += 1;
      return new Promise<string>((resolve) => {
        resolveLoad = resolve;
      });
    },
    1_000,
  );

  const first = cachedCheck();
  const second = cachedCheck();
  assert.equal(loads, 1, 'concurrent checks must share one in-flight operation');
  resolveLoad?.('ready');
  assert.deepEqual(await Promise.all([first, second]), ['ready', 'ready']);
  assert.equal(await cachedCheck(), 'ready');
  assert.equal(loads, 1, 'successful checks must be cached');

  await assert.rejects(
    withHealthCheckTimeout('stalled check', new Promise(() => undefined), 20),
    HealthCheckTimeoutError,
  );

  assert.equal(await withHealthCheckTimeout('fast check', Promise.resolve('ok'), 20), 'ok');
  console.log('Health async check checks passed.');
}

void main();
