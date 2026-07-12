import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export class PiSessionRuntimeAccessError extends Error {
  constructor(
    message: string,
    readonly code: 'SESSION_NOT_FOUND' | 'SESSION_AMBIGUOUS',
  ) {
    super(message);
    this.name = 'PiSessionRuntimeAccessError';
  }
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
  const sessions = await db.query.piSessions.findMany({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
    ),
    columns: { id: true, agentId: true },
    limit: 3,
  });
  const matchingSessions = sessions.filter((session) => session.agentId === input.agentId);

  if (matchingSessions.length === 0) {
    throw new PiSessionRuntimeAccessError(
      'Agent session not found for this user and agent.',
      'SESSION_NOT_FOUND',
    );
  }
  if (sessions.length !== 1 || matchingSessions.length !== 1) {
    throw new PiSessionRuntimeAccessError(
      'Agent session ID is ambiguous across multiple agents.',
      'SESSION_AMBIGUOUS',
    );
  }

  return matchingSessions[0];
}

export function isPiSessionInWorkspace(
  session: Awaited<ReturnType<typeof findOwnedPiSessionForRuntime>>,
  workspace: Pick<WorkspaceContext, 'workspaceId' | 'workspaceType'>,
): boolean {
  if (!session) return false;
  if (session.workspaceId) return session.workspaceId === workspace.workspaceId;
  return workspace.workspaceType === 'personal';
}
