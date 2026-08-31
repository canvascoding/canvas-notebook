import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piDelegations, piSessions } from '@/app/lib/db/schema';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';

export class DelegationPolicyError extends Error {
  constructor(
    readonly code: 'SOURCE_SESSION_NOT_FOUND' | 'SOURCE_SESSION_AMBIGUOUS' | 'DELEGATION_NOT_ALLOWED',
    message: string,
  ) {
    super(message);
    this.name = 'DelegationPolicyError';
  }
}

/**
 * Resolves the authoritative source session for every delegation entry point.
 * The caller-supplied agent ID is verified against persistence rather than
 * treated as an authorization boundary.
 */
export async function requireDelegationSource(input: {
  userId: string;
  sourceSessionId: string;
  sourceAgentId?: string | null;
}): Promise<{
  sourceAgentId: string;
  workspaceId: string | null;
  organizationId: string | null;
  projectId: string | null;
}> {
  const sourceSessionId = input.sourceSessionId.trim();
  if (!sourceSessionId) {
    throw new DelegationPolicyError('SOURCE_SESSION_NOT_FOUND', 'Source session ID is required for delegation.');
  }

  const sessions = await db.query.piSessions.findMany({
    where: and(
      eq(piSessions.userId, input.userId),
      eq(piSessions.sessionId, sourceSessionId),
    ),
    columns: {
      agentId: true,
      sessionKind: true,
      delegationDepth: true,
      workspaceId: true,
      organizationId: true,
      projectId: true,
    },
    limit: 2,
  });
  if (sessions.length === 0) {
    throw new DelegationPolicyError('SOURCE_SESSION_NOT_FOUND', 'Delegating source session was not found for this user.');
  }
  if (sessions.length !== 1) {
    throw new DelegationPolicyError('SOURCE_SESSION_AMBIGUOUS', 'Delegating source session ID is ambiguous.');
  }

  const source = sessions[0];
  if (input.sourceAgentId?.trim() && source.agentId !== input.sourceAgentId.trim()) {
    throw new DelegationPolicyError('DELEGATION_NOT_ALLOWED', 'Delegating source agent does not match the stored session.');
  }
  if (source.agentId !== DEFAULT_AGENT_ID) {
    throw new DelegationPolicyError('DELEGATION_NOT_ALLOWED', 'Only Bradley, the main agent, can delegate tasks.');
  }
  if (source.sessionKind !== 'conversation' || source.delegationDepth !== 0) {
    throw new DelegationPolicyError('DELEGATION_NOT_ALLOWED', 'Sub-agents cannot start another sub-agent.');
  }

  return {
    sourceAgentId: source.agentId,
    workspaceId: source.workspaceId,
    organizationId: source.organizationId,
    projectId: source.projectId,
  };
}

export async function getDelegatedWorkerToolsets(input: {
  userId: string;
  sessionId: string;
}): Promise<string[] | null> {
  const worker = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.userId, input.userId),
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.sessionKind, 'delegation_worker'),
    ),
    columns: { delegationId: true },
  });
  const delegation = await db.query.piDelegations.findFirst({
    where: worker?.delegationId
      ? and(eq(piDelegations.id, worker.delegationId), eq(piDelegations.userId, input.userId))
      : and(
        eq(piDelegations.userId, input.userId),
        eq(piDelegations.workerSessionId, input.sessionId),
        eq(piDelegations.workerType, 'managed'),
        inArray(piDelegations.status, ['queued', 'running']),
      ),
    orderBy: (delegations, { desc }) => [desc(delegations.updatedAt), desc(delegations.id)],
    columns: { toolsetsJson: true },
  });
  if (!delegation) return worker?.delegationId ? [] : null;
  try {
    const value = JSON.parse(delegation.toolsetsJson) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
