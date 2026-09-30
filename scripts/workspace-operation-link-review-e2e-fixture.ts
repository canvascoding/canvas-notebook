import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import { submitAgentWorkspacePathOperation } from '../app/lib/files/workspace-operation-review-service';

/** Submit through the production service, restricted to the browser test's workspace. */
async function main() {
  const input = JSON.parse(process.argv[2] ?? '{}') as {
    workspaceId: string;
    user: { id: string; email: string; role?: string };
    sourcePath: string;
    destinationPath: string;
  };
  const actor = resolveWorkspaceActor(input.user);
  const workspace = await resolvePostgresWorkspaceForActor(actor, input.workspaceId);
  if (!workspace || !workspace.displayName?.startsWith('E2E link review ')
    || workspace.ownerUserId !== input.user.id) throw new Error('Dedicated E2E workspace required.');
  const result = await submitAgentWorkspacePathOperation({
    kind: 'move', source: { workspace, fileOptions: { workspace } },
    selections: [{ sourcePath: input.sourcePath, destinationPath: input.destinationPath }],
    actorUserId: input.user.id, actorId: 'e2e-link-review', actorDisplayName: 'E2E link review',
  });
  console.log(`REVIEW_FIXTURE:${JSON.stringify(result)}`);
}

main().then(() => process.exit(0)).catch(() => {
  console.error('Could not submit the isolated E2E file review.');
  process.exit(1);
});
