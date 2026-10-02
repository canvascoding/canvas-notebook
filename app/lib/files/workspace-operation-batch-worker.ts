import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { buildWorkspaceOperationBatchPlan } from './workspace-operation-batch-plan';
import { executeWorkspaceOperationBatch, getWorkspaceOperationBatchMutationEvidence,
  hasWorkspaceOperationBatchExecution, undoWorkspaceOperationBatch } from './workspace-operation-batch-executor';
import { workspaceOperationBatchErrorCode, workspaceOperationBatchFailureStatus,
  type WorkspaceOperationBatchMutationEvidence } from './workspace-operation-batch-failure';
import { WorkspaceOperationBatchStore, type WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import { markDependentWorkspaceOperationReviews } from './workspace-operation-review-service';
import type { WorkspaceOperationBatchScope, WorkspaceOperationBatchProgress, WorkspaceOperationBatchPlan,
  WorkspaceOperationBatchExecutionResult } from './workspace-operation-batch-contract';

/** Projection can be retried; only completed receipts may remove visible paths. */
export function projectWorkspaceOperationBatchFileViews(input: {
  scope: WorkspaceOperationBatchScope; plan: WorkspaceOperationBatchPlan;
  result: WorkspaceOperationBatchExecutionResult; undo: boolean;
  invalidate?: typeof invalidateWorkspaceFileViews;
}): void {
  if (input.undo && input.result.status !== 'applied') return;
  const receipts = input.result.stepResults?.filter((step) => step.phase === 'path' && step.state === 'applied') ?? [];
  const deleted = input.plan.pathSteps.filter((step) => step.kind === 'delete'
    && (input.result.status === 'applied' || receipts.some((receipt) => receipt.path === step.sourcePath)));
  if (!deleted.length) return;
  (input.invalidate ?? invalidateWorkspaceFileViews)({ fileOptions: input.scope.fileOptions, fullTree: true,
    mutations: deleted.map((step) => ({ path: step.sourcePath, type: input.undo ? 'add' as const : 'unlink' as const })) });
}

async function resolveReviewerScope(batch: WorkspaceOperationBatchRecord): Promise<WorkspaceOperationBatchScope> {
  if (!batch.reviewerUserId) throw new Error('BATCH_ACCESS_DENIED');
  const db = await openDb();
  let user: { id: string; email: string; role: string; name: string; banned: boolean | number | null } | undefined;
  try { user = await db.get('SELECT id,email,role,name,banned FROM "user" WHERE id = $1', [batch.reviewerUserId]) as typeof user; }
  finally { await db.close(); }
  if (!user || user.banned === true || user.banned === 1) throw new Error('BATCH_ACCESS_DENIED');
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(user), batch.workspaceId);
  if (!workspace || workspace.status && workspace.status !== 'active' || !workspace.permissions.canRead
    || !workspace.permissions.canWrite || !workspace.permissions.canDelete) throw new Error('BATCH_ACCESS_DENIED');
  return { workspace, fileOptions: { workspace } };
}

type WorkerDependencies = {
  store?: WorkspaceOperationBatchStore;
  resolveScope?: typeof resolveReviewerScope;
  buildPlan?: typeof buildWorkspaceOperationBatchPlan;
  execute?: typeof executeWorkspaceOperationBatch;
  undo?: typeof undoWorkspaceOperationBatch;
  hasExecution?: typeof hasWorkspaceOperationBatchExecution;
  mutationEvidence?: typeof getWorkspaceOperationBatchMutationEvidence;
  dependentReviews?: typeof markDependentWorkspaceOperationReviews;
  projectFileViews?: typeof projectWorkspaceOperationBatchFileViews;
  lock?: typeof withWorkspaceMutationLock;
};

/** Each tick claims one durable job. Lost leases and unproven receipts never authorize a replay. */
export function createWorkspaceOperationBatchWorker(dependencies: WorkerDependencies = {}) {
  const store = dependencies.store ?? new WorkspaceOperationBatchStore();
  const resolveScope = dependencies.resolveScope ?? resolveReviewerScope;
  const buildPlan = dependencies.buildPlan ?? buildWorkspaceOperationBatchPlan;
  const execute = dependencies.execute ?? executeWorkspaceOperationBatch;
  const undo = dependencies.undo ?? undoWorkspaceOperationBatch;
  const hasExecution = dependencies.hasExecution ?? hasWorkspaceOperationBatchExecution;
  // Legacy test/dependency adapters that only expose existence stay conservative.
  const mutationEvidence = dependencies.mutationEvidence ?? (dependencies.hasExecution
    ? async (batchId: string, workspaceId: string): Promise<WorkspaceOperationBatchMutationEvidence> =>
      await hasExecution(batchId, workspaceId) ? 'started' : 'absent'
    : getWorkspaceOperationBatchMutationEvidence);
  const dependentReviews = dependencies.dependentReviews ?? markDependentWorkspaceOperationReviews;
  const projectFileViews = dependencies.projectFileViews ?? projectWorkspaceOperationBatchFileViews;
  const lock = dependencies.lock ?? withWorkspaceMutationLock;
  const owner = randomUUID();
  let busy = false;
  return {
    async tick(): Promise<boolean> {
      if (busy) return false;
      busy = true;
      let timer: ReturnType<typeof setInterval> | undefined;
      let batch: WorkspaceOperationBatchRecord | null = null;
      let leaseLost = false;
      let renewing = false;
      try {
        batch = await store.claim(owner);
        if (!batch) return false;
        const currentBatch = batch;
        timer = setInterval(() => {
          if (renewing) return;
          renewing = true;
          void store.heartbeat(currentBatch.batchId, owner).then((owned) => { if (!owned) leaseLost = true; })
            .catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
        }, 20_000);
        timer.unref?.();
        await lock(batch.workspaceId, async () => {
          const scope = await resolveScope(currentBatch);
          const gate = async (progress?: WorkspaceOperationBatchProgress) => {
            if (leaseLost || !await store.heartbeat(currentBatch.batchId, owner, progress)) throw new Error('BATCH_LEASE_LOST');
            const fresh = await resolveScope(currentBatch);
            if (fresh.workspace.rootPath !== scope.workspace.rootPath) throw new Error('BATCH_SCOPE_CHANGED');
          };
          await gate();
          const started = await hasExecution(currentBatch.batchId, currentBatch.workspaceId);
          const evidence = await mutationEvidence(currentBatch.batchId, currentBatch.workspaceId, currentBatch.actionMode === 'undo');
          if (currentBatch.completedActions > 0 && (evidence === 'absent' || evidence === 'pristine')
            || evidence === 'absent' && (currentBatch.actionMode === 'undo'
              || ['paths', 'links', 'recovery'].includes(currentBatch.phase))) {
            await store.finish(currentBatch.batchId, owner, { status: 'needs_recovery', errorCode: 'BATCH_JOURNAL_UNAVAILABLE', phase: 'recovery' });
            return;
          }
          if (currentBatch.actionMode === 'apply' && !started) {
            const fresh = await buildPlan({ scope, actions: currentBatch.plan.actions });
            if (fresh.readiness !== 'ready' || fresh.planId !== currentBatch.planId) {
              await store.finish(currentBatch.batchId, owner, { status: 'needs_review', errorCode: 'PREVIEW_STALE' });
              return;
            }
          }
          const result = currentBatch.actionMode === 'undo'
            ? await undo({ batchId: currentBatch.batchId, scope, actorUserId: currentBatch.reviewerUserId!,
              actorDisplayName: currentBatch.reviewerDisplayName ?? 'Workspace user', onProgress: gate })
            : await execute({ batchId: currentBatch.batchId, plan: currentBatch.plan, scope,
              actorUserId: currentBatch.reviewerUserId!, actorDisplayName: currentBatch.reviewerDisplayName ?? 'Workspace user',
              onProgress: gate });
          const refusedUndo = currentBatch.actionMode === 'undo' && result.status === 'failed'
            && await mutationEvidence(currentBatch.batchId, currentBatch.workspaceId, true) === 'pristine';
          const status = currentBatch.actionMode === 'undo' && result.status === 'applied' ? 'undone'
            : refusedUndo ? 'applied' : result.status;
          projectFileViews({ scope, plan: currentBatch.plan, result, undo: currentBatch.actionMode === 'undo' });
          if (result.status === 'applied') await dependentReviews({ scope, plan: currentBatch.plan,
            excludedReviewIds: currentBatch.reviewIds, undo: currentBatch.actionMode === 'undo' });
          await store.finish(currentBatch.batchId, owner, { status,
            errorCode: result.errorCode, trashEntryIds: result.trashEntryIds,
            completedActions: result.completedActions, phase: status === 'applied' || status === 'undone' ? 'complete'
              : result.status === 'needs_recovery' ? 'recovery' : 'preparing' });
        });
        return true;
      } catch (error) {
        if (batch && !leaseLost) {
          const evidence = await mutationEvidence(batch.batchId, batch.workspaceId, batch.actionMode === 'undo').catch(() => null);
          const current = await store.get(batch.batchId).catch(() => null);
          const prior = current ?? batch;
          const unknown = evidence === null || prior.completedActions > 0 && evidence !== 'complete'
            || evidence === 'absent' && (batch.actionMode === 'undo'
            || prior.completedActions > 0 || ['paths', 'links', 'recovery'].includes(prior.phase));
          const code = workspaceOperationBatchErrorCode(error);
          const status = workspaceOperationBatchFailureStatus(code, unknown || evidence === 'started' || evidence === 'complete');
          await store.finish(batch.batchId, owner, { status, errorCode: code,
            phase: status === 'needs_recovery' ? 'recovery' : 'preparing' });
        }
        return Boolean(batch);
      } finally {
        if (timer) clearInterval(timer);
        busy = false;
      }
    },
  };
}

const runtime = globalThis as typeof globalThis & { __canvasWorkspaceOperationBatchWorker?: { stop: () => void } };

export function initializeWorkspaceOperationBatchWorkerRuntime(): { stop: () => void } {
  if (runtime.__canvasWorkspaceOperationBatchWorker) return runtime.__canvasWorkspaceOperationBatchWorker;
  const worker = createWorkspaceOperationBatchWorker();
  const tick = () => { void worker.tick().catch((error) => {
    console.error('[File action worker] Could not claim durable work.', error instanceof Error ? error.name : 'UnknownError');
  }); };
  const timer = setInterval(tick, 1_000);
  timer.unref?.();
  tick();
  const handle = { stop: () => {
    clearInterval(timer);
    if (runtime.__canvasWorkspaceOperationBatchWorker === handle) delete runtime.__canvasWorkspaceOperationBatchWorker;
  } };
  runtime.__canvasWorkspaceOperationBatchWorker = handle;
  return handle;
}
