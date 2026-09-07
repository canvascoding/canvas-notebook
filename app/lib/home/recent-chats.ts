import 'server-only';

import { and, desc, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { aiMessages, aiSessions, piMessages, piSessions } from '@/app/lib/db/schema';
import { legacyAiTablesExist } from '@/app/lib/db/legacy-ai-tables';
import { listAgentAccessForUser } from '@/app/lib/agents/access';
import { listAgentProfiles } from '@/app/lib/agents/registry';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { HomeChatPage } from './continue-items';

export async function listHomeChats(userId: string, workspace: WorkspaceContext, query: string, limit: number): Promise<HomeChatPage> {
  if (!workspace.permissions.canRunAgent) return { chats: [], hasMore: false };
  const [agentAccess, agentProfiles] = await Promise.all([
    listAgentAccessForUser(userId, workspace),
    listAgentProfiles(),
  ]);
  const agentIds = [...agentAccess.entries()]
    .filter(([, access]) => access.canUse).map(([id]) => id);
  if (!agentIds.length) return { chats: [], hasMore: false };
  const agentIconIds = new Map(agentProfiles.map(agent => [agent.agentId, agent.iconId]));
  const pattern = `%${query.toLowerCase().replace(/[!%_]/g, character => `!${character}`)}%`;
  const workspaceCondition = workspace.workspaceType === 'personal'
    ? or(eq(piSessions.workspaceId, workspace.workspaceId), isNull(piSessions.workspaceId))
    : eq(piSessions.workspaceId, workspace.workspaceId);
  const activityAt = sql<number>`(select max(${piMessages.timestamp}) from ${piMessages} where ${piMessages.piSessionDbId} = ${piSessions.id} and ${piMessages.role} in ('user', 'assistant'))`;
  const piRows = await db.select({
    sessionId: piSessions.sessionId, title: piSessions.title, agentId: piSessions.agentId, activityAt,
    lastMessageAt: piSessions.lastMessageAt, lastViewedAt: piSessions.lastViewedAt,
  }).from(piSessions).where(and(
    eq(piSessions.userId, userId), workspaceCondition,
    inArray(piSessions.agentId, agentIds), eq(piSessions.sessionKind, 'conversation'), isNull(piSessions.archivedAt),
    exists(db.select({ id: piMessages.id }).from(piMessages).where(and(
      eq(piMessages.piSessionDbId, piSessions.id), inArray(piMessages.role, ['user', 'assistant']),
    ))),
    query ? sql`lower(coalesce(${piSessions.title}, '')) like ${pattern} escape '!'` : undefined,
  )).orderBy(desc(activityAt), desc(piSessions.id)).limit(limit + 1);
  const chats = piRows.map(row => ({
    sessionId: row.sessionId, title: row.title, activityAt: Number(row.activityAt),
    hasUnread: hasUnreadAssistantResponse(row.lastMessageAt, row.lastViewedAt), agentIconId: agentIconIds.get(row.agentId),
  }));
  // Older sessions have no workspace field and belong only to the user's personal workspace.
  if (workspace.workspaceType === 'personal' && agentIds.includes(DEFAULT_AGENT_ID) && await legacyAiTablesExist()) {
    const lastMessage = sql<Date>`(select max(${aiMessages.createdAt}) from ${aiMessages} where ${aiMessages.aiSessionDbId} = ${aiSessions.id} and ${aiMessages.role} in ('user', 'assistant'))`.mapWith(aiMessages.createdAt);
    const legacy = await db.select({ sessionId: aiSessions.sessionId, title: aiSessions.title, lastMessage })
      .from(aiSessions).where(and(
        eq(aiSessions.userId, userId),
        exists(db.select({ id: aiMessages.id }).from(aiMessages).where(and(eq(aiMessages.aiSessionDbId, aiSessions.id), inArray(aiMessages.role, ['user', 'assistant'])))),
        query ? sql`lower(coalesce(${aiSessions.title}, '')) like ${pattern} escape '!'` : undefined,
      )).orderBy(desc(lastMessage), desc(aiSessions.id)).limit(limit + 1);
    chats.push(...legacy.map(row => ({ sessionId: row.sessionId, title: row.title, activityAt: row.lastMessage.getTime(), hasUnread: false, agentIconId: agentIconIds.get(DEFAULT_AGENT_ID) })));
  }
  chats.sort((a, b) => b.activityAt - a.activityAt || a.sessionId.localeCompare(b.sessionId));
  const unique = chats.filter((chat, index) => chats.findIndex(item => item.sessionId === chat.sessionId) === index);
  return { chats: unique.slice(0, limit), hasMore: unique.length > limit };
}
