import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

assert.equal(process.env.NODE_ENV, 'test');
let complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const previousMaximum = process.env.CANVAS_POSTGRES_POOL_MAX;
// Preserve the normal real workspace/bootstrap fixture configuration. Constrain
// the runtime only after that setup has released every application checkout.

async function waitFor(predicate: () => Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

try {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { createCollaborationProjectionRuntime } = await import('../app/lib/collaboration/projection-runtime');
    const { notifyWorkspaceFileInvalidationOnConnection } = await import('../app/lib/filesystem/workspace-file-invalidation');
    const { readCollaborationProjectionHealth } = await import('../app/lib/collaboration/projection-repository');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    // Complete the fixture's real starter documents before constraining its
    // application pool. This case proves wakeup/capacity without pending writes.
    const initial = createCollaborationProjectionRuntime({ onProjected: () => {}, onFailure: () => {} });
    try {
      await waitFor(async () => {
        const health = await readCollaborationProjectionHealth(h.connection);
        assert.equal(health.identityConflicts, 0); assert.equal(health.quarantined, 0);
        assert.equal(health.binaryPersistenceFailures, 0);
        return health.pending === 0;
      }, 'The real starter projections did not settle.', 45_000);
    } finally { await initial.dispose(); }
    for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId].sort()) {
      await withWorkspaceMutationLock(workspaceId, async () => undefined);
    }
    const fingerprint = async () => createHash('sha256').update(JSON.stringify((await h.admin.query(
      'SELECT to_jsonb(y)::text AS body,y.xmin::text AS xmin FROM collaboration_yjs_states y ORDER BY document_id')).rows)).digest('hex');
    const beforeRows = await fingerprint();
    assert.equal(pool.waitingCount, 0); assert.equal(pool.totalCount, pool.idleCount);
    const initialIdleClients = pool.idleCount;
    for (let index = 0; index < initialIdleClients; index++) {
      const idle = await pool.connect(); idle.release(true);
    }
    assert.equal(pool.totalCount, 0);
    pool.options.max = 1;
    pool.options.connectionTimeoutMillis = 5_000;
    process.env.CANVAS_POSTGRES_POOL_MAX = '1';
    assert.equal(pool.options.max, 1);
    assert.equal((await readCollaborationProjectionHealth(h.connection)).pending, 0);
    let scans = 0, listenerPid = 0, listenerStart = '';
    const startedAt = Date.now();
    await h.withProbe(async event => {
      if (/FROM\s+collaboration_yjs_states\s+y\s/iu.test(event.text)) scans++;
    }, async () => {
      const runtime = createCollaborationProjectionRuntime({
        onProjected: () => assert.fail('This settled capacity fixture contains no pending derived work.'),
        onFailure: () => assert.fail('This settled capacity fixture contains no document failure.'),
      });
      try {
        await waitFor(async () => {
          const rows = (await h.admin.query(`SELECT pid,backend_start::text AS start FROM pg_stat_activity
            WHERE datname=current_database() AND application_name=$1 AND query=$2`,
          [h.applicationName, 'LISTEN canvas_workspace_files'])).rows;
          if (!rows.length) return false;
          assert.equal(rows.length, 1); listenerPid = Number(rows[0].pid); listenerStart = rows[0].start; return true;
        }, 'The real separately owned LISTEN connection did not become ready.');
        const application = (await pool.query('SELECT pg_backend_pid() AS pid,current_schema() AS schema')).rows[0];
        assert.equal(application.schema, h.schema); assert.notEqual(Number(application.pid), listenerPid);
        let lastCount = scans, quietSince = Date.now();
        await waitFor(async () => {
          await pool.query('SELECT 1');
          if (scans !== lastCount) { lastCount = scans; quietSince = Date.now(); }
          return scans > 0 && Date.now() - quietSince >= 200;
        }, 'The actual initial durable scan did not settle.');
        const before = scans;
        await notifyWorkspaceFileInvalidationOnConnection(h.connection, h.source.workspaceId);
        await waitFor(async () => {
          const actual = (await pool.query('SELECT pg_backend_pid() AS pid,current_schema() AS schema')).rows[0];
          assert.equal(actual.schema, h.schema); assert.equal(Number(actual.pid), Number(application.pid));
          return scans > before;
        }, 'An actual committed notification did not wake the existing durable scan.');
        assert(Date.now() - startedAt < 10_000, 'This must observe the hint before the thirty-second audit.');
        assert.equal(pool.waitingCount, 0);
        await runtime.dispose();
        await waitFor(async () => Number((await h.admin.query(`SELECT count(*) AS n FROM pg_stat_activity
          WHERE pid=$1 AND backend_start::text=$2 AND application_name=$3`,
        [listenerPid, listenerStart, h.applicationName])).rows[0].n) === 0, 'The separately owned listener backend did not close.');
        const after = (await pool.query('SELECT pg_backend_pid() AS pid,current_schema() AS schema')).rows[0];
        assert.equal(Number(after.pid), Number(application.pid)); assert.equal(after.schema, h.schema);
        assert.equal(await fingerprint(), beforeRows);
        console.log('PROJECTION_WAKEUP_CAPACITY_PROOF', JSON.stringify({ passed: true, applicationPoolMaximum: 1,
          actualPostgres: true, separateActualListener: true, actualCommitHintObserved: true,
          applicationSlotRemainedUsable: true, listenerClosed: true, documentRowsAndXminPreserved: true,
          noDocumentAuthorityClaim: true }));
      } finally { await runtime.dispose(); }
    });
  });
  complete = true;
} finally {
  if (previousMaximum === undefined) delete process.env.CANVAS_POSTGRES_POOL_MAX;
  else process.env.CANVAS_POSTGRES_POOL_MAX = previousMaximum;
}
