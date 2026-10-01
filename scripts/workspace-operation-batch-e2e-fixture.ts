/** Submit real proposals only inside the authenticated test owner's disposable workspace. */
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import { submitAgentWorkspacePathOperation } from '../app/lib/files/workspace-operation-review-service';
import type { WorkspaceOperationReviewKind } from '../app/lib/files/workspace-operation-review-contract';

async function main() {
  const input = JSON.parse(process.argv[2] ?? '{}') as {
    workspaceId: string;
    user: { id: string; email: string; role?: string };
    actions: Array<{ kind: WorkspaceOperationReviewKind;
      selections: Array<{ sourcePath: string; destinationPath?: string }> }>;
  };
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(input.user), input.workspaceId);
  if (!workspace?.displayName?.startsWith('E2E batch review ') || workspace.ownerUserId !== input.user.id) {
    throw new Error('Dedicated disposable E2E workspace required.');
  }
  const submissions = [];
  for (const action of input.actions) {
    submissions.push(await submitAgentWorkspacePathOperation({
      ...action, source: { workspace, fileOptions: { workspace } },
      actorUserId: input.user.id, actorId: 'e2e-batch-review', actorDisplayName: 'E2E batch review',
    }));
  }
  process.stdout.write(`BATCH_FIXTURE:${JSON.stringify(submissions)}\n`);
}

main().then(() => process.exit(0)).catch(() => {
  console.error('Could not submit isolated E2E batch reviews.');
  process.exit(1);
});
