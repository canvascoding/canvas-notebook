import assert from 'node:assert/strict';

import { resolvePostgresRuntimeOptions } from '../app/lib/db/postgres-runtime-options';

assert.deepEqual(resolvePostgresRuntimeOptions({}), {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 0,
});

assert.deepEqual(resolvePostgresRuntimeOptions({
  CANVAS_POSTGRES_POOL_MAX: '4',
  CANVAS_POSTGRES_IDLE_TIMEOUT_MS: '15000',
  CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS: '1250',
}), {
  max: 4,
  idleTimeoutMillis: 15_000,
  connectionTimeoutMillis: 1_250,
});

assert.deepEqual(resolvePostgresRuntimeOptions({
  CANVAS_POSTGRES_POOL_MAX: '0',
  CANVAS_POSTGRES_IDLE_TIMEOUT_MS: 'invalid',
  CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS: '-1',
}), {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 0,
});

for (const value of [undefined, '', '0', ' 0 ', '-1', 'invalid']) {
  assert.equal(resolvePostgresRuntimeOptions({
    CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS: value,
  }).connectionTimeoutMillis, 0, `connection timeout ${JSON.stringify(value)} must use the pg default`);
}

for (const [value, expected] of [['3000', 3_000], ['15000', 15_000], ['60000', 60_000], ['90000', 60_000]] as const) {
  assert.equal(resolvePostgresRuntimeOptions({
    CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS: value,
  }).connectionTimeoutMillis, expected);
}

assert.deepEqual(resolvePostgresRuntimeOptions({
  CANVAS_POSTGRES_POOL_MAX: '101',
  CANVAS_POSTGRES_IDLE_TIMEOUT_MS: '3600001',
  CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS: '0',
}), { max: 100, idleTimeoutMillis: 3_600_000, connectionTimeoutMillis: 0 });

console.log('PostgreSQL runtime option checks passed.');
