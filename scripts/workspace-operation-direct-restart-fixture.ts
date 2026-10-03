/** Submit and interrupt real direct jobs only in the owner's disposable OFF-mode workspace. */
import { readDocumentReviewAvailability } from '../app/lib/document-review-availability';
import { executeWorkspaceOperationBatch } from '../app/lib/files/workspace-operation-batch-executor';
import { submitDirectWorkspacePathOperation } from '../app/lib/files/workspace-path-operation-service';
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? '{}') as {
    workspaceId: string;
    user: { id: string; email: string; role?: string; name?: string };
    mode: 'queued' | 'crash';
  };
  if (!input.workspaceId || !input.user?.id || !input.user.email
    || !['queued', 'crash'].includes(input.mode)) throw new Error('Valid direct restart fixture input required.');
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(input.user), input.workspaceId);
  if (!workspace?.displayName?.startsWith('E2E batch review ') || workspace.ownerUserId !== input.user.id
    || workspace.status !== 'active' || !workspace.permissions.canRead
    || !workspace.permissions.canWrite || !workspace.permissions.canDelete) {
    throw new Error('An authorized disposable direct restart workspace is required.');
  }
  const scope = { workspace, fileOptions: { workspace, mutationActorUserId: input.user.id } };
  const actorDisplayName = input.user.name?.trim() || input.user.email;
  const suffix = input.mode === 'crash' ? 'txt' : 'md';
  if (readDocumentReviewAvailability().documentReviewEnabled) throw new Error('Review Center must be OFF.');
  const batch = await submitDirectWorkspacePathOperation({ scope, kind: 'move',
    selections: ['A', 'B'].map((name) => ({ sourcePath: `${name}.${suffix}`, destinationPath: `moved/${name}.${suffix}` })),
    actorUserId: input.user.id, actorId: input.user.id, actorDisplayName, actorType: 'user',
    idempotencyKey: `direct-restart-${input.mode}` });
  if (batch.authorization.mode !== 'direct' || batch.authorization.actorType !== 'user'
    || batch.authorization.actorUserId !== input.user.id || batch.authorization.actorId !== input.user.id
    || batch.reviewIds.length || batch.reviewRefs.length || batch.reviewerUserId !== null) {
    throw new Error('The fixture requires the original direct user authorization.');
  }
  if (input.mode === 'crash' && (batch.status !== 'queued' || batch.plan.readiness !== 'ready'
    || batch.plan.pathSteps.length !== 2)) throw new Error('Crash fixture requires the original ready queued plan.');
  await new Promise<void>((resolve) => process.stdout.write(`DIRECT_BATCH:${JSON.stringify({
    batchId: batch.batchId, planId: batch.planId, status: batch.status,
    completedActions: batch.completedActions, totalActions: batch.totalActions,
  })}\n`, () => resolve()));
  if (input.mode === 'queued') return;
  await executeWorkspaceOperationBatch({ batchId: batch.batchId, plan: batch.plan, scope,
    actorUserId: batch.authorization.actorUserId, actorId: batch.authorization.actorId,
    actorDisplayName: batch.authorization.actorDisplayName, actorType: batch.authorization.actorType,
    onProgress: (progress) => {
      // The first applied path receipt is already saved before the next path's progress callback.
      if (progress.phase === 'paths' && progress.completedActions === 1) process.kill(process.pid, 'SIGKILL');
    } });
  throw new Error('The crash fixture did not reach the intended durable boundary.');
}

main().then(() => process.exit(0)).catch(() => {
  console.error('Could not run the isolated direct restart fixture.');
  process.exitCode = 1;
});
