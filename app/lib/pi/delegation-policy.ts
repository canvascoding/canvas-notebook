import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
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
    throw new DelegationPolicyError('DELEGATION_NOT_ALLOWED', 'Only the main Canvas Agent can delegate tasks.');
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
