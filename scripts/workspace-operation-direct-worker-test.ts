import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope, WorkspaceOperationDirectAuthorization } from '../app/lib/files/workspace-operation-batch-contract';
import { WorkspaceOperationBatchError, WorkspaceOperationBatchStore } from '../app/lib/files/workspace-operation-batch-store';
import { createWorkspaceOperationBatchWorker } from '../app/lib/files/workspace-operation-batch-worker';

const planId = 'a'.repeat(64);
type WorkerExecuteInput = Parameters<NonNullable<NonNullable<Parameters<typeof createWorkspaceOperationBatchWorker>[0]>['execute']>>[0];

function authorization(overrides: Partial<WorkspaceOperationDirectAuthorization> = {}): WorkspaceOperationDirectAuthorization {
  return { mode: 'direct', actorUserId: 'initiator', actorId: 'initiator',
    actorDisplayName: 'Initiator', actorType: 'user', requestHash: 'c'.repeat(64), ...overrides };
}

function scope(workspaceId: string): WorkspaceOperationBatchScope {
  return { workspace: { workspaceId, rootPath: `/isolated/${workspaceId}`, workspaceType: 'personal',
    status: 'active', organizationId: null, ownerUserId: 'initiator', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
}

function plan(workspaceId: string, kind: 'move' | 'delete' = 'move'): WorkspaceOperationBatchPlan {
  const actionId = `direct_action_${workspaceId}`;
  const selections = [{ sourcePath: 'old.md', ...(kind === 'move' ? { destinationPath: 'new.md' } : {}) }];
  return { version: 1, workspaceId, planId, readiness: 'ready',
    actions: [{ reviewId: actionId, kind, selections }],
    pathMappings: [], deletedPaths: [], pathSteps: [{ reviewId: actionId, kind, ...selections[0] }],
    linkEdits: [], originalDocuments: [], previewContents: [], expectedPathState: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
    linkAssessment: { version: 1, complete: true, blockers: [], warnings: [] }, issues: [], linkPlan: {} as never };
}

const complete = { status: 'applied' as const, trashEntryIds: [], completedActions: 1, totalActions: 1, errorCode: null };
const inlineLock = async <T>(_workspaceId: string, work: () => Promise<T>): Promise<T> => work();
const ignoreProjection = () => undefined;

async function main(): Promise<void> {
  const pg = new PGlite();
  let clock = 1_000;
  const connect = async (): Promise<SqlConnection> => ({
    get: async (sql, params = []) => (await pg.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await pg.query(sql, params)).rows,
    run: async (sql, params = []) => pg.query(sql, params), close: () => undefined,
  });
  const store = new WorkspaceOperationBatchStore(connect, () => clock);
  const create = async (name: string, grant = authorization(), kind: 'move' | 'delete' = 'move') => {
    clock += 1;
    const batchId = `direct_${name}_1234567890`;
    const snapshot = plan(`${name}-workspace`, kind);
    const batch = await store.createDirect({ batchId, plan: snapshot, authorization: grant });
    return { batchId, snapshot, batch, grant };
  };
  const reviewCount = async () => Number((await pg.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM workspace_file_operation_reviews')).rows[0]!.count);
  const settle = async (batchId: string, owner: string) => {
    const claimed = await store.claim(owner);
    assert.equal(claimed?.batchId, batchId);
    await store.finish(batchId, owner, complete);
  };
  const rejectsWith = (status: number, code?: string) => (error: unknown) => error instanceof WorkspaceOperationBatchError
    && error.status === status && (!code || error.code === code);
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);

    const ready = await create('ready');
    assert.equal(ready.batch.status, 'queued', 'a direct request is durably queued without review acceptance');
    assert.deepEqual(ready.batch.authorization, ready.grant);
    assert.deepEqual(ready.batch.reviewIds, []);
    assert.deepEqual(ready.batch.reviewRefs, []);
    assert.equal(ready.batch.reviewerUserId, null);
    assert.equal(ready.batch.reviewerDisplayName, null);
    assert.equal(await reviewCount(), 0, 'direct jobs never manufacture a review proposal or reviewer');
    const beforeRetry = await store.get(ready.batchId);
    const retry = await store.createDirect({ batchId: ready.batchId,
      plan: { ...ready.snapshot, planId: 'b'.repeat(64) }, authorization: ready.grant });
    assert.deepEqual(retry, beforeRetry, 'retry keeps the original immutable plan and lifecycle');
    for (const conflicting of [
      { plan: ready.snapshot, authorization: authorization({ requestHash: 'd'.repeat(64) }) },
      { plan: { ...ready.snapshot, workspaceId: 'different-workspace' }, authorization: ready.grant },
      { plan: ready.snapshot, authorization: authorization({ actorUserId: 'different-user' }) },
      { plan: ready.snapshot, authorization: authorization({ actorId: 'different-actor' }) },
      { plan: ready.snapshot, authorization: authorization({ actorType: 'agent', actorSessionId: 'different-session' }) },
    ]) {
      await assert.rejects(store.createDirect({ batchId: ready.batchId, ...conflicting }),
        (error: unknown) => error instanceof WorkspaceOperationBatchError && error.status === 409);
      assert.deepEqual(await store.get(ready.batchId), beforeRetry, 'conflicting retry cannot replace original authority');
    }
    await assert.rejects(store.enqueue({ batchId: ready.batchId, planId, action: 'accept',
      userId: 'initiator', displayName: 'Initiator' }),
    rejectsWith(403, 'BATCH_DIRECT_AUTHORIZATION_REQUIRED'));
    assert.deepEqual(await store.get(ready.batchId), beforeRetry, 'review acceptance cannot authorize a direct job');
    await settle(ready.batchId, 'ready-worker');
    const settled = await store.get(ready.batchId);
    assert.deepEqual(await store.createDirect({ batchId: ready.batchId, plan: ready.snapshot, authorization: ready.grant }),
      settled, 'a repeated direct request never queues an already completed operation again');

    const reviewed = await store.create({ batchId: 'reviewed_preview_1234567890', plan: plan('review-workspace'), reviewRefs: [] });
    assert.deepEqual(reviewed.authorization, { mode: 'review' });
    assert.equal(reviewed.status, 'preview', 'review creation still requires an explicit acceptance');
    assert.equal(await store.claim('review-preview-worker'), null);
    const blockedPlan = { ...plan('blocked-workspace'), readiness: 'blocked' as const,
      issues: [{ code: 'affected-unresolved-link', path: 'index.md', detail: 'Ambiguous backlink' }] };
    const blocked = await store.createDirect({ batchId: 'direct_blocked_1234567890', plan: blockedPlan,
      authorization: authorization() });
    assert.equal(blocked.status, 'blocked', 'unsafe automatic requests remain durable and cannot execute');
    assert.equal(blocked.reviewerUserId, null);
    assert.deepEqual(blocked.reviewIds, []);
    assert.equal(await store.claim('blocked-worker'), null);
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    assert.deepEqual((await store.get(blocked.batchId))!.authorization, authorization(),
      'repeated additive migrations preserve direct authority');
    assert.deepEqual((await store.get(reviewed.batchId))!.authorization, { mode: 'review' });
    for (const invalidGrant of [{ mode: 'review' }, authorization({ actorUserId: '' }),
      authorization({ requestHash: 'invalid-hash' }), authorization({ actorType: 'agent', actorSessionId: undefined })]) {
      await assert.rejects(store.createDirect({ batchId: 'direct_invalid_1234567890', plan: plan('invalid-workspace'),
        authorization: invalidGrant as WorkspaceOperationDirectAuthorization }), rejectsWith(409, 'BATCH_INVALID_AUTHORIZATION'));
      assert.equal(await store.get('direct_invalid_1234567890'), null, 'invalid authority cannot create a queued job');
    }

    const first = await create('lease-first');
    clock += 1;
    const secondId = 'direct_lease_second_1234567890';
    await store.createDirect({ batchId: secondId, plan: first.snapshot,
      authorization: authorization({ requestHash: 'e'.repeat(64) }) });
    assert.equal((await store.claim('old-worker'))!.batchId, first.batchId);
    assert.equal(await store.claim('competing-worker'), null, 'another direct job cannot overtake the active workspace job');
    clock += 90_001;
    assert.equal((await store.claim('replacement-worker'))!.batchId, first.batchId,
      'a fresh process reclaims the expired original direct job');
    assert.equal(await store.heartbeat(first.batchId, 'old-worker'), false);
    assert.equal(await store.finish(first.batchId, 'old-worker', complete), null,
      'an expired worker cannot acknowledge another worker\'s execution');
    await store.finish(first.batchId, 'replacement-worker', complete);
    await settle(secondId, 'second-worker');

    const stale = await create('stale');
    let writes = 0;
    await createWorkspaceOperationBatchWorker({ store, lock: inlineLock,
      resolveScope: async () => scope(stale.snapshot.workspaceId), hasExecution: async () => false,
      mutationEvidence: async () => 'absent', buildPlan: async () => ({ ...stale.snapshot, planId: 'b'.repeat(64) }),
      execute: async () => { writes += 1; throw new Error('UNEXPECTED_MUTATION'); },
      dependentReviews: async () => undefined, projectFileViews: ignoreProjection }).tick();
    assert.equal((await store.get(stale.batchId))!.status, 'needs_review');
    assert.equal((await store.get(stale.batchId))!.errorCode, 'PREVIEW_STALE');
    assert.equal(writes, 0, 'a direct grant does not bypass current link-plan validation');
    assert.equal(await reviewCount(), 0);

    const agentGrant = authorization({ actorId: 'agent-runtime-1', actorDisplayName: 'Agent author',
      actorType: 'agent', actorSessionId: 'agent-session-1' });
    const agent = await create('agent', agentGrant, 'delete');
    for (const changedGrant of [{ ...agentGrant, actorId: 'another-runtime' },
      { ...agentGrant, actorSessionId: 'another-session' }, { ...agentGrant, actorType: 'user' as const }]) {
      await assert.rejects(store.createDirect({ batchId: agent.batchId, plan: agent.snapshot, authorization: changedGrant }),
        rejectsWith(409, 'BATCH_IDEMPOTENCY_CONFLICT'));
    }
    let captured: WorkerExecuteInput | undefined;
    let resolved = 0;
    await createWorkspaceOperationBatchWorker({ store, lock: inlineLock,
      resolveScope: async (batch) => {
        resolved += 1;
        assert.deepEqual(batch.authorization, agentGrant);
        assert.equal(batch.reviewerUserId, null);
        return scope(agent.snapshot.workspaceId);
      }, hasExecution: async () => false, mutationEvidence: async () => 'absent', buildPlan: async () => agent.snapshot,
      execute: async (input) => { captured = input; await input.onProgress?.({ completedActions: 0, totalActions: 1, phase: 'paths' }); return complete; },
      dependentReviews: async () => undefined, projectFileViews: ignoreProjection }).tick();
    assert.ok(captured);
    assert.equal(captured.actorUserId, agentGrant.actorUserId);
    assert.equal(captured.actorId, agentGrant.actorId);
    assert.equal(captured.actorDisplayName, agentGrant.actorDisplayName);
    assert.equal(captured.actorType, 'agent');
    assert.equal(captured.actorSessionId, agentGrant.actorSessionId);
    assert.ok(resolved >= 3, 'scope is checked initially and at each progress boundary');
    const appliedAgent = (await store.get(agent.batchId))!;
    assert.equal(appliedAgent.status, 'applied');
    assert.equal(appliedAgent.reviewerUserId, null);
    assert.deepEqual(appliedAgent.authorization, agentGrant);

    const interrupted = await create('restart', agentGrant, 'delete');
    let durablePathReceipt = false;
    let mutations = 0;
    let freshPlans = 0;
    let executions = 0;
    const restartDependencies = { store, lock: inlineLock,
      resolveScope: async () => scope(interrupted.snapshot.workspaceId), hasExecution: async () => durablePathReceipt,
      mutationEvidence: async () => durablePathReceipt ? 'started' as const : 'absent' as const,
      buildPlan: async () => { freshPlans += 1; return interrupted.snapshot; },
      execute: async (input: WorkerExecuteInput) => {
        executions += 1;
        assert.equal(input.actorId, agentGrant.actorId);
        if (!durablePathReceipt) {
          await input.onProgress?.({ completedActions: 0, totalActions: 1, phase: 'paths' });
          mutations += 1; durablePathReceipt = true;
          throw new Error('PROCESS_INTERRUPTED');
        }
        await input.onProgress?.({ completedActions: 1, totalActions: 1, phase: 'links' });
        return complete;
      }, dependentReviews: async () => undefined, projectFileViews: ignoreProjection };
    await createWorkspaceOperationBatchWorker(restartDependencies).tick();
    const recovery = (await store.get(interrupted.batchId))!;
    assert.equal(recovery.status, 'needs_recovery');
    assert.equal(recovery.reviewerUserId, null);
    await assert.rejects(store.enqueue({ batchId: interrupted.batchId, planId, action: 'resume',
      userId: 'another-user', displayName: 'Another user' }), rejectsWith(403));
    assert.deepEqual(await store.get(interrupted.batchId), recovery);
    const resumed = await store.enqueue({ batchId: interrupted.batchId, planId, action: 'resume',
      userId: agentGrant.actorUserId, displayName: 'Renamed initiating user' });
    assert.equal(resumed.status, 'queued');
    assert.equal(resumed.reviewerUserId, null);
    assert.equal(resumed.reviewerDisplayName, null);
    assert.deepEqual(resumed.authorization, agentGrant, 'resume retains original agent attribution');
    await createWorkspaceOperationBatchWorker(restartDependencies).tick();
    assert.equal((await store.get(interrupted.batchId))!.status, 'applied');
    assert.equal(mutations, 1, 'receipt recovery never repeats the physical delete');
    assert.equal(freshPlans, 1, 'partially executed direct jobs use their stored plan');
    assert.equal(executions, 2);
    const beforeUndo = await store.get(interrupted.batchId);
    await assert.rejects(store.enqueue({ batchId: interrupted.batchId, planId, action: 'undo',
      userId: 'another-user', displayName: 'Another user' }), rejectsWith(403));
    assert.deepEqual(await store.get(interrupted.batchId), beforeUndo);
    const undoQueued = await store.enqueue({ batchId: interrupted.batchId, planId, action: 'undo',
      userId: agentGrant.actorUserId, displayName: 'Initiator' });
    assert.equal(undoQueued.actionMode, 'undo');
    assert.equal(undoQueued.reviewerUserId, null);
    assert.deepEqual(undoQueued.authorization, agentGrant);
    let undos = 0;
    await createWorkspaceOperationBatchWorker({ store, lock: inlineLock,
      resolveScope: async () => scope(interrupted.snapshot.workspaceId), hasExecution: async () => true,
      mutationEvidence: async () => 'complete',
      undo: async (input) => {
        undos += 1;
        assert.equal(input.actorUserId, agentGrant.actorUserId);
        await input.onProgress?.({ completedActions: 1, totalActions: 1, phase: 'complete' });
        return complete;
      }, dependentReviews: async () => undefined, projectFileViews: ignoreProjection }).tick();
    assert.equal(undos, 1);
    assert.equal((await store.get(interrupted.batchId))!.status, 'undone');
    assert.equal((await store.get(interrupted.batchId))!.reviewerUserId, null);

    const revoked = await create('revoked-progress');
    let permissionRevoked = false;
    let pathMutated = false;
    let writesAfterRevocation = 0;
    await createWorkspaceOperationBatchWorker({ store, lock: inlineLock,
      resolveScope: async () => {
        if (permissionRevoked) throw new Error('BATCH_ACCESS_DENIED');
        return scope(revoked.snapshot.workspaceId);
      }, hasExecution: async () => pathMutated,
      mutationEvidence: async () => pathMutated ? 'started' : 'absent', buildPlan: async () => revoked.snapshot,
      execute: async (input) => {
        await input.onProgress?.({ completedActions: 0, totalActions: 2, phase: 'paths' });
        pathMutated = true; permissionRevoked = true;
        await input.onProgress?.({ completedActions: 1, totalActions: 2, phase: 'links' });
        writesAfterRevocation += 1;
        return complete;
      }, dependentReviews: async () => undefined, projectFileViews: ignoreProjection }).tick();
    const revokedJob = (await store.get(revoked.batchId))!;
    assert.equal(revokedJob.status, 'needs_recovery');
    assert.equal(revokedJob.errorCode, 'BATCH_ACCESS_DENIED');
    assert.equal(writesAfterRevocation, 0, 'permission loss after a path receipt stops the next link write');
    assert.equal(revokedJob.reviewerUserId, null);
    assert.equal(await reviewCount(), 0, 'success, stale plans, recovery and Undo remain independent of reviews');
    console.log('direct file worker: immutable durable authorization, no fake review, lease takeover, stale plan, agent attribution, exact resume/Undo and progress permission fence OK');
  } finally { await pg.close(); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
