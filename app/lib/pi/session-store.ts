import { db } from '../db';
import { piSessions, piMessages, aiSessions, aiMessages } from '../db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { type AgentMessage } from '@mariozechner/pi-agent-core';

/**
 * Handles persistence for PI session snapshots (AgentMessage context).
 */

const DEFAULT_PI_SESSION_TITLE = 'New PI Chat';
const SESSION_TITLE_MAX_LENGTH = 48;
const AUTOMATIC_SESSION_TITLES = new Set(['', 'New session', DEFAULT_PI_SESSION_TITLE]);

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

function isAutomaticSessionTitle(value: string | null | undefined): boolean {
  if (typeof value !== 'string') {
    return true;
  }

  return AUTOMATIC_SESSION_TITLES.has(value.trim());
}

function getAgentMessageTimestamp(message: AgentMessage): number {
  if ('timestamp' in message && typeof message.timestamp === 'number') {
    return message.timestamp;
  }

  return Date.now();
}

export async function savePiSession(
  sessionId: string, 
  userId: string,
  provider: string,
  model: string,
  messages: AgentMessage[]
): Promise<void> {
  // Find or create session
  const session = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId))
  });
  const derivedTitle = deriveSessionTitle(messages);

  let sessionDbId: number;

  if (!session) {
    const [inserted] = await db.insert(piSessions).values({
      sessionId,
      userId,
      provider,
      model,
      title: derivedTitle,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning({ id: piSessions.id });
    sessionDbId = inserted.id;
  } else {
    sessionDbId = session.id;
    const nextTitle = isAutomaticSessionTitle(session.title) ? derivedTitle : session.title;

    await db.update(piSessions)
      .set({ updatedAt: new Date(), title: nextTitle })
      .where(eq(piSessions.id, sessionDbId));
  }

  // Replace messages (simplified: delete all and re-insert)
  await db.delete(piMessages).where(eq(piMessages.piSessionDbId, sessionDbId));

  if (messages.length > 0) {
    await db.insert(piMessages).values(
      messages.map(m => ({
        piSessionDbId: sessionDbId,
        role: m.role,
        content: JSON.stringify(m),
        timestamp: getAgentMessageTimestamp(m),
      }))
    );
  }
}

export async function loadPiSession(sessionId: string, userId: string): Promise<AgentMessage[] | null> {
  const session = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId))
  });

  if (session) {
    const messages = await db.select()
      .from(piMessages)
      .where(eq(piMessages.piSessionDbId, session.id))
      .orderBy(asc(piMessages.timestamp));

    return messages.map(m => JSON.parse(m.content) as AgentMessage);
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
