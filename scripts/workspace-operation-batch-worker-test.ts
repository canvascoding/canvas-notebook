import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { WorkspaceOperationBatchStore, WorkspaceOperationBatchError } from '../app/lib/files/workspace-operation-batch-store';
import { createWorkspaceOperationBatchWorker, projectWorkspaceOperationBatchFileViews } from '../app/lib/files/workspace-operation-batch-worker';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';

const planId = 'a'.repeat(64);
const scope = (id = 'workspace'): WorkspaceOperationBatchScope => ({ workspace: {
  workspaceId: id, rootPath: `/isolated/${id}`, workspaceType: 'personal', status: 'active',
  organizationId: null, ownerUserId: 'reviewer', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
    canManageWorkspace: true, canCreatePublicLinks: false },
}, fileOptions: {} });

function plan(reviewId: string, workspaceId = 'workspace'): WorkspaceOperationBatchPlan {
  return { version: 1, workspaceId, planId, readiness: 'ready',
    actions: [{ reviewId, kind: 'move', selections: [{ sourcePath: 'old', destinationPath: 'new' }] }],
    pathMappings: [], deletedPaths: [], pathSteps: [{ reviewId, kind: 'move', sourcePath: 'old', destinationPath: 'new' }],
    linkEdits: [], originalDocuments: [], previewContents: [], expectedPathState: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
    linkAssessment: { version: 1, complete: true, blockers: [], warnings: [] }, issues: [], linkPlan: {} as never };
}

async function main(): Promise<void> {
  const pg = new PGlite();
  let clock = 1_000;
  const connect = async (): Promise<SqlConnection> => ({
    get: async (sql, params = []) => (await pg.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await pg.query(sql, params)).rows,
    run: async (sql, params = []) => pg.query(sql, params), close: () => undefined,
  });
  const store = new WorkspaceOperationBatchStore(connect, () => clock);
  const seed = async (name: string, workspaceId = 'workspace') => {
    const reviewId = `review_${name}_1234567890`;
    const batchId = `batch_${name}_1234567890`;
    const snapshot = plan(reviewId, workspaceId);
    await pg.query(`INSERT INTO workspace_file_operation_reviews
      (review_id,plan_id,request_hash,request_json,preview_json,source_workspace_id,destination_workspace_id,
       actor_user_id,actor_id,actor_display_name,status,reason_codes_json,created_at,updated_at)
      VALUES ($1,$2,$2,$3,'{}',$4,$4,'reviewer','agent','Agent','pending','[]',$5,$5)`,
    [reviewId, planId, JSON.stringify(snapshot.actions[0]), workspaceId, clock]);
    await store.create({ batchId, plan: snapshot, reviewRefs: [{ reviewId, planId, status: 'pending' }] });
    const enqueue = () => store.enqueue({ batchId, planId, userId: 'reviewer', displayName: 'Reviewer' });
    return { batchId, reviewId, snapshot, enqueue };
  };
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    const first = await seed('ordered');
    await first.enqueue();
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    assert.equal((await first.enqueue()).status, 'queued', 'idempotent acceptance and repeated migrations preserve queued work');
    await assert.rejects(store.enqueue({ batchId: first.batchId, planId: 'b'.repeat(64), userId: 'reviewer', displayName: 'Reviewer' }),
      (error: unknown) => error instanceof WorkspaceOperationBatchError && error.code === 'PREVIEW_STALE');
    clock += 1;
    const second = await seed('second');
    await second.enqueue();
    const ownerA = 'worker-a';
    assert.equal((await store.claim(ownerA))!.batchId, first.batchId);
    assert.equal(await store.claim('worker-b'), null, 'a second job cannot overtake the active job in its workspace');
    clock += 90_001;
    assert.equal((await store.claim('worker-b'))!.batchId, first.batchId, 'restart reclaims the expired original job first');
    assert.equal(await store.heartbeat(first.batchId, ownerA), false, 'old worker loses authority after lease takeover');
    assert.equal(await store.finish(first.batchId, ownerA, { status: 'applied' }), null);
    await store.finish(first.batchId, 'worker-b', { status: 'applied', completedActions: 1 });
    assert.equal((await store.claim(ownerA))!.batchId, second.batchId);
    await store.finish(second.batchId, ownerA, { status: 'applied', completedActions: 1 });

    const stale = await seed('stale', 'stale-workspace');
    await stale.enqueue();
    let mutations = 0;
    const staleWorker = createWorkspaceOperationBatchWorker({ store,
      resolveScope: async () => scope('stale-workspace'), lock: async (_id, action) => action(),
      hasExecution: async () => false, buildPlan: async () => ({ ...stale.snapshot, planId: 'b'.repeat(64) }),
      execute: async () => { mutations += 1; throw new Error('unexpected mutation'); }, dependentReviews: async () => undefined });
    await staleWorker.tick();
    assert.equal((await store.get(stale.batchId))!.status, 'needs_review');
    const staleReview = (await pg.query<{ status: string; batch_id: string | null }>(
      'SELECT status,batch_id FROM workspace_file_operation_reviews WHERE review_id = $1', [stale.reviewId])).rows[0]!;
    assert.deepEqual(staleReview, { status: 'stale', batch_id: null }, 'fresh approval can replace a stale queued plan');
    assert.equal(mutations, 0);

    for (const [name, evidence, completed, phase] of [
      ['missing-receipt', 'absent', 1, 'paths'], ['missing-intent', 'absent', 0, 'paths'],
      ['missing-recovery', 'absent', 0, 'recovery'], ['rolled-back-journal', 'pristine', 1, 'paths'],
      ['corrupt-journal', 'corrupt', 0, 'preparing'],
    ] as const) {
      const damaged = await seed(name, `${name}-workspace`); await damaged.enqueue();
      await pg.query('UPDATE workspace_file_operation_batches SET completed_actions = $2, phase = $3 WHERE batch_id = $1',
        [damaged.batchId, completed, phase]);
      let freshBuilds = 0; let writes = 0;
      await createWorkspaceOperationBatchWorker({ store, resolveScope: async () => scope(`${name}-workspace`),
        lock: async (_id, action) => action(), hasExecution: async () => evidence !== 'absent',
        mutationEvidence: async () => { if (evidence === 'corrupt') throw new Error('BATCH_CORRUPT_MANIFEST'); return evidence; },
        buildPlan: async () => { freshBuilds += 1; return damaged.snapshot; },
        execute: async () => { writes += 1; throw new Error('unexpected mutation'); } }).tick();
      const row = (await store.get(damaged.batchId))!;
      assert.equal(row.status, 'needs_recovery', name); assert.equal(row.completedActions, completed, name);
      assert.equal(freshBuilds, 0, `${name}: ambiguous old writes cannot be freshly planned`);
      assert.equal(writes, 0, `${name}: ambiguous journal cannot reach mutation`);
    }
    const conflict = await seed('typed-live-conflict', 'typed-live-conflict-workspace'); await conflict.enqueue();
    await createWorkspaceOperationBatchWorker({ store, resolveScope: async () => scope('typed-live-conflict-workspace'),
      lock: async (_id, action) => action(), hasExecution: async () => true, mutationEvidence: async () => 'pristine',
      execute: async () => { throw Object.assign(new Error('Private prose changed after preflight.'), { code: 'LINK_WRITE_STALE' }); },
    }).tick();
    const conflictRow = (await store.get(conflict.batchId))!;
    assert.equal(conflictRow.status, 'needs_review'); assert.equal(conflictRow.errorCode, 'LINK_WRITE_STALE');
    const conflictReview = (await pg.query<{ status: string; batch_id: string | null; operation_id: string | null }>(
      'SELECT status,batch_id,operation_id FROM workspace_file_operation_reviews WHERE review_id = $1', [conflict.reviewId])).rows[0]!;
    assert.deepEqual(conflictReview, { status: 'stale', batch_id: null, operation_id: null }, 'pre-intent live conflict releases review reservations');

    const returnedConflict = await seed('returned-live-conflict', 'returned-live-conflict-workspace'); await returnedConflict.enqueue();
    await createWorkspaceOperationBatchWorker({ store, resolveScope: async () => scope('returned-live-conflict-workspace'),
      lock: async (_id, action) => action(), hasExecution: async () => true, mutationEvidence: async () => 'pristine',
      execute: async () => ({ status: 'needs_review', errorCode: 'LINK_WRITE_STALE', completedActions: 0, totalActions: 1, trashEntryIds: [] }),
    }).tick();
    assert.equal((await store.get(returnedConflict.batchId))!.status, 'needs_review');
    assert.equal((await store.get(returnedConflict.batchId))!.phase, 'preparing');

    const retryBeforeIntent = await seed('retry-before-intent', 'retry-before-intent-workspace'); await retryBeforeIntent.enqueue();
    let interruptedBeforeIntent = true;
    const retryDependencies = { store, resolveScope: async () => scope('retry-before-intent-workspace'),
      lock: async <T>(_id: string, action: () => Promise<T>) => action(), hasExecution: async () => true,
      mutationEvidence: async () => 'pristine' as const,
      execute: async () => {
        if (interruptedBeforeIntent) { interruptedBeforeIntent = false; throw new Error('WORKER_INTERRUPTED'); }
        throw Object.assign(new Error('Peer prose changed while the worker was stopped.'), { code: 'LINK_WRITE_STALE' });
      } };
    await createWorkspaceOperationBatchWorker(retryDependencies).tick();
    assert.equal((await store.get(retryBeforeIntent.batchId))!.status, 'failed');
    assert.equal((await store.get(retryBeforeIntent.batchId))!.phase, 'preparing');
    await store.enqueue({ batchId: retryBeforeIntent.batchId, planId, action: 'resume', userId: 'reviewer', displayName: 'Reviewer' });
    await createWorkspaceOperationBatchWorker(retryDependencies).tick();
    assert.equal((await store.get(retryBeforeIntent.batchId))!.status, 'needs_review', 'pre-intent failed retry cannot strand a newly stale review');

    const missingUndo = await seed('missing-undo', 'missing-undo-workspace'); await missingUndo.enqueue();
    await store.claim('missing-undo-original'); await store.finish(missingUndo.batchId, 'missing-undo-original', { status: 'applied', completedActions: 1 });
    await store.enqueue({ batchId: missingUndo.batchId, planId, action: 'undo', userId: 'reviewer', displayName: 'Reviewer' });
    let undoCalls = 0;
    await createWorkspaceOperationBatchWorker({ store, resolveScope: async () => scope('missing-undo-workspace'),
      lock: async (_id, action) => action(), hasExecution: async () => false, mutationEvidence: async () => 'absent',
      undo: async () => { undoCalls += 1; throw new Error('unexpected Undo'); } }).tick();
    assert.equal((await store.get(missingUndo.batchId))!.status, 'needs_recovery'); assert.equal(undoCalls, 0);

    const refusedUndo = await seed('refused-undo', 'refused-undo-workspace'); await refusedUndo.enqueue();
    await store.claim('refused-undo-original'); await store.finish(refusedUndo.batchId, 'refused-undo-original', { status: 'applied', completedActions: 1 });
    await store.enqueue({ batchId: refusedUndo.batchId, planId, action: 'undo', userId: 'reviewer', displayName: 'Reviewer' });
    await createWorkspaceOperationBatchWorker({ store, resolveScope: async () => scope('refused-undo-workspace'),
      lock: async (_id, action) => action(), hasExecution: async () => true, mutationEvidence: async () => 'pristine',
      undo: async () => ({ status: 'failed', errorCode: 'BATCH_UNDO_LINK_CHANGED', completedActions: 1, totalActions: 1, trashEntryIds: [] }),
    }).tick();
    assert.equal((await store.get(refusedUndo.batchId))!.status, 'applied', 'pre-intent Undo refusal preserves the completed forward receipt');
    assert.equal((await store.get(refusedUndo.batchId))!.errorCode, 'BATCH_UNDO_LINK_CHANGED');

    const zeroAck = await seed('zero-ack-intent', 'zero-ack-intent-workspace'); await zeroAck.enqueue();
    await createWorkspaceOperationBatchWorker({ store, resolveScope: async () => scope('zero-ack-intent-workspace'),
      lock: async (_id, action) => action(), hasExecution: async () => true, mutationEvidence: async () => 'started',
      execute: async () => { throw Object.assign(new Error('Private document changed after move intent.'), { code: 'LINK_WRITE_STALE' }); },
    }).tick();
    assert.equal((await store.get(zeroAck.batchId))!.status, 'needs_recovery');
    assert.equal((await store.get(zeroAck.batchId))!.completedActions, 0);
    assert.equal((await store.get(zeroAck.batchId))!.errorCode, 'LINK_WRITE_STALE');
    const intentReview = (await pg.query<{ status: string; batch_id: string | null }>(
      'SELECT status,batch_id FROM workspace_file_operation_reviews WHERE review_id = $1', [zeroAck.reviewId])).rows[0]!;
    assert.equal(intentReview.status, 'needs_recovery'); assert.equal(intentReview.batch_id, zeroAck.batchId);

    const restart = await seed('restart', 'restart-workspace');
    await restart.enqueue();
    let durableReceipt = false;
    let executes = 0;
    let builds = 0;
    let dependentRefreshes = 0;
    const dependencies = { store, resolveScope: async () => scope('restart-workspace'),
      lock: async <T>(_id: string, action: () => Promise<T>) => action(),
      hasExecution: async () => durableReceipt,
      buildPlan: async () => { builds += 1; return restart.snapshot; },
      execute: async (input: Parameters<NonNullable<NonNullable<Parameters<typeof createWorkspaceOperationBatchWorker>[0]>['execute']>>[0]) => {
        executes += 1;
        await input.onProgress?.({ completedActions: durableReceipt ? 1 : 0, totalActions: 1, phase: 'paths' });
        if (!durableReceipt) { mutations += 1; durableReceipt = true; throw new Error('PROCESS_INTERRUPTED'); }
        return { status: 'applied' as const, trashEntryIds: [], errorCode: null, completedActions: 1, totalActions: 1 };
      }, dependentReviews: async () => { dependentRefreshes += 1; } };
    await createWorkspaceOperationBatchWorker(dependencies).tick();
    assert.equal((await store.get(restart.batchId))!.status, 'needs_recovery');
    const recoveryBefore = await store.get(restart.batchId);
    await assert.rejects(store.enqueue({ batchId: restart.batchId, planId, action: 'resume',
      userId: 'second-reviewer', displayName: 'Second reviewer' }),
    (error: unknown) => error instanceof WorkspaceOperationBatchError
      && error.status === 403 && error.code === 'BATCH_RESUME_REVIEWER_REQUIRED');
    assert.deepEqual(await store.get(restart.batchId), recoveryBefore,
      'another authorized reviewer cannot silently replace the manifest actor or queue a failing replay');
    await store.enqueue({ batchId: restart.batchId, planId, action: 'resume', userId: 'reviewer', displayName: 'Reviewer' });
    await createWorkspaceOperationBatchWorker(dependencies).tick();
    assert.equal((await store.get(restart.batchId))!.status, 'applied');
    assert.equal(mutations, 1, 'restart recovery delegates the exact persisted plan without replaying its receipt');
    assert.equal(executes, 2);
    assert.equal(builds, 1, 'mutated state is never replanned during recovery');
    assert.equal(dependentRefreshes, 1);
    const undoByOtherReviewer = await store.enqueue({ batchId: restart.batchId, planId, action: 'undo',
      userId: 'second-reviewer', displayName: 'Second reviewer' });
    assert.equal(undoByOtherReviewer.actionMode, 'undo', 'Undo can still be approved by another authorized reviewer');
    assert.equal(undoByOtherReviewer.reviewerUserId, 'second-reviewer');
    const undoClaim = await store.claim('undo-worker');
    assert.equal(undoClaim?.batchId, restart.batchId);
    await store.finish(restart.batchId, 'undo-worker', { status: 'needs_recovery', errorCode: 'INTERRUPTED_UNDO' });
    await assert.rejects(store.enqueue({ batchId: restart.batchId, planId, action: 'resume',
      userId: 'reviewer', displayName: 'Reviewer' }),
    (error: unknown) => error instanceof WorkspaceOperationBatchError && error.code === 'BATCH_RESUME_REVIEWER_REQUIRED');
    const resumedUndo = await store.enqueue({ batchId: restart.batchId, planId, action: 'resume',
      userId: 'second-reviewer', displayName: 'Renamed reviewer' });
    assert.equal(resumedUndo.actionMode, 'undo');
    assert.equal(resumedUndo.reviewerDisplayName, 'Second reviewer', 'resume preserves the approved actor metadata');
    await store.claim('undo-worker');
    await store.finish(restart.batchId, 'undo-worker', { status: 'undone' });

    const revoked = await seed('revoked', 'revoked-workspace');
    await revoked.enqueue();
    await createWorkspaceOperationBatchWorker({ store, resolveScope: async () => { throw new Error('BATCH_ACCESS_DENIED'); },
      lock: async (_id, action) => action(), hasExecution: async () => false,
      execute: async () => { mutations += 1; throw new Error('unexpected mutation'); } }).tick();
    assert.equal((await store.get(revoked.batchId))!.status, 'failed');
    assert.equal((await store.get(revoked.batchId))!.errorCode, 'BATCH_ACCESS_DENIED');
    assert.equal(mutations, 1, 'permissions are resolved at execution time after queueing');
    const deletePlan = { ...plan('review-delete'), pathSteps: [
      { reviewId: 'review-delete', kind: 'delete' as const, sourcePath: 'deleted.md' },
      { reviewId: 'review-delete', kind: 'delete' as const, sourcePath: 'remaining.md' },
    ] };
    const projections: Array<Array<{ path: string; type: string }>> = [];
    const invalidate = (input: Parameters<NonNullable<Parameters<typeof projectWorkspaceOperationBatchFileViews>[0]['invalidate']>>[0]) => {
      assert.equal(input?.fullTree, true);
      projections.push(input?.mutations ?? []);
    };
    const interrupted = { status: 'needs_recovery' as const, trashEntryIds: ['receipt'], errorCode: 'LINK_FAILURE',
      completedActions: 1, totalActions: 3, stepResults: [{ key: 'path-0', phase: 'path' as const,
        state: 'applied' as const, path: 'deleted.md', trashEntryId: 'receipt' }] };
    projectWorkspaceOperationBatchFileViews({ scope: scope(), plan: deletePlan, result: interrupted, undo: false, invalidate });
    assert.deepEqual(projections, [[{ path: 'deleted.md', type: 'unlink' }]], 'partial cleanup only removes receipted paths');
    projectWorkspaceOperationBatchFileViews({ scope: scope(), plan: deletePlan, result: interrupted, undo: true, invalidate });
    assert.equal(projections.length, 1, 'incomplete Undo never advertises restoration');
    projectWorkspaceOperationBatchFileViews({ scope: scope(), plan: deletePlan,
      result: { ...interrupted, status: 'applied', errorCode: null }, undo: true, invalidate });
    assert.deepEqual(projections[1], [{ path: 'deleted.md', type: 'add' }, { path: 'remaining.md', type: 'add' }]);
    console.log('workspace batch worker: durable approval, idempotent migrations, ordered leases, stale guards, restart receipts, revoked access OK');
    console.log('workspace batch projection: receipted partial deletion only, incomplete Undo withheld, restored paths published OK');
    console.log('workspace batch resume: alternate reviewer denied before enqueue, original manifest actor retained, alternate authorized Undo and its reviewer resume preserved OK');
  } finally { await pg.close(); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
