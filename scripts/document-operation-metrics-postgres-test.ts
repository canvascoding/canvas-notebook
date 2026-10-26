import assert from 'node:assert/strict';
import { Client, Pool, Query } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { installDocumentDatabaseMetrics, measureDocumentOperation, measureDocumentPhase,
  withDocumentOperationMetricObserver, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';

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
      assert(!JSON.stringify(measured).includes(privateValue));
      assert(!JSON.stringify(measured).includes('SELECT')); assert(!JSON.stringify(measured).includes(url.href));

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
    });
    assert.equal(await withDocumentOperationMetricObserver(() => { throw new Error('Sink failure'); },
      () => measureDocumentOperation('read', 'system', async () => { await pool.query('SELECT 1'); return 'unchanged'; })), 'unchanged');
    assert.equal(await withDocumentOperationMetricObserver(async () => { throw new Error('Async sink failure'); },
      () => measureDocumentOperation('read', 'system', async () => { await pool.query('SELECT 1'); return 'unchanged'; })), 'unchanged');
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
    console.log('Document operation metrics: real pg promises/callbacks/Drizzle/custom Query, unchanged error identity, nested/concurrent scopes, pool wait, privacy and failing-sink isolation passed.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
