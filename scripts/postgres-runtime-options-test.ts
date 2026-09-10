import assert from 'node:assert/strict';

import { resolvePostgresRuntimeOptions } from '../app/lib/db/postgres-runtime-options';

assert.deepEqual(resolvePostgresRuntimeOptions({}), {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
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
  connectionTimeoutMillis: 3_000,
});

console.log('PostgreSQL runtime option checks passed.');
