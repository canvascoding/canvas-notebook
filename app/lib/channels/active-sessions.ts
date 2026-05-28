import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { channelActiveSessions } from '@/app/lib/db/schema';
import { DEFAULT_AGENT_ID, normalizeChannelThreadKey } from './constants';

export type ChannelContextKey = {
  channelId: string;
  channelSessionKey: string;
  channelThreadKey?: string | null;
  agentId?: string | null;
};

function resolveAgentId(agentId?: string | null): string {
  return agentId?.trim() || DEFAULT_AGENT_ID;
}

export async function getActiveChannelSession(input: ChannelContextKey): Promise<string | null> {
  const row = await db.query.channelActiveSessions.findFirst({
    where: and(
      eq(channelActiveSessions.agentId, resolveAgentId(input.agentId)),
      eq(channelActiveSessions.channelId, input.channelId),
      eq(channelActiveSessions.channelSessionKey, input.channelSessionKey),
      eq(channelActiveSessions.channelThreadKey, normalizeChannelThreadKey(input.channelThreadKey)),
    ),
    columns: { sessionId: true },
  });
  return row?.sessionId ?? null;
}

export async function getLatestActiveChannelSession(input: {
  userId: string;
  channelId: string;
  agentId?: string | null;
}): Promise<{ sessionId: string; channelSessionKey: string; channelThreadKey: string } | null> {
  const row = await db.query.channelActiveSessions.findFirst({
    where: and(
      eq(channelActiveSessions.userId, input.userId),
      eq(channelActiveSessions.agentId, resolveAgentId(input.agentId)),
      eq(channelActiveSessions.channelId, input.channelId),
    ),
    columns: {
      sessionId: true,
      channelSessionKey: true,
      channelThreadKey: true,
    },
    orderBy: [desc(channelActiveSessions.updatedAt)],
  });
  return row ?? null;
}

export async function setActiveChannelSession(input: ChannelContextKey & {
  userId: string;
  sessionId: string;
}): Promise<void> {
  const channelThreadKey = normalizeChannelThreadKey(input.channelThreadKey);
  const agentId = resolveAgentId(input.agentId);
  const existing = await db.query.channelActiveSessions.findFirst({
    where: and(
      eq(channelActiveSessions.agentId, agentId),
      eq(channelActiveSessions.channelId, input.channelId),
      eq(channelActiveSessions.channelSessionKey, input.channelSessionKey),
      eq(channelActiveSessions.channelThreadKey, channelThreadKey),
    ),
    columns: { id: true },
  });

  const now = new Date();
  if (existing) {
    await db.update(channelActiveSessions)
      .set({
        userId: input.userId,
        sessionId: input.sessionId,
        updatedAt: now,
      })
      .where(eq(channelActiveSessions.id, existing.id));
    return;
  }

  await db.insert(channelActiveSessions).values({
    userId: input.userId,
    agentId,
    channelId: input.channelId,
    channelSessionKey: input.channelSessionKey,
    channelThreadKey,
    sessionId: input.sessionId,
    updatedAt: now,
  }).onConflictDoNothing();
}
