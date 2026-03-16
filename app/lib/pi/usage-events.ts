import { createHash } from 'node:crypto';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Usage } from '@mariozechner/pi-ai';
import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import { piSessions, piUsageEvents } from '../db/schema';

export type UsageSummaryGroupBy = 'day' | 'provider' | 'model' | 'user' | 'session';

type PersistPiUsageEventsParams = {
  sessionId: string;
  userId: string;
  messages: AgentMessage[];
};

export type PiUsageEventRow = typeof piUsageEvents.$inferSelect;

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

export function hasTrackedUsage(usage: Usage | undefined | null): usage is Usage {
  if (!usage) {
    return false;
  }

  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.totalTokens > 0 ||
    usage.cost.input > 0 ||
    usage.cost.output > 0 ||
    usage.cost.cacheRead > 0 ||
    usage.cost.cacheWrite > 0 ||
    usage.cost.total > 0
  );
}

export function buildPiUsageFingerprint(sessionId: string, message: AssistantMessage): string {
  const serializedMessage = JSON.stringify(message);
  return createHash('sha256')
    .update(`${sessionId}:${serializedMessage}`)
    .digest('hex');
}

export function extractPiUsageEventValues(params: {
  sessionId: string;
  userId: string;
  sessionTitleSnapshot?: string | null;
  messages: AgentMessage[];
}) {
  return params.messages
    .filter(isAssistantMessage)
    .filter((message) => hasTrackedUsage(message.usage))
    .map((message) => ({
      fingerprint: buildPiUsageFingerprint(params.sessionId, message),
      userId: params.userId,
      sessionId: params.sessionId,
      provider: message.provider,
      model: message.model,
      sessionTitleSnapshot: params.sessionTitleSnapshot ?? null,
      assistantTimestamp: new Date(message.timestamp),
      stopReason: message.stopReason,
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite,
      totalTokens: message.usage.totalTokens,
      inputCost: message.usage.cost.input,
      outputCost: message.usage.cost.output,
      cacheReadCost: message.usage.cost.cacheRead,
      cacheWriteCost: message.usage.cost.cacheWrite,
      totalCost: message.usage.cost.total,
      createdAt: new Date(),
    }));
}

async function loadSessionTitleSnapshot(sessionId: string, userId: string): Promise<string | null> {
  const session = await db.query.piSessions.findFirst({
    columns: {
      title: true,
    },
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId)),
  });

  return session?.title ?? null;
}

export async function persistPiUsageEvents({
  sessionId,
  userId,
  messages,
}: PersistPiUsageEventsParams): Promise<number> {
  if (!sessionId || messages.length === 0) {
    return 0;
  }

  const sessionTitleSnapshot = await loadSessionTitleSnapshot(sessionId, userId);
  const values = extractPiUsageEventValues({
    sessionId,
    userId,
    sessionTitleSnapshot,
    messages,
  });

  if (values.length === 0) {
    return 0;
  }

  await db
    .insert(piUsageEvents)
    .values(values)
    .onConflictDoNothing({ target: piUsageEvents.fingerprint });

  return values.length;
}
