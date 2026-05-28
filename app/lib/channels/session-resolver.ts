import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions, sessionChannelLinks } from '@/app/lib/db/schema';
import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
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

function resolveAgentId(agentId?: string | null): string {
  return agentId?.trim() || DEFAULT_AGENT_ID;
}

export async function userOwnsPiSession(sessionId: string, userId: string, agentId?: string | null): Promise<boolean> {
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, userId),
      eq(piSessions.agentId, resolveAgentId(agentId)),
    ),
    columns: { id: true },
  });
  return Boolean(session);
}

export async function createChannelSession(input: ResolveChannelSessionInput): Promise<string> {
  await ensureDefaultAgent();

  const agentId = resolveAgentId(input.agentId);
  const sessionId = input.requestedSessionId || `sess-${Date.now()}-${randomUUID()}`;
  const effectiveConfig = await resolveAgentRuntimeConfig(agentId);
  const now = new Date();

  await db.insert(piSessions).values({
    sessionId,
    userId: input.userId,
    agentId,
    provider: effectiveConfig.activeProvider,
    model: effectiveConfig.model.id,
    thinkingLevel: effectiveConfig.thinkingLevel,
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
  await setActiveChannelSession({ ...input, agentId, sessionId });
  return sessionId;
}

export async function resolveChannelSession(input: ResolveChannelSessionInput): Promise<string> {
  const channelThreadKey = normalizeChannelThreadKey(input.channelThreadKey);
  const agentId = resolveAgentId(input.agentId);

  if (input.requestedSessionId) {
    const exists = await userOwnsPiSession(input.requestedSessionId, input.userId, agentId);
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
    await setActiveChannelSession({ ...input, agentId, channelThreadKey, sessionId: input.requestedSessionId });
    return input.requestedSessionId;
  }

  const activeSessionId = await getActiveChannelSession({ ...input, agentId });
  if (activeSessionId && await userOwnsPiSession(activeSessionId, input.userId, agentId)) {
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

  const latestLinks = await db.query.sessionChannelLinks.findMany({
    where: and(
      eq(sessionChannelLinks.userId, input.userId),
      eq(sessionChannelLinks.channelId, input.channelId),
      eq(sessionChannelLinks.channelSessionKey, input.channelSessionKey),
      eq(sessionChannelLinks.channelThreadKey, channelThreadKey),
    ),
    orderBy: [desc(sessionChannelLinks.lastInboundAt), desc(sessionChannelLinks.updatedAt)],
    columns: { sessionId: true },
    limit: 20,
  });

  for (const latestLink of latestLinks) {
    if (await userOwnsPiSession(latestLink.sessionId, input.userId, agentId)) {
      await setActiveChannelSession({ ...input, agentId, channelThreadKey, sessionId: latestLink.sessionId });
      return latestLink.sessionId;
    }
  }

  return createChannelSession({ ...input, agentId });
}

export function getDefaultWebChannelContext(userId: string) {
  return {
    channelId: WEB_CHANNEL_ID,
    channelSessionKey: webChannelSessionKey(userId),
    channelThreadKey: '',
  };
}
