import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

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

export function isPiSessionInWorkspace(
  session: Awaited<ReturnType<typeof findOwnedPiSessionForRuntime>>,
  workspace: WorkspaceContext,
): boolean {
  if (!session) return false;
  if (session.workspaceId) return session.workspaceId === workspace.workspaceId;
  return workspace.workspaceType === 'personal';
}
