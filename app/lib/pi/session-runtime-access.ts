import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export class PiSessionRuntimeAccessError extends Error {
  constructor(
    message: string,
    readonly code: 'SESSION_NOT_FOUND' | 'SESSION_AMBIGUOUS' | 'SESSION_AGENT_MISMATCH',
  ) {
    super(message);
    this.name = 'PiSessionRuntimeAccessError';
  }
}

export async function findUnambiguousOwnedPiSessionForRuntime(input: {
  sessionId: string;
  userId: string;
}) {
  const sessions = await db.query.piSessions.findMany({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
    ),
    limit: 2,
  });

  if (sessions.length > 1) {
    throw new PiSessionRuntimeAccessError(
      'Agent session ID is ambiguous across multiple agents.',
      'SESSION_AMBIGUOUS',
    );
  }

  return sessions[0] ?? null;
}

export async function findOwnedPiSessionForRuntime(input: {
  sessionId: string;
  userId: string;
  agentId: string;
}) {
  return db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      eq(piSessions.agentId, input.agentId),
    ),
  });
}

export async function assertUnambiguousOwnedPiSessionForRuntime(input: {
  sessionId: string;
  userId: string;
  agentId: string;
}) {
  const session = await findUnambiguousOwnedPiSessionForRuntime(input);
  if (!session || session.agentId !== input.agentId) {
    throw new PiSessionRuntimeAccessError(
      'Agent session not found for this user and agent.',
      'SESSION_NOT_FOUND',
    );
  }

  return session;
}

export function isPiSessionInWorkspace(
  session: Awaited<ReturnType<typeof findOwnedPiSessionForRuntime>>,
  workspace: Pick<WorkspaceContext, 'workspaceId' | 'workspaceType'>,
): boolean {
  if (!session) return false;
  if (session.workspaceId) return session.workspaceId === workspace.workspaceId;
  return workspace.workspaceType === 'personal';
}
