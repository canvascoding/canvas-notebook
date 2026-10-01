/** Persist a real approved job while the E2E-owned HTTP/worker process is stopped. */
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import { createWorkspaceOperationBatchReview, enqueueWorkspaceOperationBatch } from '../app/lib/files/workspace-operation-batch-service';

async function main() {
  const input = JSON.parse(process.argv[2] ?? '{}') as {
    workspaceId: string; user: { id: string; email: string; role?: string; name?: string }; reviewIds: string[];
  };
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(input.user), input.workspaceId);
  if (!workspace?.displayName?.startsWith('E2E batch review ') || workspace.ownerUserId !== input.user.id) {
    throw new Error('Dedicated disposable E2E workspace required.');
  }
  const scope = { workspace, fileOptions: { workspace } };
  const preview = await createWorkspaceOperationBatchReview({ scope, reviewIds: input.reviewIds });
  if (preview.preview.readiness !== 'ready') throw new Error('Offline fixture requires a ready combined preview.');
  const batch = await enqueueWorkspaceOperationBatch({ scope, batchId: preview.batchId, planId: preview.planId,
    userId: input.user.id, displayName: input.user.name ?? 'E2E restart reviewer' });
  process.stdout.write(`OFFLINE_BATCH:${JSON.stringify(batch)}\n`);
}

main().then(() => process.exit(0)).catch(() => {
  console.error('Could not enqueue isolated offline E2E batch.');
  process.exit(1);
});
