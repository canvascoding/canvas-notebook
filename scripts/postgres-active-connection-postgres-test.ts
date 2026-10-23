import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { Client, type PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';

const cases = ['between-queries', 'active-query', 'healthy-reuse', 'sql-error', 'acquire-event',
  'late-idle-event', 'explicit-discard', 'normal-poisoned-close', 'post-query-event', 'close-in-flight',
  'release-failure', 'release-event', 'discard-release-event', 'commit-recovery', 'commit-close-error'] as const;
type Case = typeof cases[number];
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';

async function child(testCase: Case): Promise<void> {
  const { openDb, getPostgresRuntimeQueryable, closeDatabaseConnections } = await import('../app/lib/db');
  const { DatabaseUnavailableError } = await import('../app/lib/db/errors');
  const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
  const schema = process.env.CANVAS_LEASE_TEST_SCHEMA!;
  const applicationName = process.env.CANVAS_LEASE_TEST_APPLICATION!;
  assert.match(schema, /^native_lease_[a-f0-9]{32}$/u);
  assert.match(applicationName, /^lease_[a-f0-9]{32}_[a-z-]+$/u);
  const control = new Client({ connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},pg_catalog -c statement_timeout=5000 -c application_name=${applicationName}-control` });
  // This listener belongs only to the control connection, never the product B.
  control.on('error', () => undefined);
  await control.connect();
  const pool = getPostgresRuntimeQueryable()!;
  assert(pool);
  let raw: PoolClient | undefined;
  let releases = 0;
  pool.on('acquire', client => { raw = client; });
  pool.on('release', () => { releases++; });
  const connections = new Set<SqlConnection>();
  const prepared = process.env.CANVAS_LEASE_TEST_PREPARED === 'true';
  const open = async () => {
    const b = await openDb(); connections.add(b);
    // Run the identical lifetime cases through the actual optional method too.
    if (prepared) { assert(b.getPrepared); b.get = b.getPrepared; }
    return b;
  };
  const failure = (error: unknown, code?: string) => {
    assert(error instanceof DatabaseUnavailableError, 'A terminal product connection failure must reject safely.');
    assert.equal(error.code, 'postgres_unavailable');
    if (code) assert.equal((error.cause as { code?: string })?.code, code);
    return true;
  };
  const identity = async (b: SqlConnection) => {
    const row = await b.get(`SELECT pid,backend_start::text AS start,application_name,current_schema() AS schema
      FROM pg_stat_activity WHERE pid=pg_backend_pid()`) as { pid: number; start: string; application_name: string; schema: string };
    assert.equal(row.application_name, applicationName); assert.equal(row.schema, schema);
    assert(Number.isSafeInteger(row.pid) && row.pid > 0); assert(row.start);
    return row;
  };
  const terminate = async (row: Awaited<ReturnType<typeof identity>>) => {
    const result = await control.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
      WHERE pid=$1 AND backend_start::text=$2 AND application_name=$3`, [row.pid, row.start, row.application_name]);
    assert.equal(result.rowCount, 1, 'Termination requires the exact owned backend fence.');
    assert.equal(result.rows[0].terminated, true);
  };
  const timeout = async (b: SqlConnection) => {
    await identity(b);
    await b.run('BEGIN');
    await b.run("SET LOCAL transaction_timeout='80ms'");
    await delay(180); // no query while PostgreSQL emits FATAL 25P04
  };
  try {
    assert.equal(Math.floor(Number((await control.query("SHOW server_version_num")).rows[0].server_version_num) / 10000), 18);
    if (testCase === 'between-queries') {
      const b = await open(); await timeout(b);
      await assert.rejects(async () => b.get('SELECT 1'), error => failure(error, '25P04'));
      await assert.rejects(async () => b.close(), error => failure(error, '25P04'));
      assert.equal(releases, 1);
    } else if (testCase === 'active-query') {
      const b = await open(), row = await identity(b);
      const pending = Promise.resolve(b.get('SELECT pg_sleep(2)')).then(() => null, error => error);
      await delay(30); await terminate(row);
      assert(failure(await pending));
      await assert.rejects(async () => b.all('SELECT 1'), failure);
      await b.close(new Error('Discarding owned failed query.'));
      assert.equal(releases, 1);
    } else if (testCase === 'healthy-reuse') {
      const first = await open(), firstIdentity = await identity(first);
      await first.close(); await first.close();
      assert.equal(releases, 1);
      const second = await open(), secondIdentity = await identity(second);
      assert.equal(secondIdentity.pid, firstIdentity.pid, 'Healthy reuse remains enabled.');
      await assert.rejects(async () => first.get('SELECT 999'), /closed/iu);
      await first.close(); assert.equal(releases, 1, 'A stale lease must not release the new borrower.');
      assert.equal((await second.get('SELECT 1 AS ok') as { ok: number }).ok, 1);
      await second.close(); assert.equal(releases, 2);
    } else if (testCase === 'sql-error') {
      const b = await open(); await identity(b); await b.run('BEGIN');
      await assert.rejects(async () => b.run('SELECT 1/0'), error => (error as { code?: string }).code === '22012');
      await b.run('ROLLBACK');
      assert.equal((await b.get('SELECT 1 AS ok') as { ok: number }).ok, 1);
      await b.close(); assert.equal(pool.idleCount, 1);
    } else if (testCase === 'acquire-event') {
      // Controlled lifetime counterprobe on a genuine pg PoolClient. This is
      // deliberately an injected event, separate from real wire failures above.
      const event = Object.assign(new Error('Owned acquire boundary fault.'), { code: 'ECONNRESET' });
      pool.once('acquire', client => { queueMicrotask(() => client.emit('error', event)); });
      const b = await open();
      await assert.rejects(async () => b.get('SELECT 1'), failure);
      await b.close(new Error('Discarding owned acquisition failure.'));
      assert.equal(releases, 1);
    } else if (testCase === 'late-idle-event') {
      const b = await open(); await identity(b); const previous = raw!;
      await b.close();
      const removed = new Promise<void>(resolve => pool.once('remove', () => resolve()));
      previous.emit('error', Object.assign(new Error('Owned late idle fault.'), { code: 'ECONNRESET' }));
      await removed;
      await b.close(); assert.equal(releases, 1);
      await assert.rejects(async () => b.get('SELECT 1'), /closed/iu);
      const replacement = await open(); await identity(replacement); await replacement.close();
      assert.equal(releases, 2);
    } else if (testCase === 'explicit-discard') {
      const b = await open(), row = await identity(b);
      await terminate(row); await delay(40);
      await b.close(new Error('Discarding failed owned backend.')); await b.close();
      assert.equal(releases, 1);
      const replacement = await open(); assert.notEqual((await identity(replacement)).pid, row.pid);
      await replacement.close();
    } else if (testCase === 'normal-poisoned-close') {
      const b = await open(); await timeout(b);
      await assert.rejects(async () => b.close(), failure); await assert.rejects(async () => b.close(), failure);
      assert.equal(releases, 1);
    } else if (testCase === 'post-query-event') {
      const b = await open(); await identity(b);
      // pg resolves the genuine query before its synchronous drain event. The
      // product's post-await guard must reject this now-poisoned result.
      raw!.once('drain', () => raw!.emit('error', Object.assign(new Error('Owned post-query fault.'), { code: 'ECONNRESET' })));
      await assert.rejects(async () => b.get('SELECT 1 AS ok'), failure);
      await b.close(new Error('Discarding owned post-query failure.'));
      assert.equal(releases, 1);
    } else if (testCase === 'close-in-flight') {
      const b = await open(), row = await identity(b);
      const pending = Promise.resolve(b.get('SELECT pg_sleep(2)')).then(() => null, error => error);
      await delay(30);
      await assert.rejects(async () => b.close(), /query in flight/iu);
      assert.match((await pending as Error).message, /closed/iu);
      await assert.rejects(async () => b.close(), /query in flight/iu);
      assert.equal(releases, 1);
      const replacement = await open(); assert.notEqual((await identity(replacement)).pid, row.pid);
      await replacement.close();
    } else if (testCase === 'release-failure') {
      const b = await open(); await identity(b); const held = raw!, release = held.release.bind(held);
      const releaseFailure = new Error('Owned release acknowledgement failure.');
      // Inject only an acknowledgement failure after actual pg release. Never
      // replace its acquisition, query, authentication or network behavior.
      held.release = error => { release(error); throw releaseFailure; };
      await assert.rejects(async () => b.close(), error => error === releaseFailure);
      await assert.rejects(async () => b.close(), error => error === releaseFailure);
      assert.equal(releases, 1);
      const removed = new Promise<void>(resolve => pool.once('remove', () => resolve()));
      held.emit('error', Object.assign(new Error('Owned late released-client fault.'), { code: 'ECONNRESET' }));
      await removed;
      await assert.rejects(async () => b.close(), error => error === releaseFailure);
      assert.equal(releases, 1);
    } else if (testCase === 'release-event' || testCase === 'discard-release-event') {
      const b = await open(); await identity(b);
      // The active lease listener and pg's idle listener overlap during actual
      // release. Its synchronous observer must not escape the final close guard.
      pool.once('release', (_error, client) => {
        client.emit('error', Object.assign(new Error('Owned synchronous release fault.'), { code: 'ECONNRESET' }));
      });
      if (testCase === 'release-event') {
        await assert.rejects(async () => b.close(), failure);
        await assert.rejects(async () => b.close(), failure);
      } else {
        await b.close(new Error('Discarding owned explicit release-event fixture.')); await b.close();
      }
      assert.equal(releases, 1);
      await assert.rejects(async () => b.get('SELECT 1'), failure);
    } else if (testCase === 'commit-recovery') {
      let executions = 0, recoveries = 0, bPid = 0;
      const marker = crypto.randomUUID();
      const answer = await executeLifecycleTransaction({ openConnection: async () => {
        const b = await open(); bPid = (await identity(b)).pid;
        return { ...b, run: async (sql: string, values?: unknown[]) => {
          const result = await b.run(sql, values);
          if (sql === 'COMMIT') {
            // Actual PostgreSQL COMMIT followed by a controlled lost-answer
            // event. Recovery must inspect genuine durable state on a fresh C.
            raw!.emit('error', Object.assign(new Error('Owned committed-answer loss.'), { code: 'ECONNRESET' }));
            throw new Error('Owned COMMIT answer was lost.');
          }
          return result;
        } };
      }, execute: async b => {
        executions++; await b.run('INSERT INTO lease_markers(id) VALUES($1)', [marker]); return marker;
      }, recoverCommitted: async value => {
        recoveries++; assert.equal(releases, 1, 'B must discard before recovery C.');
        const c = await open(); assert.notEqual((await identity(c)).pid, bPid, 'Recovery requires a different genuine backend.');
        try { assert.equal((await c.get('SELECT count(*)::int AS n FROM lease_markers WHERE id=$1', [value]) as { n: number }).n, 1); }
        finally { await c.close(); }
        return value;
      } });
      assert.equal(answer, marker); assert.equal(executions, 1); assert.equal(recoveries, 1); assert.equal(releases, 2);
    } else if (testCase === 'commit-close-error') {
      let executions = 0, recoveries = 0;
      const marker = crypto.randomUUID();
      await assert.rejects(executeLifecycleTransaction({ openConnection: async () => {
        const b = await open(); await identity(b);
        return { ...b, run: async (sql: string, values?: unknown[]) => {
          const result = await b.run(sql, values);
          if (sql === 'COMMIT') raw!.emit('error', Object.assign(new Error('Owned post-COMMIT connection fault.'), { code: 'ECONNRESET' }));
          return result;
        } };
      }, execute: async b => { executions++; await b.run('INSERT INTO lease_markers(id) VALUES($1)', [marker]); return marker; },
      recoverCommitted: async () => { recoveries++; throw new Error('Acknowledged COMMIT must not replay or recover.'); } }), failure);
      assert.equal(executions, 1); assert.equal(recoveries, 0); assert.equal(releases, 1);
      assert.equal((await control.query('SELECT count(*)::int AS n FROM lease_markers WHERE id=$1', [marker])).rows[0].n, 1);
    }
    console.log(JSON.stringify({ case: testCase, prepared, passed: true }));
  } finally {
    for (const b of connections) { try { await b.close(new Error('Final owned fixture cleanup.')); } catch { /* Already closed poisoned lease. */ } }
    await closeDatabaseConnections(); await control.end();
  }
}

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const selected = process.argv.find(value => value.startsWith('--case='))?.slice(7);
  assert(!selected || cases.includes(selected as Case));
  for (const testCase of selected ? [selected as Case] : cases) {
    const id = crypto.randomUUID().replaceAll('-', ''), schema = `native_lease_${id}`;
    const applicationName = `lease_${id}_${testCase.slice(0, 16)}`;
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-pg-active-lease-'));
    const control = new Client({ connectionString, options: '-c statement_timeout=5000' });
    control.on('error', () => undefined);
    let created = false;
    try {
      await control.connect(); await control.query(`CREATE SCHEMA "${schema}"`); created = true;
      await control.query(`CREATE TABLE "${schema}".lease_markers(id text PRIMARY KEY)`);
      const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', DATABASE_URL: connectionString, CANVAS_DATABASE_PROVIDER: 'postgres',
        CANVAS_LEASE_TEST_PREPARED: process.argv.includes('--prepared') ? 'true' : 'false',
        PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=5000 -c application_name=${applicationName}`,
        CANVAS_POSTGRES_POOL_MAX: '1', CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS: '5000', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot,
        CANVAS_INSTANCE_ID: `pg-lease-${id}`, CANVAS_LEASE_TEST_SCHEMA: schema, CANVAS_LEASE_TEST_APPLICATION: applicationName };
      delete environment.NEXT_PHASE;
      const outcome = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
        const task = spawn(process.execPath, ['--conditions', 'react-server', '--import', 'tsx', path.resolve(__filename), '--child', testCase],
          { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        task.stdout.on('data', data => { stdout += data; }); task.stderr.on('data', data => { stderr += data; });
        const watchdog = setTimeout(() => task.kill('SIGKILL'), 20000);
        task.once('error', error => { clearTimeout(watchdog); reject(error); });
        task.once('exit', (code, signal) => { clearTimeout(watchdog); resolve({ code, signal, stdout, stderr }); });
      });
      // Never publish the driver's error text, environment or connection URL.
      console.log(JSON.stringify({ case: testCase, prepared: environment.CANVAS_LEASE_TEST_PREPARED === 'true', childExit: outcome.code, signal: outcome.signal,
        unhandledClientEvent: /Unhandled 'error' event/u.test(outcome.stderr), fatal25P04: /25P04/u.test(outcome.stderr),
        passed: outcome.code === 0 && outcome.stdout.includes('"passed":true') }));
      if (outcome.code !== 0) {
        for (const line of outcome.stderr.split('\n')) {
          try { const diagnostic = JSON.parse(line); if (diagnostic.failed === true) console.log(JSON.stringify(diagnostic)); } catch { /* Driver text stays private. */ }
        }
      }
      assert.equal(outcome.code, 0, `${testCase}: actual product connection child must exit cleanly.`);
      assert(outcome.stdout.includes('"passed":true'), `${testCase}: actual child assertions must complete.`);
    } finally {
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      await control.end(); await rm(dataRoot, { recursive: true, force: true });
    }
  }
}

const childCase = process.argv[2] === '--child' ? process.argv[3] as Case : null;
void (childCase ? child(childCase) : main()).catch(error => {
  console.error(JSON.stringify({ failed: true, assertion: error instanceof assert.AssertionError ? error.message : undefined }));
  process.exitCode = 1;
});
