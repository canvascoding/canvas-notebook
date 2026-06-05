import { db } from '../db';
import { legacyAiTablesExist } from '../db/legacy-ai-tables';
import { piSessions, piMessages, aiSessions, aiMessages, sessionChannelLinks } from '../db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { type AgentMessage } from '@earendil-works/pi-agent-core';
import { type PiSessionSummaryState } from './history-budget';
import { DEFAULT_PI_SESSION_TITLE, isAutomaticSessionTitle } from './session-titles';
import {
  createPiSystemPromptSnapshot,
  piSystemPromptSnapshotDbFields,
  type PiSystemPromptSnapshot,
} from './system-prompt-snapshot';
import { parsePersistedPiMessage, type PiMessageProjectionMode } from './message-projection';
import { ensureSessionChannelLink } from '@/app/lib/channels/channel-links';
import { DEFAULT_AGENT_ID, normalizeChannelThreadKey, normalizeStoredChannelId, WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';

/**
 * Handles persistence for PI session snapshots (AgentMessage context).
 */

const SESSION_TITLE_MAX_LENGTH = 48;

function resolveSessionAgentId(agentId?: string | null): string {
  return agentId?.trim() || DEFAULT_AGENT_ID;
}

function buildPiSessionLookup(sessionId: string, userId: string, agentId?: string | null) {
  return and(
    eq(piSessions.sessionId, sessionId),
    eq(piSessions.userId, userId),
    eq(piSessions.agentId, resolveSessionAgentId(agentId)),
  );
}

function extractFirstUserText(messages: AgentMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  if (!firstUserMessage) {
    return '';
  }

  if (typeof firstUserMessage.content === 'string') {
    return firstUserMessage.content;
  }

  if (!Array.isArray(firstUserMessage.content)) {
    return '';
  }

  const firstTextPart = firstUserMessage.content.find((part) => {
    return typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && typeof (part as { text?: unknown }).text === 'string';
  }) as { text: string } | undefined;

  return firstTextPart?.text ?? '';
}

function truncateSessionTitle(value: string): string {
  if (value.length <= SESSION_TITLE_MAX_LENGTH) {
    return value;
  }

  return `${value.slice(0, SESSION_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

function deriveSessionTitle(messages: AgentMessage[]): string {
  const normalized = extractFirstUserText(messages).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return DEFAULT_PI_SESSION_TITLE;
  }

  return truncateSessionTitle(normalized);
}

function getAgentMessageTimestamp(message: AgentMessage): number {
  if ('timestamp' in message && typeof message.timestamp === 'number') {
    return message.timestamp;
  }

  return Date.now();
}

function attachPersistedSequence(message: AgentMessage, sequence: number): AgentMessage {
  return {
    ...(message as unknown as Record<string, unknown>),
    sequence,
  } as unknown as AgentMessage;
}

export async function savePiSession(
  sessionId: string,
  userId: string,
  provider: string,
  model: string,
  messages: AgentMessage[],
  summary?: PiSessionSummaryState,
  options?: {
    titleOverride?: string | null;
    persistedLength?: number;
    channelId?: string;
    channelSessionKey?: string | null;
    channelThreadKey?: string | null;
    agentId?: string | null;
    systemPromptSnapshot?: PiSystemPromptSnapshot;
  },
): Promise<void> {
  const agentId = resolveSessionAgentId(options?.agentId);
  // Find or create session
  const session = await db.query.piSessions.findFirst({
    where: buildPiSessionLookup(sessionId, userId, agentId),
  });
  const derivedTitle = deriveSessionTitle(messages);
  const normalizedTitleOverride = options?.titleOverride?.trim() || null;
  const resolvedTitle = normalizedTitleOverride || derivedTitle;

  let sessionDbId: number;

  const summaryFields = summary
    ? {
        summaryText: summary.summaryText ?? null,
        summaryUpdatedAt: summary.summaryUpdatedAt ?? null,
        summaryThroughTimestamp: summary.summaryThroughTimestamp ?? null,
        summaryThroughSequence: summary.summaryThroughSequence ?? null,
      }
    : {};

  const startIndex = options?.persistedLength ?? 0;
  const newMessages = messages.slice(startIndex);
  const hasNewAssistantMessage = newMessages.some((message) => message.role === 'assistant');
  const shouldMarkAssistantActivity = hasNewAssistantMessage && (!session || options?.persistedLength !== undefined || !session.lastMessageAt);
  const assistantActivityAt = shouldMarkAssistantActivity ? new Date() : null;
  const lastMessageAt = assistantActivityAt ?? session?.lastMessageAt ?? null;

  if (!session) {
    const promptSnapshot = options?.systemPromptSnapshot ?? await createPiSystemPromptSnapshot(agentId);
    const [inserted] = await db.insert(piSessions).values({
      sessionId,
      userId,
      agentId,
      provider,
      model,
      title: resolvedTitle,
      channelId: 'app',
      channelSessionKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastMessageAt: lastMessageAt,
      lastViewedAt: null,
      ...piSystemPromptSnapshotDbFields(promptSnapshot),
      ...summaryFields,
    }).returning({ id: piSessions.id });
    sessionDbId = inserted.id;
  } else {
    sessionDbId = session.id;
    const nextTitle = normalizedTitleOverride || (isAutomaticSessionTitle(session.title) ? derivedTitle : session.title);
    const promptSnapshotFields = session.systemPromptSnapshot
      ? {}
      : piSystemPromptSnapshotDbFields(options?.systemPromptSnapshot ?? await createPiSystemPromptSnapshot(agentId));

    await db.update(piSessions)
      .set({ 
        updatedAt: new Date(), 
        title: nextTitle, 
        provider,
        model,
        lastMessageAt: lastMessageAt,
        ...promptSnapshotFields,
        ...summaryFields 
      })
      .where(eq(piSessions.id, sessionDbId));
  }

  const normalizedChannelId = normalizeStoredChannelId(options?.channelId ?? session?.channelId ?? 'app');
  await ensureSessionChannelLink({
    sessionId,
    userId,
    channelId: normalizedChannelId,
    channelSessionKey: options?.channelSessionKey
      ?? session?.channelSessionKey
      ?? (normalizedChannelId === WEB_CHANNEL_ID ? webChannelSessionKey(userId) : `${normalizedChannelId}:unknown`),
    channelThreadKey: options?.channelThreadKey ?? null,
    displayName: resolvedTitle,
    isPrimary: normalizedChannelId === WEB_CHANNEL_ID,
    outboundAt: lastMessageAt,
  });

  if (startIndex === 0) {
    await db.delete(piMessages).where(eq(piMessages.piSessionDbId, sessionDbId));
  }

  if (newMessages.length > 0) {
    await db.insert(piMessages).values(
      newMessages.map((m, index) => ({
        piSessionDbId: sessionDbId,
        role: m.role,
        content: JSON.stringify(m),
        timestamp: getAgentMessageTimestamp(m),
        sequence: startIndex + index + 1,
      }))
    );
  }
}

export async function loadPiSession(
  sessionId: string,
  userId: string,
  agentId?: string | null,
  options?: { projectionMode?: PiMessageProjectionMode },
): Promise<AgentMessage[] | null> {
  const session = await db.query.piSessions.findFirst({
    where: buildPiSessionLookup(sessionId, userId, agentId),
  });

  if (session) {
    const messages = await db.select()
      .from(piMessages)
      .where(eq(piMessages.piSessionDbId, session.id))
      .orderBy(asc(piMessages.sequence), asc(piMessages.id));

    return messages.map(m => attachPersistedSequence(parsePersistedPiMessage(m.content, options?.projectionMode ?? 'context'), m.sequence));
  }

  if (resolveSessionAgentId(agentId) !== DEFAULT_AGENT_ID) {
    return null;
  }

  if (!(await legacyAiTablesExist())) {
    return null;
  }

  // Best-effort migration from legacy aiSessions
  const legacySession = await db.query.aiSessions.findFirst({
    where: and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.userId, userId))
  });

  if (legacySession) {
    const legacyMessages = await db.select()
      .from(aiMessages)
      .where(eq(aiMessages.aiSessionDbId, legacySession.id))
      .orderBy(asc(aiMessages.createdAt));

    return legacyMessages.map<AgentMessage>(m => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: m.content }],
          api: 'legacy',
          provider: 'legacy',
          model: legacySession.model,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: m.createdAt.getTime(),
        } as AgentMessage;
      }
      return {
        role: 'user',
        content: m.content,
        timestamp: m.createdAt.getTime(),
      } as AgentMessage;
    });
  }

  return null;
}

export async function loadPiSessionWithSummary(
  sessionId: string,
  userId: string,
  agentId?: string | null,
  options?: { projectionMode?: PiMessageProjectionMode },
): Promise<{ messages: AgentMessage[]; summary: PiSessionSummaryState } | null> {
  const session = await db.query.piSessions.findFirst({
    where: buildPiSessionLookup(sessionId, userId, agentId),
  });

  if (!session) {
    return null;
  }

  const rows = await db.select()
    .from(piMessages)
    .where(eq(piMessages.piSessionDbId, session.id))
    .orderBy(asc(piMessages.sequence), asc(piMessages.id));

  return {
    messages: rows.map(m => attachPersistedSequence(parsePersistedPiMessage(m.content, options?.projectionMode ?? 'context'), m.sequence)),
    summary: {
      summaryText: session.summaryText ?? null,
      summaryUpdatedAt: session.summaryUpdatedAt ?? null,
      summaryThroughTimestamp: session.summaryThroughTimestamp ?? null,
      summaryThroughSequence: session.summaryThroughSequence ?? null,
    },
  };
}

export async function markPiSessionAsRead(sessionId: string, userId: string, agentId?: string | null): Promise<void> {
  const session = await db.query.piSessions.findFirst({
    where: buildPiSessionLookup(sessionId, userId, agentId),
  });

  if (session) {
    await db.update(piSessions)
      .set({ lastViewedAt: new Date() })
      .where(eq(piSessions.id, session.id));
  }
}

export async function updatePiSessionLastMessageAt(sessionId: string, userId: string, timestamp: Date, agentId?: string | null): Promise<void> {
  const session = await db.query.piSessions.findFirst({
    where: buildPiSessionLookup(sessionId, userId, agentId),
  });

  if (session) {
    await db.update(piSessions)
      .set({ lastMessageAt: timestamp, updatedAt: new Date() })
      .where(eq(piSessions.id, session.id));
  }
}

export async function loadPiSessionByChannelKey(
  channelId: string,
  channelSessionKey: string,
  options?: { projectionMode?: PiMessageProjectionMode },
): Promise<AgentMessage[] | null> {
  const normalizedChannelId = normalizeStoredChannelId(channelId);
  const link = await db.query.sessionChannelLinks.findFirst({
    where: and(
      eq(sessionChannelLinks.channelId, normalizedChannelId),
      eq(sessionChannelLinks.channelSessionKey, channelSessionKey),
      eq(sessionChannelLinks.channelThreadKey, normalizeChannelThreadKey(null)),
    ),
    columns: { sessionId: true },
  });

  if (!link) return null;

  const session = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, link.sessionId),
  });

  if (!session) return null;

  const rows = await db.select()
    .from(piMessages)
    .where(eq(piMessages.piSessionDbId, session.id))
    .orderBy(asc(piMessages.sequence), asc(piMessages.id));

  return rows.map(m => attachPersistedSequence(parsePersistedPiMessage(m.content, options?.projectionMode ?? 'context'), m.sequence));
}
