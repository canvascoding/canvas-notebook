import 'server-only';

import { openDb } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { withWorkspaceAgentToolPrincipal, withWorkspaceAgentToolPrincipalOnConnection,
  type WorkspaceAgentToolPrincipal } from '../workspaces/request-principal';
import { getAgentExecutionContext } from './agent-execution-context';

function scopeIdentity(workspace: WorkspaceContext): string {
  return JSON.stringify([workspace.workspaceId, workspace.workspaceType, workspace.rootPath, workspace.rootRelativePath ?? null,
    workspace.organizationId ?? null, workspace.customerId ?? null, workspace.projectId ?? null, workspace.legacy]);
}

/** Genuine invocation policy on a short owned transaction, never an actor DTO. */
async function currentWorkspace(principal: WorkspaceAgentToolPrincipal): Promise<WorkspaceContext> {
  const connection = await openDb();
  let transaction = false, discard: Error | undefined;
  try {
    await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); transaction = true;
    const workspace = await withWorkspaceAgentToolPrincipalOnConnection(connection, principal,
      async access => structuredClone(access.workspace));
    await connection.run('COMMIT'); transaction = false;
    return workspace;
  } finally {
    if (transaction) try { await connection.run('ROLLBACK'); }
    catch { discard = new Error('Discarding unresolved agent read authorization transaction.'); }
    await connection.close(discard);
  }
}

/** The actual wrapped invocation surrounds one awaited read with fresh policy.
 * Consumers own their native read fence and cannot mutate the retained C1 facts. */
export async function withCurrentAgentWorkspaceRead<T>(operation: (workspace: WorkspaceContext) => Promise<T>): Promise<T> {
  const context = getAgentExecutionContext();
  if (!context || context.legacy) throw new Error('Native workspace reads require a current agent workspace.');
  return withWorkspaceAgentToolPrincipal({ workspaceId: context.workspaceId, permission: 'canRead' }, async principal => {
    const before = await currentWorkspace(principal);
    const result = await operation(structuredClone(before));
    const after = await currentWorkspace(principal);
    if (scopeIdentity(before) !== scopeIdentity(after)) throw new Error('The workspace identity changed while reading.');
    return result;
  });
}
