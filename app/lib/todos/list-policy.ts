import 'server-only';

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
 * added separately by the store; this list contains concrete workspaces only.
 */
export async function listReadableTodoWorkspaceIds(actorInput: TodoListActor): Promise<string[]> {
  const actor = resolveWorkspaceActor(actorInput);
  const listing = await loadWorkspaceListingForActor(actor);
  return Array.from(new Set(listing.workspaces
    .filter((workspace) => workspace.permissions.canRead && (workspace.status ?? 'active') === 'active')
    .filter((workspace) => !workspace.legacy)
    .map((workspace) => workspace.workspaceId)));
}
