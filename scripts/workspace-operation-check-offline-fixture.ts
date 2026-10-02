/** Persist a read-only check while the test-owned HTTP/worker process is stopped. */
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import { enqueueWorkspaceOperationCheck } from '../app/lib/files/workspace-operation-check-service';

async function main() {
  const input = JSON.parse(process.argv[2] ?? '{}') as {
    workspaceId: string; user: { id: string; email: string; role?: string; name?: string }; reviewIds: string[];
  };
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(input.user), input.workspaceId);
  if (!workspace?.displayName?.startsWith('E2E batch review check-restart ') || workspace.ownerUserId !== input.user.id) {
    throw new Error('Dedicated disposable check-restart workspace required.');
  }
  const check = await enqueueWorkspaceOperationCheck({ scope: { workspace, fileOptions: { workspace } },
    reviewIds: input.reviewIds, requesterUserId: input.user.id });
  process.stdout.write(`OFFLINE_CHECK:${JSON.stringify(check)}\n`);
}

main().then(() => process.exit(0)).catch(() => {
  console.error('Could not enqueue isolated offline E2E check.');
  process.exit(1);
});
