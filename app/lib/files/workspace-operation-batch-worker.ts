import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { buildWorkspaceOperationBatchPlan } from './workspace-operation-batch-plan';
import { executeWorkspaceOperationBatch, hasWorkspaceOperationBatchExecution, undoWorkspaceOperationBatch } from './workspace-operation-batch-executor';
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
          const status = currentBatch.actionMode === 'undo' && result.status === 'applied' ? 'undone' : result.status;
          projectFileViews({ scope, plan: currentBatch.plan, result, undo: currentBatch.actionMode === 'undo' });
          if (result.status === 'applied') await dependentReviews({ scope, plan: currentBatch.plan,
            excludedReviewIds: currentBatch.reviewIds, undo: currentBatch.actionMode === 'undo' });
          await store.finish(currentBatch.batchId, owner, { status,
            errorCode: result.errorCode, trashEntryIds: result.trashEntryIds,
            completedActions: result.completedActions, phase: result.status === 'applied' ? 'complete' : 'recovery' });
        });
        return true;
      } catch (error) {
        if (batch && !leaseLost) {
          const started = await hasExecution(batch.batchId, batch.workspaceId).catch(() => true);
          const namedCode = error && typeof error === 'object' && 'code' in error ? String(error.code)
            : error instanceof Error ? error.message : '';
          await store.finish(batch.batchId, owner, { status: started ? 'needs_recovery' : 'failed',
            errorCode: /^[A-Z][A-Z0-9_]{1,127}$/u.test(namedCode) ? namedCode : 'BATCH_EXECUTION_FAILED', phase: 'recovery' });
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
