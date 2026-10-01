/** Kill this disposable fixture process after one receipted path step, without production fault switches. */
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import { createWorkspaceOperationBatchReview, enqueueWorkspaceOperationBatch } from '../app/lib/files/workspace-operation-batch-service';
import { WorkspaceOperationBatchStore } from '../app/lib/files/workspace-operation-batch-store';
import { executeWorkspaceOperationBatch } from '../app/lib/files/workspace-operation-batch-executor';

async function main() {
  const input = JSON.parse(process.argv[2] ?? '{}') as {
    workspaceId: string; user: { id: string; email: string; role?: string; name?: string }; reviewIds: string[];
  };
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(input.user), input.workspaceId);
  if (!workspace?.displayName?.startsWith('E2E batch review crash ') || workspace.ownerUserId !== input.user.id) {
    throw new Error('Dedicated disposable crash workspace required.');
  }
  const scope = { workspace, fileOptions: { workspace } };
  const preview = await createWorkspaceOperationBatchReview({ scope, reviewIds: input.reviewIds });
  if (preview.preview.readiness !== 'ready') throw new Error('Crash fixture requires a ready plan.');
  const queued = await enqueueWorkspaceOperationBatch({ scope, batchId: preview.batchId, planId: preview.planId,
    userId: input.user.id, displayName: input.user.name ?? 'E2E crash reviewer' });
  const stored = await new WorkspaceOperationBatchStore().get(queued.batchId);
  if (!stored) throw new Error('Queued crash fixture was not persisted.');
  process.stdout.write(`CRASH_BATCH:${JSON.stringify(queued)}\n`);
  await executeWorkspaceOperationBatch({ batchId: queued.batchId, plan: stored.plan, scope,
    actorUserId: input.user.id, actorDisplayName: input.user.name ?? 'E2E crash reviewer',
    onProgress: (progress) => {
      if (progress.phase === 'paths' && progress.completedActions >= 1) process.kill(process.pid, 'SIGKILL');
    } });
  throw new Error('Crash fixture did not stop at the intended durable boundary.');
}

main().catch(() => {
  console.error('Could not execute the isolated process crash fixture.');
  process.exitCode = 1;
});
