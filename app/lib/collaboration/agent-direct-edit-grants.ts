import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { resolveAgentExecutionContextForStoredSession } from '@/app/lib/pi/session-workspace-context';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { logCollaborationDiagnostic, type CollaborationDiagnostic } from './diagnostics';
import { isAgentDatabaseCapacityError, withAgentDatabaseCapacity } from './agent-database-capacity';

export const AGENT_DIRECT_EDIT_GRANT_TTL_MS = 30 * 60 * 1_000;

export type AgentDirectEditGrantScope = {
  userId: string;
  workspaceId: string;
  agentId: string;
  actorSessionId: string;
  documentId: string;
  lifecycleGeneration: number;
};

export type AgentDirectEditGrant = { id: string; expiresAt: number };
export type AgentDirectEditGrantState = AgentDirectEditGrant & {
  active: boolean;
  revokedAt: number | null;
};

export class AgentDirectEditGrantUnavailableError extends Error {
  readonly code = 'direct_edit_grant_unavailable';

  constructor() {
    super('Direct editing is not authorized for this session and document. Submit a proposal for review.');
  }
}

type GrantRow = {
  grant_id: string;
  user_id: string;
  workspace_id: string;
  agent_id: string;
  actor_session_id: string;
  pi_session_db_id: number | string;
  document_id: string;
  lifecycle_generation: number | string;
  expires_at: number | string;
  revoked_at: number | string | null;
};

type OperationGrantInput = {
  operationId: string;
  userId: string;
  workspace: WorkspaceContext;
};

function diagnose(data: CollaborationDiagnostic): void {
  try { logCollaborationDiagnostic(data.event === 'agent_direct_edit_grant_denied' ? 'warn' : 'info', data); } catch {
    // Observability must not turn an already committed permission change into a failed action.
  }
}

async function withGrantDatabaseCapacity<T>(operation: () => Promise<T>): Promise<T> {
  try { return await withAgentDatabaseCapacity(operation); } catch (error) {
    if (isAgentDatabaseCapacityError(error)) {
      diagnose({ event: 'agent_database_busy', code: error.code });
    }
    throw error;
  }
}

const SCOPE_PREDICATE = `user_id = $1 AND workspace_id = $2 AND agent_id = $3
  AND actor_session_id = $4 AND document_id = $5 AND lifecycle_generation = $6`;

function scopeValues(scope: AgentDirectEditGrantScope): unknown[] {
  return [scope.userId, scope.workspaceId, scope.agentId, scope.actorSessionId,
    scope.documentId, scope.lifecycleGeneration];
}

function validScope(scope: AgentDirectEditGrantScope): boolean {
  return [scope.userId, scope.workspaceId, scope.agentId, scope.actorSessionId, scope.documentId]
    .every((value) => typeof value === 'string' && value.trim().length > 0)
    && Number.isSafeInteger(scope.lifecycleGeneration) && scope.lifecycleGeneration > 0;
}

function matchesScope(row: GrantRow, scope: AgentDirectEditGrantScope): boolean {
  return row.user_id === scope.userId && row.workspace_id === scope.workspaceId
    && row.agent_id === scope.agentId && row.actor_session_id === scope.actorSessionId
    && row.document_id === scope.documentId
    && Number(row.lifecycle_generation) === scope.lifecycleGeneration;
}

function state(row: GrantRow, eligible: boolean): AgentDirectEditGrantState {
  return { id: row.grant_id, expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    active: eligible && row.revoked_at === null && Number(row.expires_at) > Date.now() };
}

/** Checks the real stored session, its current permissions, and the current document generation. */
async function currentSessionId(db: SqlConnection, scope: AgentDirectEditGrantScope): Promise<string | null> {
  if (!validScope(scope)) return null;
  const session = await db.get(`SELECT id FROM pi_sessions
    WHERE user_id = $1 AND session_id = $2 AND agent_id = $3 AND archived_at IS NULL`,
  [scope.userId, scope.actorSessionId, scope.agentId]) as { id: number | string } | undefined;
  if (!session) return null;
  const document = await db.get(`SELECT document_id FROM collaboration_yjs_states
    WHERE document_id = $1 AND workspace_id = $2 AND lifecycle_generation = $3 AND status = 'active'`,
  [scope.documentId, scope.workspaceId, scope.lifecycleGeneration]);
  if (!document) return null;
  try {
    const context = await resolveAgentExecutionContextForStoredSession({
      sessionId: scope.actorSessionId, userId: scope.userId, agentId: scope.agentId,
      permissions: ['canRead', 'canRunAgent', 'canWrite'],
    });
    if (context.userId !== scope.userId || context.sessionId !== scope.actorSessionId
      || context.agentId !== scope.agentId || context.workspaceId !== scope.workspaceId || !context.canWrite) return null;
    return String(session.id);
  } catch {
    return null;
  }
}

async function ownedOperationScope(db: SqlConnection, input: OperationGrantInput): Promise<AgentDirectEditGrantScope> {
  const row = await db.get(`SELECT document_id, workspace_id, initiated_by_user_id,
    actor_id, actor_session_id, document_lifecycle_generation, operation_type
    FROM collaboration_agent_operations WHERE operation_id = $1`, [input.operationId]) as {
      document_id: string; workspace_id: string; initiated_by_user_id: string; actor_id: string;
      actor_session_id: string | null; document_lifecycle_generation: number | string; operation_type: string;
    } | undefined;
  if (!row || row.initiated_by_user_id !== input.userId || row.workspace_id !== input.workspace.workspaceId
    || row.operation_type !== 'apply' || !row.actor_session_id) throw new AgentDirectEditGrantUnavailableError();
  const scope = { userId: input.userId, workspaceId: row.workspace_id, agentId: row.actor_id,
    actorSessionId: row.actor_session_id, documentId: row.document_id,
    lifecycleGeneration: Number(row.document_lifecycle_generation) };
  if (!validScope(scope)) throw new AgentDirectEditGrantUnavailableError();
  return scope;
}

async function transaction<T>(action: (db: SqlConnection) => Promise<T>): Promise<T> {
  return withGrantDatabaseCapacity(async () => {
    const db = await openDb();
    let discard: Error | undefined;
    try {
      await db.run('BEGIN');
      const result = await action(db);
      await db.run('COMMIT');
      return result;
    } catch (error) {
      try { await db.run('ROLLBACK'); } catch (rollbackError) {
        discard = rollbackError instanceof Error ? rollbackError : new Error('Grant rollback failed.');
      }
      throw error;
    } finally {
      await db.close(discard);
    }
  });
}

/** Read before queueing, then bind the returned id to that operation. This alone never authorizes apply. */
export async function resolveAgentDirectEditGrant(scope: AgentDirectEditGrantScope): Promise<AgentDirectEditGrant | null> {
  if (!validScope(scope)) return null;
  return withGrantDatabaseCapacity(async () => {
    const db = await openDb();
    try {
      const row = await db.get(`SELECT * FROM collaboration_agent_direct_edit_grants
        WHERE ${SCOPE_PREDICATE} AND revoked_at IS NULL`, scopeValues(scope)) as GrantRow | undefined;
      if (!row || Number(row.expires_at) <= Date.now()) return null;
      const sessionId = await currentSessionId(db, scope);
      return sessionId !== null && sessionId === String(row.pi_session_db_id) && state(row, true).active
        ? { id: row.grant_id, expiresAt: Number(row.expires_at) } : null;
    } finally {
      await db.close();
    }
  });
}

/**
 * Holds only this grant's SQL row lock through the mutation callback. A concurrent revoke
 * waits for this apply to finish. Callers must also check expiresAt synchronously at the
 * live-document mutation boundary, after any room/operation queue wait.
 */
export async function withAgentDirectEditGrant<T>(
  input: { grantId: string; scope: AgentDirectEditGrantScope },
  apply: (grant: AgentDirectEditGrant) => Promise<T>,
): Promise<T> {
  if (!validScope(input.scope) || !input.grantId) throw new AgentDirectEditGrantUnavailableError();
  try {
    return await transaction(async (db) => {
      const row = await db.get(`SELECT * FROM collaboration_agent_direct_edit_grants
        WHERE grant_id = $1 FOR UPDATE`, [input.grantId]) as GrantRow | undefined;
      if (!row || !matchesScope(row, input.scope) || !state(row, true).active) {
        throw new AgentDirectEditGrantUnavailableError();
      }
      const sessionId = await currentSessionId(db, input.scope);
      if (sessionId === null || sessionId !== String(row.pi_session_db_id) || !state(row, true).active) {
        throw new AgentDirectEditGrantUnavailableError();
      }
      return apply({ id: row.grant_id, expiresAt: Number(row.expires_at) });
    });
  } catch (error) {
    if (error instanceof AgentDirectEditGrantUnavailableError) diagnose({ event: 'agent_direct_edit_grant_denied',
      documentId: input.scope.documentId, workspaceId: input.scope.workspaceId,
      generation: input.scope.lifecycleGeneration, code: error.code });
    throw error;
  }
}

/** Ownership is intentionally stricter than the permission to review somebody else's proposal. */
export async function getAgentDirectEditGrantForOperation(input: OperationGrantInput): Promise<{
  grant: AgentDirectEditGrantState | null; canGrant: boolean;
}> {
  return withGrantDatabaseCapacity(async () => {
    const db = await openDb();
    try {
      const scope = await ownedOperationScope(db, input);
      const sessionId = await currentSessionId(db, scope);
      const row = await db.get(`SELECT * FROM collaboration_agent_direct_edit_grants
        WHERE ${SCOPE_PREDICATE} ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END, created_at DESC, grant_id DESC LIMIT 1`, scopeValues(scope)) as GrantRow | undefined;
      const canGrant = sessionId !== null && input.workspace.permissions.canWrite && input.workspace.permissions.canRunAgent;
      return { canGrant, grant: row ? state(row, canGrant && sessionId === String(row.pi_session_db_id)) : null };
    } finally {
      await db.close();
    }
  });
}

/** An explicit user action changes a server-derived scope; it never approves the source proposal. */
export async function setAgentDirectEditGrantForOperation(input: OperationGrantInput & {
  action: 'grant' | 'revoke'; idempotencyKey: string;
}): Promise<AgentDirectEditGrantState | null> {
  if (!['grant', 'revoke'].includes(input.action) || typeof input.idempotencyKey !== 'string'
    || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 200) {
    throw new Error('A grant or revoke action and an idempotency key of at most 200 characters are required.');
  }
  let diagnostic: CollaborationDiagnostic | undefined;
  try {
    const result = await transaction(async (db) => {
      const scope = await ownedOperationScope(db, input);
      // Coordinate competing create/revoke requests, including the first grant, without locking document rows.
      const lockId = createHash('sha256').update(JSON.stringify(scopeValues(scope))).digest().readBigInt64BE().toString();
      await db.get('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);
      const receipt = await db.get(`SELECT action, grant_id FROM collaboration_agent_direct_edit_grant_actions
        WHERE user_id = $1 AND operation_id = $2 AND idempotency_key = $3`,
      [input.userId, input.operationId, input.idempotencyKey]) as { action: string; grant_id: string | null } | undefined;
      if (receipt && receipt.action !== input.action) throw new Error('This idempotency key was already used for another action.');
      if (receipt) {
        const row = receipt.grant_id ? await db.get(`SELECT * FROM collaboration_agent_direct_edit_grants
          WHERE grant_id = $1`, [receipt.grant_id]) as GrantRow | undefined : undefined;
        const sessionId = row ? await currentSessionId(db, scope) : null;
        return row ? state(row, sessionId !== null && sessionId === String(row.pi_session_db_id)) : null;
      }
      const existing = await db.get(`SELECT * FROM collaboration_agent_direct_edit_grants
        WHERE ${SCOPE_PREDICATE} AND revoked_at IS NULL FOR UPDATE`, scopeValues(scope)) as GrantRow | undefined;
      let result: GrantRow | undefined = existing;
      if (input.action === 'grant') {
        const sessionId = await currentSessionId(db, scope);
        if (sessionId === null || !input.workspace.permissions.canWrite || !input.workspace.permissions.canRunAgent) {
          throw new AgentDirectEditGrantUnavailableError();
        }
        // Repeated clicks while active do not silently extend the explicitly bounded grant.
        if (!existing || !state(existing, true).active || String(existing.pi_session_db_id) !== sessionId) {
          const now = Date.now();
          if (existing) await db.run(`UPDATE collaboration_agent_direct_edit_grants SET revoked_at = $1
            WHERE grant_id = $2`, [now, existing.grant_id]);
          const id = randomUUID();
          await db.run(`INSERT INTO collaboration_agent_direct_edit_grants
            (grant_id, user_id, workspace_id, agent_id, actor_session_id, document_id,
              lifecycle_generation, pi_session_db_id, created_at, expires_at, revoked_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
          [id, ...scopeValues(scope), sessionId, now, now + AGENT_DIRECT_EDIT_GRANT_TTL_MS]);
          result = await db.get('SELECT * FROM collaboration_agent_direct_edit_grants WHERE grant_id = $1', [id]) as GrantRow;
          diagnostic = { event: 'agent_direct_edit_grant_created', operationId: input.operationId,
            documentId: scope.documentId, workspaceId: scope.workspaceId, generation: scope.lifecycleGeneration };
        }
      } else if (existing) {
        await db.run('UPDATE collaboration_agent_direct_edit_grants SET revoked_at = $1 WHERE grant_id = $2',
          [Date.now(), existing.grant_id]);
        result = await db.get('SELECT * FROM collaboration_agent_direct_edit_grants WHERE grant_id = $1', [existing.grant_id]) as GrantRow;
        diagnostic = { event: 'agent_direct_edit_grant_revoked', operationId: input.operationId,
          documentId: scope.documentId, workspaceId: scope.workspaceId, generation: scope.lifecycleGeneration };
      }
      await db.run(`INSERT INTO collaboration_agent_direct_edit_grant_actions
        (user_id, operation_id, idempotency_key, action, grant_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.userId, input.operationId, input.idempotencyKey, input.action, result?.grant_id ?? null, Date.now()]);
      return result ? state(result, input.action === 'grant') : null;
    });
    if (diagnostic) diagnose(diagnostic);
    return result;
  } catch (error) {
    if (error instanceof AgentDirectEditGrantUnavailableError) diagnose({ event: 'agent_direct_edit_grant_denied',
      operationId: input.operationId, workspaceId: input.workspace.workspaceId, code: error.code });
    throw error;
  }
}
