import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions, sessionChannelLinks } from '@/app/lib/db/schema';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { resolveActivePiModel } from '@/app/lib/pi/model-resolver';
import { DEFAULT_PI_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { DEFAULT_AGENT_ID, normalizeChannelThreadKey, WEB_CHANNEL_ID, webChannelSessionKey } from './constants';
import { ensureDefaultAgent } from './agents';
import { getActiveChannelSession, setActiveChannelSession } from './active-sessions';
import { ensureSessionChannelLink } from './channel-links';

export type ResolveChannelSessionInput = {
  userId: string;
  channelId: string;
  channelSessionKey: string;
  channelThreadKey?: string | null;
  requestedSessionId?: string | null;
  displayName?: string | null;
  agentId?: string;
};

export async function userOwnsPiSession(sessionId: string, userId: string): Promise<boolean> {
  const session = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId)),
    columns: { id: true },
  });
  return Boolean(session);
}

export async function createChannelSession(input: ResolveChannelSessionInput): Promise<string> {
  await ensureDefaultAgent();

  const sessionId = input.requestedSessionId || `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const piConfig = await readPiRuntimeConfig();
  const model = await resolveActivePiModel();
  const now = new Date();

  await db.insert(piSessions).values({
    sessionId,
    userId: input.userId,
    agentId: input.agentId ?? DEFAULT_AGENT_ID,
    provider: piConfig.activeProvider,
    model: model.id,
    thinkingLevel: piConfig.providers[piConfig.activeProvider]?.thinking || 'off',
    channelId: 'app',
    channelSessionKey: null,
    title: DEFAULT_PI_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    lastViewedAt: null,
  }).onConflictDoNothing();

  await ensureSessionChannelLink({
    sessionId,
    userId: input.userId,
    channelId: input.channelId,
    channelSessionKey: input.channelSessionKey,
    channelThreadKey: input.channelThreadKey,
    displayName: input.displayName,
    isPrimary: input.channelId === WEB_CHANNEL_ID,
    inboundAt: now,
  });
  await setActiveChannelSession({ ...input, sessionId });
  return sessionId;
}

export async function resolveChannelSession(input: ResolveChannelSessionInput): Promise<string> {
  const channelThreadKey = normalizeChannelThreadKey(input.channelThreadKey);

  if (input.requestedSessionId) {
    const exists = await userOwnsPiSession(input.requestedSessionId, input.userId);
    if (!exists && input.channelId !== WEB_CHANNEL_ID) {
      throw new Error('Session not found');
    }

    await ensureSessionChannelLink({
      sessionId: input.requestedSessionId,
      userId: input.userId,
      channelId: input.channelId,
      channelSessionKey: input.channelSessionKey,
      channelThreadKey,
      displayName: input.displayName,
      isPrimary: input.channelId === WEB_CHANNEL_ID,
      inboundAt: new Date(),
    });
    await setActiveChannelSession({ ...input, channelThreadKey, sessionId: input.requestedSessionId });
    return input.requestedSessionId;
  }

  const activeSessionId = await getActiveChannelSession(input);
  if (activeSessionId && await userOwnsPiSession(activeSessionId, input.userId)) {
    await ensureSessionChannelLink({
      sessionId: activeSessionId,
      userId: input.userId,
      channelId: input.channelId,
      channelSessionKey: input.channelSessionKey,
      channelThreadKey,
      displayName: input.displayName,
      inboundAt: new Date(),
    });
    return activeSessionId;
  }

  const latestLink = await db.query.sessionChannelLinks.findFirst({
    where: and(
      eq(sessionChannelLinks.userId, input.userId),
      eq(sessionChannelLinks.channelId, input.channelId),
      eq(sessionChannelLinks.channelSessionKey, input.channelSessionKey),
      eq(sessionChannelLinks.channelThreadKey, channelThreadKey),
    ),
    orderBy: [desc(sessionChannelLinks.lastInboundAt), desc(sessionChannelLinks.updatedAt)],
    columns: { sessionId: true },
  });

  if (latestLink?.sessionId && await userOwnsPiSession(latestLink.sessionId, input.userId)) {
    await setActiveChannelSession({ ...input, channelThreadKey, sessionId: latestLink.sessionId });
    return latestLink.sessionId;
  }

  return createChannelSession(input);
}

export function getDefaultWebChannelContext(userId: string) {
  return {
    channelId: WEB_CHANNEL_ID,
    channelSessionKey: webChannelSessionKey(userId),
    channelThreadKey: '',
  };
}
