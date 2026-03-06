import { db } from '../db';
import { piSessions, piMessages, aiSessions, aiMessages } from '../db/schema';
import { eq, desc, and, asc } from 'drizzle-orm';
import { type AgentMessage } from '@mariozechner/pi-agent-core';

/**
 * Handles persistence for PI session snapshots (AgentMessage context).
 */

export async function savePiSession(
  sessionId: string, 
  userId: string,
  provider: string,
  model: string,
  messages: AgentMessage[]
): Promise<void> {
  // Find or create session
  let session = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId))
  });

  let sessionDbId: number;

  if (!session) {
    const title = messages.find(m => m.role === 'user')?.content;
    const titleStr = typeof title === 'string' ? title : Array.isArray(title) ? (title[0] as any).text : 'New PI Chat';
    
    const [inserted] = await db.insert(piSessions).values({
      sessionId,
      userId,
      provider,
      model,
      title: titleStr.substring(0, 100),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning({ id: piSessions.id });
    sessionDbId = inserted.id;
  } else {
    sessionDbId = session.id;
    await db.update(piSessions)
      .set({ updatedAt: new Date() })
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
        timestamp: (m as any).timestamp || Date.now(),
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

    return legacyMessages.map(m => {
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
        } as any;
      }
      return {
        role: 'user',
        content: m.content,
        timestamp: m.createdAt.getTime(),
      } as any;
    });
  }

  return null;
}
