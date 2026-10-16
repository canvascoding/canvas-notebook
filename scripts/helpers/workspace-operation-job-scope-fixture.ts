import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { parse } from 'dotenv';
import { Client, Pool, type PoolClient } from 'pg';
import type { SqlConnection } from '../../app/lib/db';

type Row = Record<string, unknown>;
type Result<T> = { rows: T[]; affectedRows?: number; rowCount?: number | null };
type Fixture = {
  query<T extends Row = Row>(sql: string, values?: unknown[]): Promise<Result<T>>;
  exec(sql: string): Promise<unknown>;
  connect(): Promise<SqlConnection>;
  close(): Promise<void>;
};

/** The exact worker assertions can use embedded SQL or an explicitly selected,
 * owned real PG18 schema. Neither backend models genuine request/agent ACLs. */
export async function createWorkspaceOperationJobScopeFixture(): Promise<Fixture> {
  const sources = ['scripts/workspace-operation-direct-worker-test.ts',
    'scripts/helpers/workspace-operation-job-scope-fixture.ts'];
  const hashes = async () => Promise.all(sources.map(async source => createHash('sha256')
    .update(await readFile(path.resolve(source))).digest('hex')));
  const pinned = await hashes();
  console.log('Direct worker frozen source pins:', JSON.stringify(Object.fromEntries(sources.map((name, index) => [name, pinned[index]]))));
  if (process.env.CANVAS_WORKSPACE_JOB_SCOPE_PG !== '1') {
    const postgres = new PGlite();
    return {
      query: (sql, values) => postgres.query(sql, values), exec: sql => postgres.exec(sql),
      connect: async () => ({
        get: async (sql, values) => (await postgres.query(sql, values)).rows[0],
        all: async (sql, values) => (await postgres.query(sql, values)).rows,
        run: (sql, values) => postgres.query(sql, values), close: () => undefined,
      }),
      close: async () => {
        await postgres.close(); assert.deepEqual(await hashes(), pinned);
        console.log('Direct worker SQL fixture cleanup:', JSON.stringify({ engine: 'PGlite', closed: true }));
      },
    };
  }

  assert.equal(process.env.NODE_ENV, 'test');
  const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment)).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `job_scope_${randomUUID().replaceAll('-', '')}`, nonce = randomUUID();
  assert.match(schema, /^job_scope_[a-f0-9]{32}$/u);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5_000,
    options: '-c statement_timeout=10000 -c lock_timeout=1000' });
  const checkedOut = new Set<PoolClient>();
  let pool: Pool | undefined, created = false, schemaOid = 0, connected = false;
  const ownSchema = async () => {
    const row = (await control.query(`SELECT oid,obj_description(oid,'pg_namespace') AS marker,
      nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
    assert(row); assert.equal(Number(row.oid), schemaOid); assert.equal(row.marker, nonce); assert.equal(row.owner, true);
  };
  const cleanup = async () => {
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(async () => assert.equal(checkedOut.size, 0));
    if (checkedOut.size) for (const client of checkedOut) { client.release(new Error('Discarding leaked owned fixture client.')); checkedOut.delete(client); }
    if (pool) await attempt(() => pool!.end());
    let schemaRemoved = !created;
    if (created) await attempt(async () => {
      await ownSchema(); await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      schemaRemoved = (await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed;
      assert.equal(schemaRemoved, true);
    });
    if (connected) await attempt(() => control.end());
    await attempt(async () => assert.deepEqual(await hashes(), pinned));
    console.log('Direct worker SQL fixture cleanup:', JSON.stringify({ engine: 'PostgreSQL18', schemaRemoved, openClients: checkedOut.size }));
    if (failures.length) throw new AggregateError(failures, 'Owned direct worker SQL fixture cleanup failed.');
  };
  try {
    await control.connect(); connected = true;
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10_000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${nonce}'`);
    schemaOid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid);
    await ownSchema();
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=5000 -c lock_timeout=1000 -c application_name=job-scope-fixture` });
    const livePool = pool;
    const namespace = async (client: PoolClient) => {
      const row = (await client.query(`SELECT current_schema() AS schema,
        to_regnamespace(current_schema())::oid AS oid,current_setting('search_path') AS path`)).rows[0];
      assert.equal(row.schema, schema); assert.equal(Number(row.oid), schemaOid);
      assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']);
    };
    return {
      query: (sql, values) => livePool.query(sql, values), exec: sql => livePool.query(sql),
      connect: async () => {
        const client = await livePool.connect(); checkedOut.add(client);
        let closed = false;
        const close = (error?: Error) => { if (!closed) { closed = true; checkedOut.delete(client); client.release(error); } };
        try { await namespace(client); } catch (error) { close(new Error('Owned fixture namespace changed.')); throw error; }
        return {
          get: async (sql, values) => (await client.query(sql, values)).rows[0],
          all: async (sql, values) => (await client.query(sql, values)).rows,
          run: async (sql, values) => { const result = await client.query(sql, values); return { changes: result.rowCount ?? 0 }; },
          close,
        };
      },
      close: cleanup,
    };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Owned direct worker fixture preparation failed.'); }
    throw error;
  }
}
