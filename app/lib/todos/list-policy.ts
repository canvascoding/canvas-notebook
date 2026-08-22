import 'server-only';

import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { loadWorkspaceListingForActor } from '@/app/lib/workspaces/listing-action';

type TodoListActor = {
  id: string;
  email?: string | null;
  role?: string | null;
};

/**
 * Resolves the global To-do scope from the authenticated actor, never from
 * caller-supplied workspace identifiers. User-scoped personal To-dos are
 * added separately by the store. The legacy personal workspace is retained so
 * its user-owned workspace-scoped records remain visible in the global view.
 */
export async function listReadableTodoWorkspaceIds(actorInput: TodoListActor): Promise<string[]> {
  const actor = resolveWorkspaceActor(actorInput);
  const listing = await loadWorkspaceListingForActor(actor);
  return Array.from(new Set([
    LEGACY_PERSONAL_WORKSPACE_ID,
    ...listing.workspaces
    .filter((workspace) => workspace.permissions.canRead && (workspace.status ?? 'active') === 'active')
    .map((workspace) => workspace.workspaceId),
  ]));
}
