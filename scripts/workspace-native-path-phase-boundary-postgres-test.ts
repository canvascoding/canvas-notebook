import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import type { WorkspaceRequestPrincipalAccess } from '../app/lib/workspaces/request-principal';

let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const failures = (error: unknown, seen = new Set<unknown>()): string[] => {
  if (!error || typeof error !== 'object' || seen.has(error) || seen.size > 24) return [];
  seen.add(error);
  const code: unknown = Reflect.get(error, 'code'), cause: unknown = Reflect.get(error, 'cause');
  const result = typeof code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(code) ? [code] : [];
  return [...result, ...failures(cause, seen), ...(error instanceof AggregateError
    ? error.errors.flatMap(item => failures(item, seen)) : [])];
};

async function workspaceNativePathPhaseBoundaryPostgresTest() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { openDb } = await import('../app/lib/db');
    const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { advanceWorkspaceOperationNativePathAdmission } = await import('../app/lib/files/workspace-operation-native-path-admission');
    type Access = Pick<WorkspaceRequestPrincipalAccess, 'workspace' | 'userId' | 'sessionId'>;
    const access = await withWorkspaceRequestPrincipal<Access>(await h.request(h.source, 'owner', true),
      { workspaceId: h.source.workspaceId, permission: 'canWrite' }, async principal => {
        const database = await openDb(); let committed = false;
        await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        try {
          const result = await withWorkspaceRequestPrincipalOnConnection<Access>(database, principal, async current => {
            await current.assertCurrent();
            return { workspace: current.workspace, userId: current.userId, sessionId: current.sessionId };
          });
          await database.run('COMMIT'); committed = true; return result;
        } finally {
          if (!committed) await database.run('ROLLBACK');
          await database.close(committed ? undefined : new Error('Discarding unsuccessful fixture Principal.'));
        }
      });
    const protectedDoc = await h.upload('bounded-native-protected.md', Buffer.from('# Keep this document\n'));
    const sourcePath = `bounded-native-${randomUUID()}.txt`, source = path.join(h.source.rootPath, sourcePath);
    const bytes = Buffer.from('Keep this original file while admission is prepared.\n');
    await fs.writeFile(source, bytes, { flag: 'wx' });
    const snapshot = async () => (await h.admin.query('SELECT row_to_json(s) AS state,s.xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [protectedDoc.documentId])).rows;
    const before = await snapshot();
    const plan = await buildWorkspaceOperationBatchPlan({ scope: { workspace: access.workspace, fileOptions: { workspace: access.workspace } },
      actions: [{ reviewId: randomUUID(), kind: 'delete', selections: [{ sourcePath }] }] });
    assert.equal(plan.version, 5); assert.equal(plan.readiness, 'ready');
    const batchId = randomUUID(), store = new WorkspaceOperationBatchStore();
    await store.createDirect({ batchId, plan, authorization: { mode: 'direct', actorUserId: access.userId,
      actorId: access.userId, actorType: 'user', actorSessionId: access.sessionId, actorDisplayName: 'Bounded native phase fixture',
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'), jobScope: captureWorkspaceOperationJobScope(access.workspace) } });
    const claimed = await store.claim(randomUUID()); assert(claimed); assert.equal(claimed.batchId, batchId);
    let reservationDelayed = false, targetDelayed = false;
    const transactions: Array<{ xid: string; started: string; delayMs: number }> = [];
    try {
      await store.withClaim(claimed, claim => h.withProbe(async event => {
        const reservation = !reservationDelayed && /INSERT\s+INTO[\s\S]*collaboration_admission_requests/u.test(event.text);
        const targets = !targetDelayed && event.text.includes('collaboration_admission_targets')
          && event.text.includes('ORDER BY document_id COLLATE') && event.text.includes('FOR UPDATE');
        if (!reservation && !targets) return;
        if (reservation) reservationDelayed = true; else targetDelayed = true;
        const backendPid: unknown = Reflect.get(event.client, 'processID');
        assert(typeof backendPid === 'number' && Number.isSafeInteger(backendPid) && backendPid > 0);
        const observed = (await h.admin.query('SELECT backend_xid::text AS xid,xact_start::text AS started FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0];
        assert(observed?.xid && observed.started, 'Observe the actual transaction, never an injected SQL result.');
        const started = performance.now(); await new Promise(resolve => setTimeout(resolve, 2_600));
        transactions.push({ ...observed, delayMs: Math.round(performance.now() - started) });
      }, async () => {
        assert.equal((await advanceWorkspaceOperationNativePathAdmission(claim)).status, 'ready');
      }));
      assert(reservationDelayed && targetDelayed); assert.equal(transactions.length, 2);
      assert(transactions.every(item => item.delayMs >= 2_500));
      assert.notEqual(transactions[0].xid, transactions[1].xid, 'Durable reservation and target proofs require distinct bounded transactions.');
    } finally {
      assert.deepEqual(await fs.readFile(source), bytes);
      assert.deepEqual(await snapshot(), before);
      console.log(JSON.stringify({ suite: 'native-path-phase-boundary-observation', transactions,
        reservationDelayed, targetDelayed, originalFileAndNativeStatePreserved: true }));
    }
  });
  completed = true;
  console.log(JSON.stringify({ suite: 'native-path-phase-boundary-summary', passed: true, actualPostgresAndAuthorization: true }));
}

void workspaceNativePathPhaseBoundaryPostgresTest().catch(error => {
  console.error('Native path phase boundary failed:', { name: error instanceof Error ? error.name : 'NonError',
    codes: failures(error) }); process.exitCode = 1;
});
