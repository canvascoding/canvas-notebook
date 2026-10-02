import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

import { closeDatabaseConnections, getDatabaseProvider, openDb, type SqlConnection } from '../../app/lib/db';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterTransaction } from '../../app/lib/file-version-center/database';

export type IsolatedFileVersionTestDatabase = {
  query: <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  exec: (sql: string) => Promise<unknown>;
  transaction: <T>(action: (transaction: FileVersionCenterTransaction) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

type DatabaseIdentity = { name: string; oid: string; owner: string; role: string };

/** Default: memory only. Native PostgreSQL requires the private isolated wrapper. */
export async function createIsolatedFileVersionTestDatabase(): Promise<IsolatedFileVersionTestDatabase> {
  if (process.env.CANVAS_FILE_VERSION_POSTGRES_TEST !== '1') return new PGlite();
  assert.equal(process.env.NODE_ENV, 'test', 'Native file version fixtures require NODE_ENV=test.');
  assert.equal(getDatabaseProvider(), 'postgres');
  assert(process.env.DATABASE_URL, 'An explicit isolated PostgreSQL URL is required.');
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55433');
  assert.equal(url.search, '', 'Connection query overrides are not allowed.');
  assert.match(url.pathname, /^\/canvas_editor_test_[a-f0-9]{16}$/u);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  const data = process.env.DATA;
  assert(data && path.isAbsolute(data), 'The private isolated DATA directory is required.');
  const realData = await fs.realpath(data);
  assert.equal(path.dirname(realData), await fs.realpath(os.tmpdir()));
  assert.match(path.basename(realData), /^canvas-yjs-pg-[A-Za-z0-9]{6}$/u);
  const dataStat = await fs.stat(realData);
  assert(dataStat.isDirectory() && (dataStat.mode & 0o777) === 0o700, 'Isolated DATA must be private.');
  assert.equal(dataStat.uid, process.getuid?.());
  let identity: DatabaseIdentity | null = null;

  const verify = async (queryable: FileVersionCenterTransaction) => {
    const row = (await queryable.query<DatabaseIdentity>(`SELECT current_database() AS name,
      database.oid::text AS oid, pg_get_userbyid(database.datdba) AS owner, current_user AS role
      FROM pg_database database WHERE database.datname=current_database()`)).rows[0];
    assert(row && row.name === url.pathname.slice(1) && row.role === decodeURIComponent(url.username)
      && row.owner === row.role && /^[1-9][0-9]*$/u.test(row.oid), 'The live isolated database identity is invalid.');
    if (identity) assert.deepEqual(row, identity, 'The isolated database was replaced or changed ownership.');
    else identity = row;
  };
  const withConnection = async <T>(action: (connection: SqlConnection) => Promise<T>): Promise<T> => {
    const connection = await openDb();
    try {
      await verify({ query: async <Row>(sql: string, params?: unknown[]) => ({
        rows: await connection.all(sql, params) as Row[],
      }) });
      return await action(connection);
    } finally { await connection.close(); }
  };
  try {
    await withConnection(async connection => {
      const row = await connection.get('SELECT COUNT(*)::text AS count FROM "user"') as { count: string };
      assert.equal(row.count, '0', 'Native fixtures require a fresh empty user table.');
    });
  } catch (error) {
    await closeDatabaseConnections();
    throw error;
  }
  const runtime = createRuntimeFileVersionCenterDatabase();
  return {
    query: <Row>(sql: string, params?: unknown[]) => withConnection(async connection => ({
      rows: await connection.all(sql, params) as Row[],
    })),
    exec: sql => withConnection(async connection => connection.run(sql)),
    transaction: action => runtime.transaction(async transaction => {
      await verify(transaction);
      return action(transaction);
    }),
    close: closeDatabaseConnections,
  };
}
