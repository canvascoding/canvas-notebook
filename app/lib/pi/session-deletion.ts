import 'server-only';

import { inArray } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { channelActiveSessions, piMessages, piSessions, sessionChannelLinks } from '@/app/lib/db/schema';

export type DeletePiSessionsResult = {
  sessionCount: number;
  messageCount: number;
  channelLinkCount: number;
  activeSessionCount: number;
};

export async function deletePiSessionsByDbIds(sessionDbIds: number[]): Promise<DeletePiSessionsResult> {
  const uniqueDbIds = Array.from(new Set(sessionDbIds));
  if (uniqueDbIds.length === 0) {
    return {
      sessionCount: 0,
      messageCount: 0,
      channelLinkCount: 0,
      activeSessionCount: 0,
    };
  }

  const sessionRows = await db
    .select({ sessionId: piSessions.sessionId })
    .from(piSessions)
    .where(inArray(piSessions.id, uniqueDbIds));
  const sessionIds = Array.from(new Set(sessionRows.map((session) => session.sessionId)));

  const deletedMessages = await db.delete(piMessages)
    .where(inArray(piMessages.piSessionDbId, uniqueDbIds))
    .returning({ id: piMessages.id });

  let deletedLinks: Array<{ id: number }> = [];
  let deletedActiveSessions: Array<{ id: number }> = [];
  if (sessionIds.length > 0) {
    deletedLinks = await db.delete(sessionChannelLinks)
      .where(inArray(sessionChannelLinks.sessionId, sessionIds))
      .returning({ id: sessionChannelLinks.id });
    deletedActiveSessions = await db.delete(channelActiveSessions)
      .where(inArray(channelActiveSessions.sessionId, sessionIds))
      .returning({ id: channelActiveSessions.id });
  }

  const deletedSessions = await db.delete(piSessions)
    .where(inArray(piSessions.id, uniqueDbIds))
    .returning({ id: piSessions.id });

  return {
    sessionCount: deletedSessions.length,
    messageCount: deletedMessages.length,
    channelLinkCount: deletedLinks.length,
    activeSessionCount: deletedActiveSessions.length,
  };
}
