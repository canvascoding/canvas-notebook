import 'server-only';

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { requireAgentAccessForWorkspace } from '@/app/lib/agents/access';
import { findOwnedPiSessionForRuntime, isPiSessionInWorkspace } from '@/app/lib/pi/session-runtime-access';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import type { AutomationDeliverySessionMode, AutomationWorkspaceType } from './types';

export class AutomationChatTargetError extends Error {
  readonly status = 409;
  readonly code = 'AUTOMATION_CHAT_UNAVAILABLE';
  constructor() {
    super('The selected chat is no longer available for this agent and workspace. Choose another chat in the automation settings.');
    this.name = 'AutomationChatTargetError';
  }
}

export async function assertAutomationChatTarget(input: {
  deliverySessionMode: AutomationDeliverySessionMode;
  deliverySessionId?: string | null;
  userId: string;
  agentId: string;
  workspaceId: string | null;
  workspaceType: AutomationWorkspaceType;
}): Promise<void> {
  if (input.deliverySessionMode !== 'fixed_session') return;
  const row = input.deliverySessionId?.trim() ? await findOwnedPiSessionForRuntime({
    sessionId: input.deliverySessionId.trim(), userId: input.userId, agentId: input.agentId,
  }) : null;
  if (!row || row.sessionKind !== 'conversation' || row.archivedAt || !isPiSessionInWorkspace(row, { workspaceId: input.workspaceId || '', workspaceType: input.workspaceType })) {
    throw new AutomationChatTargetError();
  }
}

export async function listAutomationChatTargets(input: {
  userId: string;
  agentId: string;
  workspaceId: string;
  query?: string;
  cursor?: string;
  sessionId?: string;
}) {
  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId: input.userId, workspaceId: input.workspaceId, permissions: ['canRead', 'canRunAgent'],
  });
  await requireAgentAccessForWorkspace(input.userId, input.agentId, 'canUse', workspace);
  const query = (input.query || '').trim().slice(0, 120).replace(/[\\%_]/g, '\\$&');
  const offset = Math.min(10000, Math.max(0, Number.parseInt(input.cursor || '0', 10) || 0));
  const rows = await db.select({
    sessionId: piSessions.sessionId,
    title: piSessions.title,
    agentId: piSessions.agentId,
    lastMessageAt: piSessions.lastMessageAt,
    createdAt: piSessions.createdAt,
  }).from(piSessions).where(and(
    eq(piSessions.userId, input.userId),
    eq(piSessions.agentId, input.agentId),
    eq(piSessions.sessionKind, 'conversation'),
    isNull(piSessions.archivedAt),
    workspace.workspaceType === 'personal'
      ? or(eq(piSessions.workspaceId, workspace.workspaceId), isNull(piSessions.workspaceId))
      : eq(piSessions.workspaceId, workspace.workspaceId),
    query ? sql`lower(coalesce(${piSessions.title}, '')) LIKE ${`%${query.toLowerCase()}%`} ESCAPE '\\'` : undefined,
    input.sessionId ? eq(piSessions.sessionId, input.sessionId) : undefined,
  )).orderBy(desc(sql`coalesce(${piSessions.lastMessageAt}, ${piSessions.createdAt})`), desc(piSessions.id)).limit(31).offset(offset);
  return {
    chats: rows.slice(0, 30).map((row) => ({
      sessionId: row.sessionId, title: row.title, agentId: row.agentId,
      lastActivityAt: (row.lastMessageAt || row.createdAt).toISOString(),
    })),
    nextCursor: rows.length > 30 ? String(offset + 30) : null,
  };
}
