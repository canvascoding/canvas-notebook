import 'server-only';

import { openDb, type SqlConnection } from '../db';
import { DEFAULT_MANAGED_AGENT_ID } from './storage';
import type { AgentExecutionContext } from '../pi/agent-execution-context';
import { readStoredAgentWorkspaceOnConnection, resolveAgentExecutionContextForStoredSession,
  resolveAgentSessionWorkspaceForUser } from '../pi/session-workspace-context';
import type { WorkspaceContext } from '../workspaces/types';

type Selection = Pick<AgentExecutionContext, 'userId' | 'sessionId' | 'agentId' | 'workspaceId' | 'legacy'>;

async function withPromptAccountRead<T>(userId: string, operation: (database: SqlConnection) => Promise<T>): Promise<T> {
  const connection = await openDb(); let transaction = false, discard: Error | undefined;
  try {
    await connection.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await connection.run("SET LOCAL statement_timeout='5s'"); await connection.run("SET LOCAL lock_timeout='4s'");
    const user = await connection.get('SELECT id,banned FROM "user" WHERE id=$1 LIMIT 1', [userId]) as
      { id: string; banned: unknown } | undefined;
    if (!user || user.id !== userId || ![null, false, 0, '0'].includes(user.banned as never)) {
      throw new Error('The prompt account is unavailable.');
    }
    const result = await operation(connection);
    await connection.run('COMMIT'); transaction = false; return result;
  } finally {
    if (transaction) try { await connection.run('ROLLBACK'); }
    catch { discard = new Error('Discarding unresolved prompt workspace authorization.'); }
    await connection.close(discard);
  }
}

/** Background producers retain their real existing workspace policy. Release
 * the account checkout before that policy opens its own connection. */
export async function readCurrentPromptWorkspaceForUser(userId: string,
  readCurrentWorkspace: () => Promise<WorkspaceContext>): Promise<WorkspaceContext> {
  await withPromptAccountRead(userId, async () => undefined);
  return readCurrentWorkspace();
}

/** Selectors are not authority. Every call checks the actual stored session,
 * current user/workspace and agent policy. No tool invocation is fabricated. */
export async function readAgentWorkspaceForPrompt(selection: Selection): Promise<WorkspaceContext> {
  const input = { userId: selection.userId, sessionId: selection.sessionId,
    agentId: selection.agentId ?? DEFAULT_MANAGED_AGENT_ID, workspaceId: selection.workspaceId,
    permissions: ['canRead', 'canRunAgent'] as const };
  if (selection.legacy) {
    // Retain the existing legacy policy, including its genuine admin check.
    return readCurrentPromptWorkspaceForUser(input.userId, async () => {
      const context = await resolveAgentExecutionContextForStoredSession({ ...input, permissions: [...input.permissions] });
      if (!context.legacy || context.workspaceId !== input.workspaceId) throw new Error('The legacy workspace changed.');
      return resolveAgentSessionWorkspaceForUser({ userId: input.userId, workspaceId: input.workspaceId,
        permissions: [...input.permissions] });
    });
  }
  return withPromptAccountRead(input.userId, database =>
    readStoredAgentWorkspaceOnConnection(database, { ...input, permissions: [...input.permissions] }));
}
