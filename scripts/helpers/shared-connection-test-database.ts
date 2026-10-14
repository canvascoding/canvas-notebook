import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../app/lib/db/schema';
import { createPostgresPool, runPostgresMigrations } from '../../app/lib/db/postgres';
import type { SqlConnection } from '../../app/lib/db';
import { createPiTestDatabase } from './pi-test-database';

/** Native mode creates and drops only its nonce database on the existing managed local PostgreSQL. */
export async function createSharedConnectionTestDatabase() {
  if (process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST !== '1') return { ...await createPiTestDatabase(), native: false };
  assert.equal(process.env.NODE_ENV, 'test');
  const localUrl = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(localUrl.hostname, '127.0.0.1'); assert.equal(localUrl.port, '55433');
  assert.equal(localUrl.search, '');
  const name = `canvas_connection_test_${randomUUID().replace(/-/gu, '')}`;
  assert.match(name, /^canvas_connection_test_[a-f0-9]{32}$/u);
  const administration = new Pool({ connectionString: localUrl.toString(), max: 1 });
  let created = false;
  const testUrl = new URL(localUrl); testUrl.pathname = `/${name}`;
  // Use the actual runtime bootstrap, including its INT8 timestamp parser.
  // This synchronous constructor never connects before the nonce URL is set;
  // restore the caller's maintenance URL before any asynchronous work resumes.
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousPoolMax = process.env.CANVAS_POSTGRES_POOL_MAX;
  let pool: Pool;
  try {
    process.env.DATABASE_URL = testUrl.toString();
    process.env.CANVAS_POSTGRES_POOL_MAX = '8';
    pool = createPostgresPool();
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousPoolMax === undefined) delete process.env.CANVAS_POSTGRES_POOL_MAX;
    else process.env.CANVAS_POSTGRES_POOL_MAX = previousPoolMax;
  }
  const cleanup = async () => {
    await pool.end();
    try {
      if (created) {
        const identity = (await administration.query('SELECT pg_get_userbyid(datdba) AS owner,current_user AS role FROM pg_database WHERE datname=$1', [name])).rows[0];
        assert(identity && identity.owner === identity.role);
        await administration.query(`DROP DATABASE "${name}"`);
        created = false;
      }
    } finally { await administration.end(); }
  };
  try {
    await administration.query(`CREATE DATABASE "${name}"`); created = true;
    await runPostgresMigrations(pool as unknown as Parameters<typeof runPostgresMigrations>[0]);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM "user"')).rows[0].count, 0);
  } catch (error) { await cleanup(); throw error; }
  return { native: true, db: drizzle(pool, { schema }), getDatabaseProvider: () => 'postgres',
    getPostgresRuntimeQueryable: () => pool, getDatabaseInitializationError: () => null,
    ensureDatabaseReady: async () => {}, assertDatabaseAvailable: () => {},
    openDb: async (): Promise<SqlConnection> => {
      const client = await pool.connect();
      return { get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
        all: async (sql, params = []) => (await client.query(sql, params)).rows,
        run: async (sql, params = []) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
        close: (error?: Error) => client.release(error) };
    }, close: cleanup };
}
