import 'server-only';

import { openDb } from '@/app/lib/db';
import type { DirectMcpAccessPrincipal } from '@/app/lib/mcp/server/access-token-verifier';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  loadWorkspaceListingForActor,
  type WorkspaceListing,
} from '@/app/lib/workspaces/listing-action';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const MAX_WORKSPACE_ID_LENGTH = 200;
const MAX_ALLOWED_WORKSPACES = 200;

export type DirectMcpWorkspaceOption = {
  workspaceId: string;
  name: string;
  description: string | null;
  type: string;
};

export type ReplaceDirectMcpWorkspaceAccessResult =
  | { status: 'saved'; allowedWorkspaceCount: number }
  | { status: 'invalid_workspace' };

export function isDirectMcpReadableWorkspace(workspace: WorkspaceContext): boolean {
  return workspace.permissions.canRead
    && workspace.status !== 'archived'
    && workspace.status !== 'disabled'
    && workspace.status !== 'recovery_locked';
}

export async function loadDirectMcpWorkspaceListingForUser(
  userId: string,
): Promise<WorkspaceListing> {
  const database = await openDb();
  try {
    const identity = await database.get(
      'SELECT email, role FROM "user" WHERE id = ? LIMIT 1',
      [userId],
    ) as { email?: unknown; role?: unknown } | undefined;
    if (!identity || typeof identity.email !== 'string') {
      throw new Error('The signed-in Canvas user is no longer available.');
    }
    return await loadWorkspaceListingForActor(resolveWorkspaceActor({
      id: userId,
      email: identity.email,
      role: typeof identity.role === 'string' ? identity.role : null,
    }));
  } finally {
    await database.close();
  }
}

export async function listDirectMcpAllowedWorkspaceIds(
  principal: Pick<DirectMcpAccessPrincipal, 'clientId' | 'userId'>,
): Promise<Set<string>> {
  const database = await openDb();
  try {
    const rows = await database.all(`
      SELECT workspace_id
      FROM mcp_direct_workspace_grant
      WHERE client_id = ? AND user_id = ?
    `, [principal.clientId, principal.userId]) as Array<{ workspace_id: unknown }>;
    return new Set(rows
      .map((row) => typeof row.workspace_id === 'string' ? row.workspace_id : null)
      .filter((workspaceId): workspaceId is string => Boolean(workspaceId)));
  } finally {
    await database.close();
  }
}

export async function listDirectMcpSelectableWorkspaces(
  userId: string,
): Promise<DirectMcpWorkspaceOption[]> {
  const listing = await loadDirectMcpWorkspaceListingForUser(userId);
  return listing.workspaces
    .filter(isDirectMcpReadableWorkspace)
    .map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.displayName || 'Workspace',
      description: workspace.description || null,
      type: workspace.workspaceType,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeWorkspaceIds(workspaceIds: readonly unknown[]): string[] | null {
  if (workspaceIds.length > MAX_ALLOWED_WORKSPACES) return null;
  const result = new Set<string>();
  for (const workspaceId of workspaceIds) {
    if (typeof workspaceId !== 'string') return null;
    const normalized = workspaceId.trim();
    if (!normalized || normalized.length > MAX_WORKSPACE_ID_LENGTH) return null;
    result.add(normalized);
  }
  return [...result].sort();
}

export async function replaceDirectMcpAllowedWorkspaces(input: {
  clientId: string;
  userId: string;
  workspaceIds: readonly string[];
}): Promise<ReplaceDirectMcpWorkspaceAccessResult> {
  const workspaceIds = normalizeWorkspaceIds(input.workspaceIds);
  if (!workspaceIds) return { status: 'invalid_workspace' };

  const selectable = await listDirectMcpSelectableWorkspaces(input.userId);
  const selectableIds = new Set(selectable.map((workspace) => workspace.workspaceId));
  if (workspaceIds.some((workspaceId) => !selectableIds.has(workspaceId))) {
    return { status: 'invalid_workspace' };
  }

  const database = await openDb();
  const updatedAt = Date.now();
  try {
    await database.run('BEGIN');
    await database.run(`
      DELETE FROM mcp_direct_workspace_grant
      WHERE client_id = ? AND user_id = ?
    `, [input.clientId, input.userId]);
    for (const workspaceId of workspaceIds) {
      await database.run(`
        INSERT INTO mcp_direct_workspace_grant (
          client_id, user_id, workspace_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `, [input.clientId, input.userId, workspaceId, updatedAt, updatedAt]);
    }
    await database.run('COMMIT');
    return { status: 'saved', allowedWorkspaceCount: workspaceIds.length };
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back by the database.
    }
    throw error;
  } finally {
    await database.close();
  }
}
