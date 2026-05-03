import { db } from '@/app/lib/db';
import { piSessions, telegramActiveSession } from '@/app/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { resolveActivePiModel } from '@/app/lib/pi/model-resolver';
import { DEFAULT_PI_SESSION_TITLE } from '@/app/lib/pi/session-titles';

export async function resolveTelegramSession(chatId: string, userId: string): Promise<string> {
  const active = await db.query.telegramActiveSession.findFirst({
    where: eq(telegramActiveSession.chatId, chatId),
  });

  if (active) {
    const session = await db.query.piSessions.findFirst({
      where: and(eq(piSessions.sessionId, active.sessionId), eq(piSessions.userId, userId)),
    });
    if (session) return active.sessionId;
  }

  const latest = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.userId, userId), eq(piSessions.channelId, 'telegram')),
    orderBy: [desc(piSessions.lastMessageAt)],
  });

  if (latest) {
    await setActiveSession(chatId, userId, latest.sessionId);
    return latest.sessionId;
  }

  return createTelegramSession(chatId, userId);
}

async function createTelegramSession(chatId: string, userId: string): Promise<string> {
  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const piConfig = await readPiRuntimeConfig();
  const model = await resolveActivePiModel();

  await db.insert(piSessions).values({
    sessionId,
    userId,
    provider: piConfig.activeProvider,
    model: model.id,
    channelId: 'telegram',
    channelSessionKey: `telegram:${chatId}`,
    title: DEFAULT_PI_SESSION_TITLE,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastMessageAt: null,
    lastViewedAt: null,
  });

  await setActiveSession(chatId, userId, sessionId);
  return sessionId;
}

async function setActiveSession(chatId: string, userId: string, sessionId: string): Promise<void> {
  const existing = await db.query.telegramActiveSession.findFirst({
    where: eq(telegramActiveSession.chatId, chatId),
  });

  if (existing) {
    await db.update(telegramActiveSession)
      .set({ userId, sessionId, updatedAt: new Date() })
      .where(eq(telegramActiveSession.id, existing.id));
  } else {
    await db.insert(telegramActiveSession).values({
      userId,
      chatId,
      sessionId,
      updatedAt: new Date(),
    });
  }
}

export async function switchTelegramSession(chatId: string, userId: string, sessionId: string): Promise<boolean> {
  const session = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId)),
  });

  if (!session) return false;

  await setActiveSession(chatId, userId, sessionId);
  return true;
}

export async function listTelegramSessions(userId: string): Promise<Array<{ sessionId: string; title: string | null; createdAt: Date }>> {
  const sessions = await db.query.piSessions.findMany({
    where: and(eq(piSessions.userId, userId), eq(piSessions.channelId, 'telegram')),
    columns: { sessionId: true, title: true, createdAt: true },
    orderBy: [desc(piSessions.lastMessageAt)],
  });

  return sessions;
}