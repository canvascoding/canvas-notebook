import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Pool, type PoolConfig } from 'pg';
import { postgresFailureCode } from '../app/lib/db/postgres-diagnostics';
import { resolvePostgresRuntimeOptions } from '../app/lib/db/postgres-runtime-options';
import { evaluateIsolatedModule, sourceFunction } from './helpers/isolated-source-module';

// Exercise pg-pool's actual idle/error/remove/query behavior with only its
// network client replaced. No database credentials or external connections.
class ReadyClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(callback: (error: Error | null) => void) { queueMicrotask(() => callback(null)); }
  end(callback?: () => void) { this._ending = true; this.emit('end'); callback?.(); }
  query(sql: string, _values: unknown, callback: (error: Error | null, result?: unknown) => void) {
    queueMicrotask(() => {
      if (sql === 'FAIL') callback(new Error('original query failure'));
      else callback(null, { rows: [{ ok: 1 }], rowCount: 1 });
    });
  }
  ref() {}
  unref() {}
}

async function main() {
  assert.equal(postgresFailureCode(new Error('Connection terminated due to connection timeout')), 'postgres_connection_timeout');
  assert.equal(postgresFailureCode(new Error('timeout exceeded when trying to connect')), 'postgres_pool_wait_timeout');
  assert.equal(postgresFailureCode(new Error('SQL and private parameters', {
    cause: new Error('Connection terminated due to connection timeout'),
  })), 'postgres_connection_timeout');
  assert.equal(postgresFailureCode(Object.assign(new Error('private connection details'), { code: 'ECONNRESET' })), 'postgres_unavailable');
  assert.equal(postgresFailureCode(new Error('postgres://user:private@host')), 'unknown');
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(postgresFailureCode(cyclic), 'unknown');

  const logs: unknown[][] = [];
  let failLogging = false;
  class FixturePool extends Pool {
    constructor(options: PoolConfig) { super({ ...options, Client: ReadyClient } as PoolConfig); }
  }
  const { createPostgresPool } = evaluateIsolatedModule<{ createPostgresPool: () => Pool }>(sourceFunction('app/lib/db/postgres.ts', 'createPostgresPool'), {}, {
    Pool: FixturePool, randomUUID, postgresFailureCode,
    configurePgTypeParsers: () => {}, resolvePostgresRuntimeOptions: () => resolvePostgresRuntimeOptions({}),
    process: { env: { DATABASE_URL: 'postgresql://fixture:private@127.0.0.1/fixture' }, pid: process.pid },
    console: { error: (...args: unknown[]) => { if (failLogging) throw new Error('logger failed'); logs.push(args); } },
  });
  const pool = createPostgresPool();
  try {
    assert.equal(pool.listenerCount('error'), 1);
    const client = await pool.connect();
    client.release();
    assert.equal(pool.idleCount, 1);
    client.emit('error', Object.assign(new Error('postgres://private secret SQL'), { code: 'ECONNRESET' }));
    assert.equal(pool.totalCount, 0, 'pg must remove the failed idle client exactly once');
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /private|secret SQL|postgres:\/\//);
    assert.equal((logs[0][1] as { errorCode: string }).errorCode, 'postgres_unavailable');
    assert.deepEqual((await pool.query('SELECT 1')).rows, [{ ok: 1 }]);
    assert.equal(pool.idleCount, 1, 'the pool must create a replacement connection');
    await assert.rejects(pool.query('FAIL'), /original query failure/, 'active query failures must still reject');
    const next = await pool.connect();
    next.release();
    failLogging = true;
    assert.doesNotThrow(() => next.emit('error', new Error('idle error despite broken logger')));
    assert.equal(pool.totalCount, 0);
  } finally {
    await pool.end();
  }
  console.log('PostgreSQL pool errors: idle removal/recovery, preserved query failures, safe codes and defensive logging passed.');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
