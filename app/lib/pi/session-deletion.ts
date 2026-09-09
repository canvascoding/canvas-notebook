import 'server-only';

import { inArray } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { channelActiveSessions, piMessages, piSessions, sessionChannelLinks } from '@/app/lib/db/schema';
import { deleteToolOutputs } from '@/app/lib/pi/tool-output-store';

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
    .select({ id: piSessions.id, sessionId: piSessions.sessionId, userId: piSessions.userId, organizationId: piSessions.organizationId, workspaceId: piSessions.workspaceId })
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

  const deletedIds = new Set(deletedSessions.map((session) => session.id));
  for (const session of sessionRows) {
    if (!deletedIds.has(session.id)) continue;
    await deleteToolOutputs({ ...session, workspaceId: session.workspaceId ?? undefined });
  }

  return {
    sessionCount: deletedSessions.length,
    messageCount: deletedMessages.length,
    channelLinkCount: deletedLinks.length,
    activeSessionCount: deletedActiveSessions.length,
  };
}
