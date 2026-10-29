import assert from 'node:assert/strict';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, Pool, Query } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { captureDocumentOperationMetricObserver, installDocumentClientQueryMetrics, installDocumentDatabaseMetrics,
  measureDocumentDatabaseActivity, measureDocumentOperation, measureDocumentPhase, withDocumentOperationMetricObserver,
  type DocumentDatabaseActivityMeasurement, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert(['localhost','127.0.0.1'].includes(url.hostname)); assert.equal(url.port, '55433');
  assert.match(url.pathname, /^\/canvas_editor_test_[a-f0-9]+$/u, 'isolated local PostgreSQL required');
  const pool = new Pool({ connectionString: url.href, max: 1 });
  installDocumentDatabaseMetrics(pool); installDocumentDatabaseMetrics(pool);
  const database = drizzle(pool), observations: DocumentOperationMeasurement[] = [];
  const privateValue = 'PRIVATE document content /private/path.md token=user-specific-secret';
  try {
    await withDocumentOperationMetricObserver(value => observations.push(value), async () => {
      const result = await measureDocumentOperation('read', 'request', async () => {
        const client = await pool.connect();
        try {
          await measureDocumentPhase('snapshot', async () => {
            const result = await client.query({ name: 'document_metrics_fixture', text: 'SELECT $1::text AS body', values: [privateValue] });
            assert.equal(result.rows[0].body, privateValue);
          });
          await new Promise<void>((resolve, reject) => {
            const result = client.query('SELECT 1 AS n', (error, value) => {
              if (error) return reject(error); assert.equal(value.rows[0].n, 1); resolve();
            });
            assert.equal(result, undefined, 'pg callback return semantics are retained');
          });
          await assert.rejects(client.query('SELECT 1/0'), (error: unknown) => (error as { code: string }).code === '22012');
        } finally { client.release(); }
        const result = await database.execute(sql`SELECT ${privateValue}::text AS body`);
        assert.equal(result.rows[0].body, privateValue);
        return privateValue;
      });
      assert.equal(result, privateValue);
      assert.equal(observations.length, 1);
      const measured = observations[0];
      assert.equal(measured.statements, 4); assert.equal(measured.failedStatements, 1);
      assert.equal(measured.checkouts, 2); assert.equal(measured.peakConnections, 1);
      assert.equal(measured.openConnectionsAtCompletion, 0); assert.equal(measured.openQueriesAtCompletion, 0);
      assert.equal(measured.unsupportedQueryForms, 0); assert.equal(measured.outcome, 'succeeded');
      assert.equal(measured.phases.find(phase => phase.phase === 'snapshot')?.statements, 1);
      assert.equal(measured.phases.find(phase => phase.phase === 'operation')?.statements, 4);
      assert.deepEqual(measured.queryGroups.map(({ group, statements, failedStatements }) =>
        ({ group, statements, failedStatements })), [{ group: 'other', statements: 4, failedStatements: 1 }]);
      assert(!JSON.stringify(measured).includes(privateValue));
      assert(!JSON.stringify(measured).includes('SELECT')); assert(!JSON.stringify(measured).includes(url.href));

      const dedicated = new Client({ connectionString: url.href });
      installDocumentClientQueryMetrics(dedicated); installDocumentClientQueryMetrics(dedicated);
      await dedicated.connect();
      try {
        const beforeDedicated = observations.length;
        await measureDocumentOperation('save', 'request', async () => {
          const result = await dedicated.query({ name: 'document_metrics_dedicated', text: 'SELECT $1::text AS body', values: [privateValue] });
          assert.equal(result.rows[0].body, privateValue);
          await new Promise<void>((resolve, reject) => {
            const result = dedicated.query('SELECT 2 AS n', (error, value) => {
              if (error) return reject(error); assert.equal(value.rows[0].n, 2); resolve();
            });
            assert.equal(result, undefined, 'Dedicated pg callback return semantics are retained.');
          });
          await assert.rejects(dedicated.query('SELECT 1/0'), (error: unknown) => (error as { code: string }).code === '22012');
          await pool.query('SELECT 4 AS n');
        });
        assert.equal(observations.length, beforeDedicated + 1);
        const direct = observations.at(-1)!;
        assert.equal(direct.statements, 4, 'The shared operation counts three dedicated-client queries and one pooled query exactly once.');
        assert.equal(direct.failedStatements, 1); assert.equal(direct.unsupportedQueryForms, 0);
        assert.equal(direct.checkouts, 1, 'Pool checkout measurements do not pretend that a long-lived dedicated client was borrowed.');
        assert.equal(direct.openConnectionsAtCompletion, 0); assert.equal(direct.openQueriesAtCompletion, 0);

        const runtime = new AsyncResource('document-metrics-existing-runtime');
        const authorityLifetime = new AsyncLocalStorage<string>(), activity: DocumentDatabaseActivityMeasurement[] = [];
        const beforeActivity = observations.length;
        try {
          const result = await authorityLifetime.run('current authority lifetime', () => measureDocumentDatabaseActivity('save', 'request', async () => {
            await runtime.runInAsyncScope(async () => {
              assert.equal(authorityLifetime.getStore(), undefined, 'The runtime predates the calling authority scope.');
              assert.equal((await dedicated.query('SELECT 81 AS n')).rows[0].n, 81);
            });
            await pool.query('SELECT 82');
            await measureDocumentOperation('save', 'request', async () => {
              await dedicated.query('SELECT 83');
              await new Promise<void>((resolve, reject) => pool.query('SELECT 84', error => error ? reject(error) : resolve()));
            });
            let originalCallbackError: unknown;
            await assert.rejects(runtime.runInAsyncScope(() => new Promise<void>((_resolve, reject) => {
              const returned = dedicated.query('SELECT 1/0', error => {
                try {
                  assert.equal(authorityLifetime.getStore(), undefined, 'Diagnostics never resurrect the caller authority in an older runtime callback.');
                  originalCallbackError = error; reject(error);
                } catch (problem) { reject(problem); }
              });
              assert.equal(returned, undefined);
            })), error => error === originalCallbackError && (error as { code: string }).code === '22012');
            assert.equal(authorityLifetime.getStore(), 'current authority lifetime');
            return privateValue;
          }, value => activity.push(value)));
          assert.equal(result, privateValue); assert.equal(activity.length, 1);
          const total = activity[0];
          assert.equal(total.component, 'document_database_activity');
          assert.equal(total.coverage, 'instrumented-runtime-process-window');
          assert.equal(total.statements, 5); assert.equal(total.scopedStatements, 2); assert.equal(total.unscopedStatements, 3);
          assert.equal(total.failedStatements, 1); assert.equal(total.checkouts, 2);
          assert.equal(total.peakConnections, 1); assert.equal(total.openConnectionsAtCompletion, 0);
          assert.equal(total.openQueriesAtCompletion, 0); assert.equal(total.unsupportedQueryForms, 0);
          assert.equal(observations.length, beforeActivity + 1, 'The process window is separate from the normal per-operation diagnostic sink.');
          assert.equal(observations.at(-1)?.statements, 2, 'Scoped operations retain their original caller-specific meaning.');
          assert(Object.isFrozen(total) && Object.isFrozen(total.queryGroups) && total.queryGroups.every(Object.isFrozen));
          assert.equal(total.queryGroups.reduce((sum, group) => sum + group.statements, 0), 5);
          const serialized = JSON.stringify(total);
          assert(!serialized.includes(privateValue) && !serialized.includes('SELECT') && !serialized.includes(url.href));
          await runtime.runInAsyncScope(() => dedicated.query('SELECT 85'));
          assert.equal(JSON.stringify(total), serialized, 'The window closes and its published snapshot cannot absorb later callbacks.');
          assert.equal(observations.length, beforeActivity + 1);

          let signalReady!: () => void, releaseFirst!: () => void;
          const ready = new Promise<void>(done => { signalReady = done; });
          const released = new Promise<void>(done => { releaseFirst = done; });
          const overlapping: DocumentDatabaseActivityMeasurement[] = [];
          const first = measureDocumentDatabaseActivity('read', 'request', async () => {
            await dedicated.query('SELECT 91'); signalReady(); await released;
          }, value => overlapping.push(value));
          try {
            await Promise.race([ready, first.then(() => { throw new Error('The first window ended before its barrier.'); })]);
            await measureDocumentDatabaseActivity('links', 'system', async () => {
              await pool.query('SELECT 92'); await pool.query('SELECT 93');
            }, value => overlapping.push(value));
          } finally { releaseFirst(); await first; }
          assert.deepEqual(overlapping.map(value => [value.operation, value.statements]), [['links', 2], ['read', 3]],
            'Process-wide windows explicitly overlap; they are not per-caller measurements that may be added.');
          assert(overlapping.every(value => value.openQueriesAtCompletion === 0 && value.openConnectionsAtCompletion === 0));
        } finally { runtime.emitDestroy(); }
      } finally { await dedicated.end(); }

      const copyDirectory = await mkdtemp(path.join(tmpdir(), 'canvas-document-metrics-copy-'));
      const copyPath = path.join(copyDirectory, 'metrics-copy.mjs');
      let copyWritten = false;
      try {
        const { transform } = await import('esbuild');
        const source = await readFile(path.join(process.cwd(), 'app/lib/observability/document-operation-metrics.ts'), 'utf8');
        const compiled = await transform(source, { loader: 'ts', format: 'esm', platform: 'node', target: 'node22' });
        await writeFile(copyPath, compiled.code, { mode: 0o600, flag: 'wx' }); copyWritten = true;
        const copy = await import(pathToFileURL(copyPath).href) as typeof import('../app/lib/observability/document-operation-metrics');
        const originalConnect = pool.connect;
        copy.installDocumentDatabaseMetrics(pool);
        const fromCopy: DocumentOperationMeasurement[] = [];
        await copy.withDocumentOperationMetricObserver(value => fromCopy.push(value), () => copy.measureDocumentOperation('read', 'system', async () => {
          assert.equal((await pool.query('SELECT 94 AS n')).rows[0].n, 94);
        }));
        assert.equal(fromCopy.length, 1);
        assert.equal(fromCopy[0].statements, 1, 'A separately compiled consumer observes the actual shared runtime pool.');
        assert.equal(fromCopy[0].checkouts, 1);
        assert.equal(pool.connect, originalConnect, 'A second bundle cannot stack another instrumentation layer on the same pool.');
        const copyActivities: DocumentDatabaseActivityMeasurement[] = [];
        await copy.measureDocumentDatabaseActivity('read', 'system', async () => {
          await pool.query('SELECT 95');
          await measureDocumentOperation('read', 'request', async () => { await pool.query('SELECT 96'); });
        }, value => copyActivities.push(value));
        assert.equal(copyActivities.length, 1); assert.equal(copyActivities[0].statements, 2);
        assert.equal(copyActivities[0].scopedStatements, 1); assert.equal(copyActivities[0].unscopedStatements, 1);
      } finally {
        if (copyWritten) await unlink(copyPath);
        await rmdir(copyDirectory);
      }

      let originalError: unknown;
      await assert.rejects(measureDocumentOperation('save', 'agent', async () => {
        const client = await pool.connect();
        try {
          await new Promise<void>((resolve, reject) => client.query('SELECT $1::integer', ['not-an-integer'], error => {
            originalError = error; reject(error);
          }));
        } finally { client.release(); }
      }), error => error === originalError);
      assert.equal(observations.at(-1)?.failedStatements, 1); assert.equal(observations.at(-1)?.outcome, 'failed');

      const before = observations.length;
      await measureDocumentOperation('create', 'mcp', () => measureDocumentOperation('read', 'system', async () => {
        await pool.query('SELECT 1');
      }));
      assert.equal(observations.length, before + 1, 'nested shared services join the original action');
      assert.equal(observations.at(-1)?.operation, 'create'); assert.equal(observations.at(-1)?.actor, 'mcp');

      let release!: () => void, later!: Promise<void>;
      const released = new Promise<void>(done => { release = done; }), beforeDetached = observations.length;
      await measureDocumentOperation('create', 'agent', async () => {
        await pool.query('SELECT 1');
        later = (async () => {
          await released;
          await measureDocumentOperation('save', 'request', async () => { await pool.query('SELECT 2'); });
        })();
      });
      release(); await later;
      assert.equal(observations.length, beforeDetached + 2, 'An ended action cannot absorb a later operation inherited by an asynchronous child.');
      assert.deepEqual(observations.slice(-2).map(value => [value.operation, value.statements]), [['create', 1], ['save', 1]]);

      const unrelated = new AsyncLocalStorage<string>(), delivered: DocumentOperationMeasurement[] = [];
      let socketObserver!: ReturnType<typeof captureDocumentOperationMetricObserver>;
      await withDocumentOperationMetricObserver(value => delivered.push(value), async () => {
        unrelated.run('previous authority lifetime', () => { socketObserver = captureDocumentOperationMetricObserver(); });
      });
      await unrelated.run('current authority lifetime', () => socketObserver(() => measureDocumentOperation('save', 'request', async () => {
        assert.equal(unrelated.getStore(), 'current authority lifetime');
        await pool.query('SELECT 3');
      })));
      assert.equal(delivered.length, 1); assert.equal(delivered[0].statements, 1);
      assert.equal(observations.length, beforeDetached + 2, 'A runtime retains its own diagnostic sink, never another sink or old authority context.');

      await Promise.all([
        measureDocumentOperation('read', 'request', async () => { await pool.query('SELECT pg_sleep(0.03)'); }),
        measureDocumentOperation('links', 'agent', async () => { await pool.query('SELECT 1'); await pool.query('SELECT 2'); }),
      ]);
      const parallel = observations.slice(-2);
      assert.equal(parallel.find(value => value.operation === 'read')?.statements, 1);
      assert.equal(parallel.find(value => value.operation === 'links')?.statements, 2);
      assert(parallel.every(value => value.openConnectionsAtCompletion === 0));
      assert(parallel.some(value => value.poolWaitMs > 10), 'queued checkout wait is measured on the originating operation');

      await measureDocumentOperation('read', 'system', async () => {
        const client = await pool.connect();
        try {
          const query = new Query('SELECT 1 AS n');
          const completed = new Promise<void>((resolve, reject) => { query.once('end', () => resolve()); query.once('error', reject); });
          const errorListeners = query.listenerCount('error');
          assert.equal(client.query(query), query, 'custom Query identity is retained');
          assert.equal(query.listenerCount('error'), errorListeners, 'instrumentation adds no error handler to a custom Query');
          await completed;
        } finally { client.release(); }
      });
      assert.equal(observations.at(-1)?.unsupportedQueryForms, 1, 'unsupported timing coverage stays explicit');

      await measureDocumentOperation('links', 'system', async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT current_schema()');
          // Diagnostic classification only: these CTEs are not authorization
          // fixtures and cannot establish any product permission.
          for (const table of ['team_memberships', 'agents', 'pi_sessions', 'canvas_workspaces', 'user',
            'collaboration_yjs_states', 'collaboration_file_projections', 'collaboration_documents']) {
            assert.equal((await client.query(`WITH "${table}"(n) AS (VALUES (1)) SELECT n FROM "${table}"`)).rows[0].n, 1);
          }
          await client.query(`SELECT 1 /* ${privateValue.repeat(1000)} */`);
          await client.query('COMMIT');
        } finally { client.release(); }
      });
      assert.deepEqual(Object.fromEntries(observations.at(-1)!.queryGroups.map(value => [value.group, value.statements])),
        { transaction: 2, catalogue: 1, seat: 1, agent: 1, session: 1, workspace: 1, account: 1,
          'document-state': 1, 'document-projection': 1, 'document-registry': 1, other: 1 });

      const queryWithAccessor = async (measured: boolean, proxied: boolean) => {
        let gets = 0, traps = 0;
        const config = Object.defineProperty({}, 'text', { get() { gets++; return 'SELECT current_schema()'; } });
        const input = proxied ? new Proxy(config, { get(target, key, receiver) { traps++; return Reflect.get(target, key, receiver); },
          getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); } }) : config;
        const execute = async () => { await pool.query(input as { text: string }); };
        if (measured) await measureDocumentOperation('read', 'system', execute); else await execute();
        return { gets, traps };
      };
      for (const proxied of [false, true]) {
        const original = await queryWithAccessor(false, proxied);
        assert.deepEqual(await queryWithAccessor(true, proxied), original,
          'diagnostic grouping must add no getter reads or proxy traps to the real driver');
        assert.equal(observations.at(-1)?.queryGroups[0].group, 'other', 'uninspected query forms stay explicit');
        let total: DocumentDatabaseActivityMeasurement | undefined;
        assert.deepEqual(await measureDocumentDatabaseActivity('read', 'system', () => queryWithAccessor(false, proxied), value => { total = value; }), original,
          'An unscoped process-window query adds no getter reads or proxy traps.');
        assert.equal(total?.statements, 1); assert.equal(total?.unscopedStatements, 1);
        assert.equal(total?.queryGroups[0].group, 'other');
      }
      for (const value of [...observations, ...delivered]) {
        assert.equal(value.queryGroups.reduce((sum, group) => sum + group.statements, 0), value.statements);
        assert.equal(value.queryGroups.reduce((sum, group) => sum + group.failedStatements, 0), value.failedStatements);
        assert(Object.isFrozen(value.queryGroups) && value.queryGroups.every(Object.isFrozen));
        const serialized = JSON.stringify(value);
        assert(!serialized.includes(privateValue) && !serialized.includes('SELECT') && !serialized.includes(url.href));
      }
    });
    assert.equal(await withDocumentOperationMetricObserver(() => { throw new Error('Sink failure'); },
      () => measureDocumentOperation('read', 'system', async () => { await pool.query('SELECT 1'); return 'unchanged'; })), 'unchanged');
    assert.equal(await withDocumentOperationMetricObserver(async () => { throw new Error('Async sink failure'); },
      () => measureDocumentOperation('read', 'system', async () => { await pool.query('SELECT 1'); return 'unchanged'; })), 'unchanged');
    for (const observe of [() => { throw new Error('Window sink failure'); }, async () => { throw new Error('Async window sink failure'); }]) {
      assert.equal(await measureDocumentDatabaseActivity('read', 'system', async () => { await pool.query('SELECT 1'); return 'unchanged'; }, observe), 'unchanged');
    }
    await new Promise<void>((resolve, reject) => {
      const result = pool.connect((error, client, release) => {
        if (error || !client) return reject(error); release(); resolve();
      });
      assert.equal(result, undefined, 'pool callback overload is retained outside a measurement');
    });
    const originalQuery = Client.prototype.query; let lateCalls = 0;
    Client.prototype.query = function(...args: unknown[]) { lateCalls++; return Reflect.apply(originalQuery, this, args); } as typeof originalQuery;
    try {
      await measureDocumentOperation('read', 'system', async () => { assert.equal((await pool.query('SELECT 3 AS n')).rows[0].n, 3); });
      assert.equal(lateCalls, 1, 'late prototype observers and fault probes must still observe the real SQL');
    } finally { Client.prototype.query = originalQuery; }
    console.log('Document operation metrics: real pg promises/callbacks/Drizzle/custom Query, unchanged errors/getters/proxy traps, nested/concurrent scopes, pool wait, fixed query groups, privacy and failing-sink isolation passed.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
