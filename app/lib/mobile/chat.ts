import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { listManagedAgents } from '@/app/lib/agents/management-actions';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { prepareSessionRuntimeSnapshot } from '@/app/lib/agent-runtime-policy/session-runtime-service';
import { WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';
import { ensureDefaultAgent } from '@/app/lib/channels/agents';
import { ensureSessionChannelLink } from '@/app/lib/channels/channel-links';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import { db } from '@/app/lib/db';
import { piMessages, piSessions } from '@/app/lib/db/schema';
import { getActiveRuntimeStatusSummaries } from '@/app/lib/pi/runtime-service';
import { parsePersistedPiMessage } from '@/app/lib/pi/message-projection';
import { createPiSessionWithRuntimeSnapshot } from '@/app/lib/pi/session-store';
import { DEFAULT_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { createPiSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';
import {
  resolveAgentSessionWorkspaceForUser,
  workspaceToPiSessionFields,
} from '@/app/lib/pi/session-workspace-context';

export class MobileChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MobileChatError';
  }
}

export type MobileChatAgent = {
  id: string;
  name: string;
  iconId: string;
  type: string;
};

export type MobileChatSession = {
  id: string;
  title: string;
  agentId: string;
  createdAt: string;
  lastMessageAt: string | null;
  hasUnread: boolean;
  runtime: {
    phase: string | null;
    activeToolName: string | null;
  };
};

export type MobileChatMessage = {
  id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  kind: 'message' | 'tool' | 'error';
  text: string;
  toolName: string | null;
  createdAt: string;
};

type ChatActor = {
  userId: string;
  sessionId: string;
  workspaceId: string;
};

type SessionCursor = { activityAt: string; id: number };

function encodeSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeMobileSessionCursor(value: string | null): SessionCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const activityAt = typeof parsed.activityAt === 'string' ? parsed.activityAt : '';
    const id = typeof parsed.id === 'number' ? parsed.id : Number.NaN;
    if (!activityAt || !Number.isSafeInteger(id) || id < 1 || Number.isNaN(new Date(activityAt).getTime())) {
      throw new Error('Invalid cursor');
    }
    return { activityAt, id };
  } catch {
    throw new MobileChatError('INVALID_CURSOR', 'The session cursor is invalid.', 400);
  }
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MobileChatError('INVALID_LIMIT', 'The page size is invalid.', 400);
  }
  return Math.min(value, maximum);
}

function workspaceSessionCondition(workspaceId: string, workspaceType: string): SQL {
  return workspaceType === 'personal'
    ? or(eq(piSessions.workspaceId, workspaceId), isNull(piSessions.workspaceId))!
    : eq(piSessions.workspaceId, workspaceId);
}

async function resolveChatWorkspace(actor: ChatActor) {
  try {
    return await resolveAgentSessionWorkspaceForUser({
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      permissions: ['canRead', 'canRunAgent'],
    });
  } catch {
    throw new MobileChatError(
      'WORKSPACE_ACCESS_DENIED',
      'The workspace is unavailable or cannot run agents.',
      403,
    );
  }
}

function serializeAgent(agent: Awaited<ReturnType<typeof listManagedAgents>>[number]): MobileChatAgent {
  return {
    id: agent.agentId,
    name: agent.name,
    iconId: agent.iconId,
    type: agent.type,
  };
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const record = part as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') return [record.text];
    if (typeof record.content === 'string') return [record.content];
    return [];
  }).join('\n');
}

export function serializeMobileChatMessage(input: {
  id: number;
  sequence: number;
  timestamp: number;
  content: string;
}): MobileChatMessage {
  const parsed = parsePersistedPiMessage(input.content, 'display') as unknown as Record<string, unknown>;
  const rawRole = typeof parsed.role === 'string' ? parsed.role : 'system';
  const role: MobileChatMessage['role'] = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system'
    ? rawRole
    : 'tool';
  const isError = parsed.isError === true || parsed.error === true;
  return {
    id: String(input.id),
    sequence: input.sequence,
    role,
    kind: isError ? 'error' : role === 'tool' ? 'tool' : 'message',
    text: messageText(parsed),
    toolName: typeof parsed.toolName === 'string' ? parsed.toolName : null,
    createdAt: new Date(input.timestamp).toISOString(),
  };
}

export async function listMobileChat(input: ChatActor & {
  cursor?: string | null;
  limit?: number;
}) {
  const workspace = await resolveChatWorkspace(input);
  const agents = await listManagedAgents({
    userId: input.userId,
    sessionId: input.sessionId,
    source: 'api',
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
  });
  const agentIds = agents.map((agent) => agent.agentId);
  const limit = normalizeLimit(input.limit, 30, 50);
  const cursor = decodeMobileSessionCursor(input.cursor || null);
  const activity = sql<Date>`coalesce(${piSessions.lastMessageAt}, ${piSessions.createdAt})`;
  const conditions: SQL[] = [
    eq(piSessions.userId, input.userId),
    workspaceSessionCondition(workspace.workspaceId, workspace.workspaceType),
    inArray(piSessions.agentId, agentIds),
  ];
  if (cursor) {
    const activityAt = new Date(cursor.activityAt);
    conditions.push(or(
      lt(activity, activityAt),
      and(eq(activity, activityAt), lt(piSessions.id, cursor.id)),
    )!);
  }

  const rows = await db
    .select({
      id: piSessions.id,
      sessionId: piSessions.sessionId,
      title: piSessions.title,
      agentId: piSessions.agentId,
      createdAt: piSessions.createdAt,
      lastMessageAt: piSessions.lastMessageAt,
      lastViewedAt: piSessions.lastViewedAt,
    })
    .from(piSessions)
    .where(and(...conditions))
    .orderBy(desc(activity), desc(piSessions.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const runtime = await getActiveRuntimeStatusSummaries({
    userId: input.userId,
    sessionIds: pageRows.map((row) => row.sessionId),
  });
  const sessions: MobileChatSession[] = pageRows.map((row) => ({
    id: row.sessionId,
    title: row.title?.trim() || DEFAULT_SESSION_TITLE,
    agentId: row.agentId,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt?.toISOString() || null,
    hasUnread: hasUnreadAssistantResponse(row.lastMessageAt, row.lastViewedAt),
    runtime: {
      phase: runtime[row.sessionId]?.phase || null,
      activeToolName: runtime[row.sessionId]?.activeToolName || null,
    },
  }));
  const last = pageRows.at(-1);
  return {
    agents: agents.map(serializeAgent),
    sessions,
    nextCursor: rows.length > limit && last
      ? encodeSessionCursor({
          activityAt: (last.lastMessageAt || last.createdAt).toISOString(),
          id: last.id,
        })
      : null,
  };
}

export async function createMobileChatSession(input: ChatActor & {
  agentId?: string;
  title?: string;
}) {
  const workspace = await resolveChatWorkspace(input);
  await ensureDefaultAgent();
  let agentId: string;
  try {
    agentId = normalizeManagedAgentId(input.agentId);
  } catch {
    throw new MobileChatError('INVALID_AGENT', 'The selected agent is invalid.', 400);
  }
  const agent = await getAgentProfile(agentId);
  if (!agent) throw new MobileChatError('AGENT_NOT_FOUND', 'The selected agent was not found.', 404);
  try {
    await requireAgentAccess(input.userId, agentId, 'canUse', {
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
    });
  } catch {
    throw new MobileChatError('AGENT_ACCESS_DENIED', 'The selected agent is unavailable.', 403);
  }
  if (!workspace.organizationId) {
    throw new MobileChatError('ORGANIZATION_SETUP_REQUIRED', 'Complete the Canvas setup first.', 409);
  }

  const sessionId = `sess-${Date.now()}-${randomUUID()}`;
  const title = input.title?.trim().slice(0, 120) || DEFAULT_SESSION_TITLE;
  const prepared = await prepareSessionRuntimeSnapshot({
    context: {
      organizationId: workspace.organizationId,
      userId: input.userId,
      workspaceId: workspace.workspaceId,
      workspaceType: workspace.workspaceType,
      agentId,
      sessionId: null,
      requestedSelection: null,
    },
  });
  const promptSnapshot = await createPiSystemPromptSnapshot(agentId, {
    userId: input.userId,
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
  });
  const inserted = await createPiSessionWithRuntimeSnapshot({
    sessionId,
    userId: input.userId,
    agentId,
    title,
    titleGenerationState: input.title?.trim() ? 'manual' : 'pending',
    workspace: workspaceToPiSessionFields(workspace),
    runtimeSnapshot: prepared.snapshot,
    systemPromptSnapshot: promptSnapshot,
  });
  await ensureSessionChannelLink({
    sessionId,
    userId: input.userId,
    channelId: WEB_CHANNEL_ID,
    channelSessionKey: webChannelSessionKey(input.userId),
    displayName: title,
    isPrimary: true,
  });
  return {
    id: inserted.sessionId,
    title,
    agentId: inserted.agentId,
    createdAt: inserted.createdAt.toISOString(),
    lastMessageAt: null,
    hasUnread: false,
    runtime: { phase: null, activeToolName: null },
  } satisfies MobileChatSession;
}

export async function listMobileChatMessages(input: ChatActor & {
  sessionId: string;
  beforeSequence?: number | null;
  limit?: number;
}) {
  const workspace = await resolveChatWorkspace(input);
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      workspaceSessionCondition(workspace.workspaceId, workspace.workspaceType),
    ),
    columns: { id: true, agentId: true },
  });
  if (!session) throw new MobileChatError('SESSION_NOT_FOUND', 'The chat session was not found.', 404);
  try {
    await requireAgentAccess(input.userId, session.agentId, 'canUse', {
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
    });
  } catch {
    throw new MobileChatError('AGENT_ACCESS_DENIED', 'The chat session is unavailable.', 403);
  }
  const limit = normalizeLimit(input.limit, 50, 100);
  const conditions: SQL[] = [eq(piMessages.piSessionDbId, session.id)];
  if (input.beforeSequence !== null && input.beforeSequence !== undefined) {
    if (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1) {
      throw new MobileChatError('INVALID_CURSOR', 'The message cursor is invalid.', 400);
    }
    conditions.push(lt(piMessages.sequence, input.beforeSequence));
  }
  const rows = await db.select({
    id: piMessages.id,
    sequence: piMessages.sequence,
    timestamp: piMessages.timestamp,
    content: piMessages.content,
  })
    .from(piMessages)
    .where(and(...conditions))
    .orderBy(desc(piMessages.sequence), desc(piMessages.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit).reverse();
  return {
    messages: pageRows.map(serializeMobileChatMessage),
    nextBeforeSequence: rows.length > limit ? pageRows[0]?.sequence || null : null,
  };
}
