import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';

export type NativeTestDatabaseConfig = Readonly<{
  connectionString: string;
  databaseName: string;
  kind: 'managed-local' | 'owned-ci';
  runId: string | null;
}>;
type Options = { env?: NodeJS.ProcessEnv; localConnectionString?: string; localEnvironmentFile?: string };
type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

/** Test-only selection. CI must select a nonce database explicitly; neither a
 * runtime DATABASE_URL nor a private host file can supply a missing CI target. */
export async function readNativeTestDatabaseConfig(options: Options = {}): Promise<NativeTestDatabaseConfig> {
  const env = options.env ?? process.env;
  assert.equal(env.NODE_ENV, 'test', 'Native database fixtures require NODE_ENV=test.');
  const ci = ['CI', 'GITHUB_ACTIONS'].some(key => env[key] !== undefined
    && !['', 'false', '0'].includes(env[key]!.trim().toLowerCase()));
  const explicit = env.CANVAS_NATIVE_TEST_DATABASE_URL;
  let connectionString: string, runId: string | null = null, kind: NativeTestDatabaseConfig['kind'];
  if (explicit !== undefined || ci) {
    assert(typeof explicit === 'string' && explicit.length > 0, 'CI requires an explicit native test database.');
    runId = env.CANVAS_NATIVE_TEST_RUN_ID ?? null;
    assert(typeof runId === 'string' && /^[a-f0-9]{32}$/u.test(runId), 'Native CI database requires its exact run ID.');
    connectionString = explicit; kind = 'owned-ci';
  } else {
    kind = 'managed-local';
    if (options.localConnectionString !== undefined) connectionString = options.localConnectionString;
    else {
      const file = options.localEnvironmentFile ?? path.join(homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
      const metadata = await lstat(file);
      assert(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0
        && metadata.uid === process.getuid?.(), 'Native local fixture requires its private owned environment file.');
      const stored = parse(await readFile(file, 'utf8')).DATABASE_URL;
      assert(stored, 'Native local database configuration is missing.'); connectionString = stored;
    }
  }
  assert(connectionString.length <= 4096 && connectionString === connectionString.trim()
    && !/[\u0000-\u0020\u007f]/u.test(connectionString), 'Invalid native database configuration.');
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid native database configuration.'); }
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && !url.search && !url.hash,
    'Native fixtures require an unambiguous PostgreSQL URL.');
  assert(kind === 'owned-ci' ? url.hostname === '127.0.0.1' : ['localhost', '127.0.0.1'].includes(url.hostname),
    'Native fixtures require a loopback database.');
  assert(/^[0-9]{1,5}$/u.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535,
    'Native fixture database port must be explicit.');
  const databaseName = kind === 'owned-ci' ? `canvas_native_ci_${runId}` : 'canvas_notebook';
  assert.equal(url.pathname, `/${databaseName}`, 'Native database name does not match its selected scope.');
  if (kind === 'managed-local') assert.equal(url.port, '55433', 'Local native fixtures require the managed PostgreSQL port.');
  return Object.freeze({ connectionString, databaseName, kind, runId });
}

/** Call on the actual maintenance connection before CREATE SCHEMA/DATABASE.
 * The CI marker and owner are real PG facts, never configuration authority. */
export async function assertNativeTestDatabaseTarget(database: Queryable, config: NativeTestDatabaseConfig) {
  const result = await database.query(`SELECT d.oid::text AS oid,d.datname AS name,
    pg_catalog.pg_get_userbyid(d.datdba)=current_user AS owned,
    pg_catalog.shobj_description(d.oid,'pg_database') AS marker,
    pg_catalog.current_setting('server_version_num') AS version
    FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()`);
  const row = result.rows[0];
  assert(row && row.name === config.databaseName && typeof row.oid === 'string' && /^[1-9][0-9]*$/u.test(row.oid),
    'The native fixture connected to a different database.');
  assert.equal(Math.floor(Number(row.version) / 10000), 18, 'Native fixtures require actual PostgreSQL 18.');
  if (config.kind === 'owned-ci') {
    assert.equal(row.owned, true, 'The CI test database is not owned by this role.');
    assert.equal(row.marker, `canvas-native-tests:${config.runId}`, 'The CI test database marker changed.');
  }
  return Object.freeze({ databaseOid: row.oid, databaseName: config.databaseName });
}
