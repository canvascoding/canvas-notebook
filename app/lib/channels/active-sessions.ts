import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { channelActiveSessions } from '@/app/lib/db/schema';
import { DEFAULT_AGENT_ID, normalizeChannelThreadKey } from './constants';
import { setActiveChannelSessionState } from './channel-session-store';
import type { ChannelContextKey } from './channel-context';

export type { ChannelContextKey } from './channel-context';

function resolveAgentId(agentId?: string | null): string {
  return agentId?.trim() || DEFAULT_AGENT_ID;
}

export async function getActiveChannelSession(input: ChannelContextKey): Promise<string | null> {
  const row = await db.query.channelActiveSessions.findFirst({
    where: and(
      eq(channelActiveSessions.userId, input.userId),
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

export async function getRecentActiveChannelSessions(input: {
  userId: string;
  agentId?: string | null;
  limit?: number;
}): Promise<Array<{
  sessionId: string;
  channelId: string;
  channelSessionKey: string;
  channelThreadKey: string;
}>> {
  return db.query.channelActiveSessions.findMany({
    where: and(
      eq(channelActiveSessions.userId, input.userId),
      eq(channelActiveSessions.agentId, resolveAgentId(input.agentId)),
    ),
    columns: {
      sessionId: true,
      channelId: true,
      channelSessionKey: true,
      channelThreadKey: true,
    },
    orderBy: [desc(channelActiveSessions.updatedAt)],
    limit: input.limit ?? 10,
  });
}

export async function setActiveChannelSession(input: ChannelContextKey & {
  sessionId: string;
}): Promise<void> {
  await setActiveChannelSessionState(input);
}
