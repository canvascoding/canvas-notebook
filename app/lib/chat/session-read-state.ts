import { and, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { hasUnreadAssistantResponse } from './unread';

export type PiSessionReadStateResult = {
  sessionId: string;
  lastMessageAt: Date | null;
  lastViewedAt: Date | null;
  hasUnread: boolean;
};

type SessionReadStateInput = {
  sessionId: string;
  userId: string;
  agentId: string;
  now?: Date;
};

function buildReadStateResult(input: {
  sessionId: string;
  lastMessageAt: Date | null;
  lastViewedAt: Date | null;
}): PiSessionReadStateResult {
  return {
    ...input,
    hasUnread: hasUnreadAssistantResponse(input.lastMessageAt, input.lastViewedAt),
  };
}

export async function markPiSessionAsReadForUser(input: SessionReadStateInput): Promise<PiSessionReadStateResult | null> {
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      eq(piSessions.agentId, input.agentId),
    ),
    columns: {
      id: true,
      sessionId: true,
      lastMessageAt: true,
    },
  });

  if (!session) {
    return null;
  }

  const now = input.now ?? new Date();
  await db
    .update(piSessions)
    .set({ lastViewedAt: now, updatedAt: now })
    .where(eq(piSessions.id, session.id));

  return buildReadStateResult({
    sessionId: session.sessionId,
    lastMessageAt: session.lastMessageAt,
    lastViewedAt: now,
  });
}

export async function markPiSessionAsUnreadForUser(input: SessionReadStateInput): Promise<PiSessionReadStateResult | null> {
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      eq(piSessions.agentId, input.agentId),
    ),
    columns: {
      id: true,
      sessionId: true,
      lastMessageAt: true,
    },
  });

  if (!session || !session.lastMessageAt) {
    return null;
  }

  const now = input.now ?? new Date();
  await db
    .update(piSessions)
    .set({ lastViewedAt: null, updatedAt: now })
    .where(eq(piSessions.id, session.id));

  return buildReadStateResult({
    sessionId: session.sessionId,
    lastMessageAt: session.lastMessageAt,
    lastViewedAt: null,
  });
}
