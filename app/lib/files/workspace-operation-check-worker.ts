import 'server-only';
import { randomUUID } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import { createWorkspaceOperationBatchReview } from './workspace-operation-batch-service';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import { WorkspaceOperationCheckStore, type WorkspaceOperationCheckRecord } from './workspace-operation-check-store';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';

async function resolveCheckScope(job: WorkspaceOperationCheckRecord): Promise<WorkspaceOperationBatchScope> {
  const db = await openDb();
  let user: { id: string; email: string; role: string; name: string; banned: boolean | number | null } | undefined;
  try { user = await db.get('SELECT id,email,role,name,banned FROM "user" WHERE id=$1', [job.requesterUserId]) as typeof user; }
  finally { await db.close(); }
  if (!user || user.banned === true || user.banned === 1) throw new Error('CHECK_ACCESS_DENIED');
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(user), job.workspaceId);
  if (!workspace || workspace.status && workspace.status !== 'active' || !workspace.permissions.canRead
    || !workspace.permissions.canWrite || !workspace.permissions.canDelete) throw new Error('CHECK_ACCESS_DENIED');
  return { workspace, fileOptions: { workspace } };
}
type Dependencies = { store?: WorkspaceOperationCheckStore; resolveScope?: typeof resolveCheckScope;
  preview?: typeof createWorkspaceOperationBatchReview; lock?: typeof withWorkspaceMutationLock };
/** Read-only planning jobs never enqueue approved execution or change workspace files. */
export function createWorkspaceOperationCheckWorker(dependencies: Dependencies = {}) {
  const store = dependencies.store ?? new WorkspaceOperationCheckStore();
  const resolveScope = dependencies.resolveScope ?? resolveCheckScope;
  const preview = dependencies.preview ?? createWorkspaceOperationBatchReview;
  const lock = dependencies.lock ?? withWorkspaceMutationLock;
  const owner = randomUUID();
  let busy = false;
  return { async tick(): Promise<boolean> {
    if (busy) return false;
    busy = true;
    let job: WorkspaceOperationCheckRecord | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lost = false;
    let renewing = false;
    try {
      job = await store.claim(owner);
      if (!job) return false;
      const current = job;
      timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void store.heartbeat(current.checkId, owner).then((held) => { if (!held) lost = true; })
          .catch(() => { lost = true; }).finally(() => { renewing = false; });
      }, 20_000);
      timer.unref?.();
      await lock(current.workspaceId, async () => {
        const scope = await resolveScope(current);
        if (lost || !await store.heartbeat(current.checkId, owner)) return;
        const batch = await preview({ scope, reviewIds: current.reviewIds });
        const fresh = await resolveScope(current);
        if (fresh.workspace.rootPath !== scope.workspace.rootPath) throw new Error('CHECK_SCOPE_CHANGED');
        if (!lost) await store.finish(current.checkId, owner, { status: batch.preview.readiness === 'ready' ? 'ready' : 'blocked', batchId: batch.batchId });
      });
      return true;
    } catch (error) {
      if (job && !lost) {
        const value = error && typeof error === 'object' && 'code' in error ? String(error.code)
          : error instanceof Error ? error.message : '';
        await store.finish(job.checkId, owner, { status: 'failed',
          errorCode: /^[A-Z][A-Z0-9_]{1,127}$/u.test(value) ? value : 'CHECK_FAILED' });
      }
      return Boolean(job);
    } finally { if (timer) clearInterval(timer); busy = false; }
  } };
}
let runtime: { stop: () => void } | undefined;
export function initializeWorkspaceOperationCheckWorkerRuntime(): { stop: () => void } {
  if (runtime) return runtime;
  const worker = createWorkspaceOperationCheckWorker();
  const tick = () => { void worker.tick().catch((error) => console.error('[File review checks] Worker failed:', error)); };
  const timer = setInterval(tick, 1_000);
  timer.unref?.();
  runtime = { stop: () => { clearInterval(timer); runtime = undefined; } };
  tick();
  return runtime;
}
