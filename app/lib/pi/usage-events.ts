import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import { piSessions, piUsageEvents } from '../db/schema';

type PersistPiUsageEventsParams = {
  sessionId: string;
  userId: string;
  messages: AgentMessage[];
};

export type PiUsageEventRow = typeof piUsageEvents.$inferSelect;

type PiUsageSessionContext = {
  sessionTitleSnapshot: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  workspaceType: string | null;
  agentId: string;
};

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
  organizationId?: string | null;
  workspaceId?: string | null;
  workspaceType?: string | null;
  agentId?: string | null;
  messages: AgentMessage[];
}) {
  return params.messages
    .filter(isAssistantMessage)
    .filter((message) => hasTrackedUsage(message.usage))
    .map((message) => ({
      fingerprint: buildPiUsageFingerprint(params.sessionId, message),
      userId: params.userId,
      organizationId: params.organizationId ?? null,
      workspaceId: params.workspaceId ?? null,
      workspaceType: params.workspaceType ?? null,
      agentId: params.agentId ?? 'canvas-agent',
      sessionId: params.sessionId,
      provider: message.provider,
      model: message.model,
      sessionTitleSnapshot: params.sessionTitleSnapshot ?? null,
      assistantTimestamp: Math.floor(new Date(message.timestamp).getTime() / 1000), // Convert Date to Unix timestamp (seconds)
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

async function loadSessionUsageContext(sessionId: string, userId: string): Promise<PiUsageSessionContext> {
  const session = await db.query.piSessions.findFirst({
    columns: {
      title: true,
      organizationId: true,
      workspaceId: true,
      workspaceType: true,
      agentId: true,
    },
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId)),
  });

  return {
    sessionTitleSnapshot: session?.title ?? null,
    organizationId: session?.organizationId ?? null,
    workspaceId: session?.workspaceId ?? null,
    workspaceType: session?.workspaceType ?? null,
    agentId: session?.agentId ?? 'canvas-agent',
  };
}

export async function persistPiUsageEvents({
  sessionId,
  userId,
  messages,
}: PersistPiUsageEventsParams): Promise<number> {
  if (!sessionId || messages.length === 0) {
    return 0;
  }

  const sessionContext = await loadSessionUsageContext(sessionId, userId);
  const values = extractPiUsageEventValues({
    sessionId,
    userId,
    ...sessionContext,
    messages,
  });

  if (values.length === 0) {
    return 0;
  }

  await db
    .insert(piUsageEvents)
    .values(values)
    .onConflictDoNothing({ target: [piUsageEvents.fingerprint] });

  return values.length;
}
