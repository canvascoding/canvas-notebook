import 'server-only';

import { inArray } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { aiMessages, aiSessions } from '@/app/lib/db/schema';

const DEFAULT_SESSION_RETENTION_LIMIT = 200;

export async function enforceAiSessionRetention(limit = DEFAULT_SESSION_RETENTION_LIMIT): Promise<{
  removedSessions: number;
  removedMessages: number;
}> {
  const normalizedLimit = Math.max(1, Math.floor(limit));

  const allOrdered = await db
    .select({ id: aiSessions.id })
    .from(aiSessions)
    .orderBy(aiSessions.createdAt, aiSessions.id);

  if (allOrdered.length <= normalizedLimit) {
    return { removedSessions: 0, removedMessages: 0 };
  }

  const overflowIds = allOrdered.slice(0, allOrdered.length - normalizedLimit).map((entry) => entry.id);

  const deletedMessages = await db
    .delete(aiMessages)
    .where(inArray(aiMessages.aiSessionDbId, overflowIds))
    .returning({ id: aiMessages.id });
  const deletedSessions = await db
    .delete(aiSessions)
    .where(inArray(aiSessions.id, overflowIds))
    .returning({ id: aiSessions.id });

  return {
    removedSessions: deletedSessions.length,
    removedMessages: deletedMessages.length,
  };
}
