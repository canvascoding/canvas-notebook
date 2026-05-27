import { db } from '@/app/lib/db';
import { piSessions, sessionChannelLinks } from '@/app/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { setActiveChannelSession } from '@/app/lib/channels/active-sessions';
import { createChannelSession, resolveChannelSession } from '@/app/lib/channels/session-resolver';
import { TELEGRAM_CHANNEL_ID, telegramChannelSessionKey } from '@/app/lib/channels/constants';
import { ensureSessionChannelLink } from '@/app/lib/channels/channel-links';

export async function resolveTelegramSession(chatId: string, userId: string): Promise<string> {
  return resolveChannelSession({
    channelId: TELEGRAM_CHANNEL_ID,
    channelSessionKey: telegramChannelSessionKey(chatId),
    userId,
  });
}

export async function createTelegramSession(chatId: string, userId: string): Promise<string> {
  return createChannelSession({
    channelId: TELEGRAM_CHANNEL_ID,
    channelSessionKey: telegramChannelSessionKey(chatId),
    userId,
  });
}

export async function switchTelegramSession(chatId: string, userId: string, sessionId: string): Promise<boolean> {
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, userId),
    ),
  });

  if (!session) return false;

  await ensureSessionChannelLink({
    sessionId,
    userId,
    channelId: TELEGRAM_CHANNEL_ID,
    channelSessionKey: telegramChannelSessionKey(chatId),
    displayName: session.title,
    inboundAt: new Date(),
  });
  await setActiveChannelSession({
    userId,
    channelId: TELEGRAM_CHANNEL_ID,
    channelSessionKey: telegramChannelSessionKey(chatId),
    sessionId,
  });
  return true;
}

export async function listTelegramSessions(userId: string): Promise<Array<{ sessionId: string; title: string | null; createdAt: Date }>> {
  const links = await db.query.sessionChannelLinks.findMany({
    where: and(eq(sessionChannelLinks.userId, userId), eq(sessionChannelLinks.channelId, TELEGRAM_CHANNEL_ID)),
    orderBy: [desc(sessionChannelLinks.lastInboundAt), desc(sessionChannelLinks.updatedAt)],
    columns: { sessionId: true },
  });

  const seen = new Set<string>();
  const sessions: Array<{ sessionId: string; title: string | null; createdAt: Date }> = [];
  for (const link of links) {
    if (seen.has(link.sessionId)) continue;
    seen.add(link.sessionId);
    const session = await db.query.piSessions.findFirst({
      where: and(eq(piSessions.userId, userId), eq(piSessions.sessionId, link.sessionId)),
      columns: { sessionId: true, title: true, createdAt: true },
    });
    if (session) sessions.push(session);
  }

  return sessions;
}
