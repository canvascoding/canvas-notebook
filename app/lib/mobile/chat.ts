import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { listManagedAgents } from '@/app/lib/agents/management-actions';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { resolveEffectiveAgentRuntime } from '@/app/lib/agent-runtime-policy/runtime-resolver';
import {
  prepareSessionRuntimeSnapshot,
  replaceSessionRuntimeSnapshot,
  type AiSessionRuntimeUpdate,
} from '@/app/lib/agent-runtime-policy/session-runtime-service';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';
import { ensureDefaultAgent } from '@/app/lib/channels/agents';
import { ensureSessionChannelLink } from '@/app/lib/channels/channel-links';
import { piSessionReadCursorSql } from '@/app/lib/chat/read-cursor';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import { db } from '@/app/lib/db';
import { piMessages, piSessions, sessionChannelLinks } from '@/app/lib/db/schema';
import {
  contentToString,
  extractMessageAttachments,
  extractPiMessageText,
  extractToolResultImageAttachments,
  isToolCallPart,
  stripAttachmentBlocks,
} from '@/app/lib/chat/message-content';
import { mobileToolCallId } from '@/app/lib/mobile/tool-call-id';
import { formatMobileToolInput } from '@/app/lib/mobile/tool-input';
import { projectMobileCompactBreakMetadata, type MobileCompactBreakMetadata } from '@/app/lib/mobile/compact-break';
import {
  getActiveRuntimeStatusSummaries,
  getStatus,
  invalidateRuntime,
  withRuntimeSessionOperation,
} from '@/app/lib/pi/runtime-service';
import { parsePersistedPiMessage } from '@/app/lib/pi/message-projection';
import { createPiSessionWithRuntimeSnapshot, PiSessionClientRequestConflictError } from '@/app/lib/pi/session-store';
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
  kind: 'message' | 'tool' | 'error' | 'compact_break';
  text: string;
  compactMeta?: MobileCompactBreakMetadata;
  clientMessageId?: string;
  toolCallId: string | null;
  toolName: string | null;
  toolInput: string | null;
  attachments: MobileChatAttachment[];
  createdAt: string;
};

export type MobileChatAttachment = {
  id: string;
  name: string;
  contentKind: 'image' | 'document';
  mimeType: string | null;
  size: number | null;
  previewUrl: string | null;
  mediaUrl: string | null;
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

function serializeMessageAttachment(input: NonNullable<ReturnType<typeof extractMessageAttachments>>[number]): MobileChatAttachment {
  const safeRelativeUrl = (value: string | undefined): string | null => (
    value?.startsWith('/') && !value.startsWith('//') ? value : null
  );
  return {
    id: input.id.slice(0, 500),
    name: input.name.slice(0, 240),
    contentKind: input.contentKind,
    mimeType: input.mimeType?.slice(0, 160) || null,
    size: typeof input.size === 'number' && Number.isSafeInteger(input.size) && input.size >= 0 ? input.size : null,
    previewUrl: safeRelativeUrl(input.previewUrl),
    mediaUrl: safeRelativeUrl(input.mediaUrl),
  };
}

function messageToolName(message: Record<string, unknown>): string | null {
  if (typeof message.toolName === 'string' && message.toolName.trim()) return message.toolName.trim().slice(0, 160);
  if (!Array.isArray(message.content)) return null;
  const names = message.content.flatMap((part) => isToolCallPart(part) ? [part.name.trim()] : []).filter(Boolean);
  return names.length > 0 ? Array.from(new Set(names)).join(', ').slice(0, 160) : null;
}

type MobileChatMessageRow = {
  id: number;
  sequence: number;
  timestamp: number;
  content: string;
};

function parsedMobileMessage(row: MobileChatMessageRow): Record<string, unknown> {
  return parsePersistedPiMessage(row.content, 'display') as unknown as Record<string, unknown>;
}

function mobileToolInputsById(rows: MobileChatMessageRow[]): Map<string, string> {
  const inputs = new Map<string, string>();
  for (const row of rows) {
    const message = parsedMobileMessage(row);
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isToolCallPart(part)) continue;
      const formatted = formatMobileToolInput(part.arguments);
      if (formatted) inputs.set(part.id, formatted);
    }
  }
  return inputs;
}

function missingToolInputIds(rows: MobileChatMessageRow[], knownInputs: Map<string, string>): string[] {
  const missing = new Set<string>();
  for (const row of rows) {
    const message = parsedMobileMessage(row);
    if (message.role !== 'toolResult') continue;
    const toolCallId = mobileToolCallId(message);
    if (toolCallId && !knownInputs.has(toolCallId)) missing.add(toolCallId);
  }
  return Array.from(missing);
}

export function serializeMobileChatMessage(input: {
  id: number;
  sequence: number;
  timestamp: number;
  content: string;
}, toolInputsById: ReadonlyMap<string, string> = new Map()): MobileChatMessage {
  const piMessage = parsePersistedPiMessage(input.content, 'display');
  const parsed = piMessage as unknown as Record<string, unknown>;
  const rawRole = typeof parsed.role === 'string' ? parsed.role : 'system';
  if (rawRole === 'compact-break') {
    const compactMeta = projectMobileCompactBreakMetadata(parsed, input);
    return {
      id: String(input.id),
      sequence: input.sequence,
      role: 'system',
      kind: 'compact_break',
      text: '',
      compactMeta,
      toolCallId: null,
      toolName: null,
      toolInput: null,
      attachments: [],
      createdAt: compactMeta.timestamp,
    };
  }
  const role: MobileChatMessage['role'] = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system'
    ? rawRole
    : 'tool';
  const isError = parsed.isError === true || parsed.error === true;
  const metadataAttachments = extractMessageAttachments(parsed.content) || [];
  const attachments = [
    ...metadataAttachments,
    ...extractToolResultImageAttachments(piMessage),
  ].filter((attachment, index, all) => all.findIndex((candidate) => (
    candidate.id === attachment.id && candidate.contentKind === attachment.contentKind
  )) === index);
  const visibleText = extractPiMessageText(piMessage, { hideAttachmentMetadata: true })
    || stripAttachmentBlocks(contentToString(parsed.content));
  const toolCallId = mobileToolCallId(parsed);
  const clientMessageId = typeof parsed.clientMessageId === 'string'
    && parsed.clientMessageId.trim().length <= 256
    ? parsed.clientMessageId.trim()
    : undefined;
  return {
    id: String(input.id),
    sequence: input.sequence,
    role,
    kind: isError ? 'error' : role === 'tool' ? 'tool' : 'message',
    text: visibleText,
    ...(clientMessageId ? { clientMessageId } : {}),
    toolCallId,
    toolName: messageToolName(parsed),
    toolInput: toolCallId ? toolInputsById.get(toolCallId) || null : null,
    attachments: attachments.map(serializeMessageAttachment),
    createdAt: new Date(input.timestamp).toISOString(),
  };
}

export async function listMobileChat(input: ChatActor & {
  cursor?: string | null;
  query?: string | null;
  archived?: boolean;
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
  const activity = sql<number>`coalesce(${piSessions.lastMessageAt}, ${piSessions.createdAt})`;
  const conditions: SQL[] = [
    eq(piSessions.userId, input.userId),
    eq(piSessions.sessionKind, 'conversation'),
    workspaceSessionCondition(workspace.workspaceId, workspace.workspaceType),
    inArray(piSessions.agentId, agentIds),
    input.archived ? isNotNull(piSessions.archivedAt) : isNull(piSessions.archivedAt),
  ];
  const query = input.query?.replace(/\s+/gu, ' ').trim().slice(0, 120) || '';
  if (query) {
    const pattern = `%${query.toLocaleLowerCase('en-US').replace(/[\\%_]/gu, '\\$&')}%`;
    conditions.push(sql`lower(coalesce(${piSessions.title}, '')) LIKE ${pattern} ESCAPE '\\'`);
  }
  if (cursor) {
    // `piSessions` stores `timestamp` columns as Unix seconds. Keep the cursor
    // comparison in that unit; milliseconds would select the first page again.
    const activityAt = Math.floor(new Date(cursor.activityAt).getTime() / 1_000);
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

export async function requireMobileChatSession(input: ChatActor & { sessionId: string }) {
  const workspace = await resolveChatWorkspace(input);
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      eq(piSessions.sessionKind, 'conversation'),
      workspaceSessionCondition(workspace.workspaceId, workspace.workspaceType),
    ),
    columns: {
      id: true,
      sessionId: true,
      title: true,
      agentId: true,
      createdAt: true,
      updatedAt: true,
      lastMessageAt: true,
      lastViewedAt: true,
      archivedAt: true,
    },
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
  return { session, workspace };
}

export async function getMobileChatSession(input: ChatActor & { sessionId: string }): Promise<MobileChatSession> {
  const { session } = await requireMobileChatSession(input);
  const runtime = await getActiveRuntimeStatusSummaries({
    userId: input.userId,
    sessionIds: [session.sessionId],
  });
  return {
    id: session.sessionId,
    title: session.title?.trim() || DEFAULT_SESSION_TITLE,
    agentId: session.agentId,
    createdAt: session.createdAt.toISOString(),
    lastMessageAt: session.lastMessageAt?.toISOString() || null,
    hasUnread: hasUnreadAssistantResponse(session.lastMessageAt, session.lastViewedAt),
    runtime: {
      phase: runtime[session.sessionId]?.phase || null,
      activeToolName: runtime[session.sessionId]?.activeToolName || null,
    },
  };
}

function mobileRuntimeContext(input: {
  userId: string;
  session: { sessionId: string; agentId: string };
  workspace: Awaited<ReturnType<typeof resolveChatWorkspace>>;
}) {
  if (!input.workspace.organizationId) {
    throw new MobileChatError('ORGANIZATION_SETUP_REQUIRED', 'Complete the Canvas setup first.', 409);
  }
  return {
    organizationId: input.workspace.organizationId,
    userId: input.userId,
    workspaceId: input.workspace.workspaceId,
    workspaceType: input.workspace.workspaceType,
    agentId: input.session.agentId,
    sessionId: input.session.sessionId,
    requestedSelection: null,
  };
}

export async function getMobileChatRuntimeResolution(input: ChatActor & { sessionId: string }) {
  const { session, workspace } = await requireMobileChatSession(input);
  return resolveEffectiveAgentRuntime(mobileRuntimeContext({
    userId: input.userId,
    session,
    workspace,
  }));
}

export async function updateMobileChatRuntimeSelection(input: ChatActor & {
  sessionId: string;
  update: AiSessionRuntimeUpdate;
}) {
  const { session, workspace } = await requireMobileChatSession(input);
  const context = mobileRuntimeContext({
    userId: input.userId,
    session,
    workspace,
  });
  const result = await withRuntimeSessionOperation(session.sessionId, input.userId, async () => {
    const activeRuntime = await getActiveRuntimeStatusSummaries({
      userId: input.userId,
      sessionIds: [session.sessionId],
    });
    if (activeRuntime[session.sessionId]) {
      throw new MobileChatError(
        'SESSION_ACTIVE',
        'The model can only be changed while the agent is idle.',
        409,
      );
    }
    const updated = await replaceSessionRuntimeSnapshot({ context, update: input.update });
    await invalidateRuntime(session.sessionId, input.userId);
    return updated;
  });

  await recordAuditEvent({
    organizationId: context.organizationId,
    workspaceId: workspace.workspaceId,
    userId: input.userId,
    agentId: session.agentId,
    sessionId: session.sessionId,
    source: 'agent-runtime',
    eventType: 'user',
    entityType: 'pi_session',
    entityId: session.sessionId,
    action: 'pi_session_runtime.override',
    status: 'success',
    summary: 'AI runtime selection changed from the mobile chat composer.',
    metadata: {
      catalogRevision: result.snapshot.catalogRevision,
      policyRevision: result.snapshot.policyRevision,
      selectionSource: result.snapshot.selectionSource,
      selection: result.snapshot.selection,
    },
  });

  return result.resolution;
}

export async function updateMobileChatSession(input: ChatActor & {
  sessionId: string;
  title?: string;
  markAsRead?: boolean;
  markAsUnread?: boolean;
  archived?: boolean;
}) {
  const { session } = await requireMobileChatSession(input);
  if (
    input.title === undefined
    && input.markAsRead === undefined
    && input.markAsUnread === undefined
    && input.archived === undefined
  ) {
    throw new MobileChatError('INVALID_SESSION_UPDATE', 'A session update is required.', 400);
  }
  const title = input.title === undefined ? undefined : input.title.replace(/\s+/gu, ' ').trim();
  if (title !== undefined && !title) {
    throw new MobileChatError('INVALID_SESSION_TITLE', 'The session title cannot be empty.', 400);
  }
  if (input.archived === true) {
    const status = await getStatus(session.sessionId, input.userId);
    if (status && status.phase !== 'idle') {
      throw new MobileChatError('SESSION_ACTIVE', 'Stop the active agent before archiving this conversation.', 409);
    }
  }
  if (input.markAsUnread === true && !session.lastMessageAt) {
    throw new MobileChatError('SESSION_HAS_NO_MESSAGES', 'Only conversations with messages can be marked as unread.', 409);
  }
  const now = new Date();
  const [updatedSession] = await db.update(piSessions).set({
    ...(title === undefined ? {} : { title: title.slice(0, 120), titleGenerationState: 'manual' }),
    ...(input.markAsRead === true ? { lastViewedAt: piSessionReadCursorSql() } : {}),
    ...(input.markAsUnread === true ? { lastViewedAt: null } : {}),
    ...(input.archived === undefined ? {} : { archivedAt: input.archived ? now : null }),
    updatedAt: now,
  }).where(eq(piSessions.id, session.id)).returning({
    title: piSessions.title,
    lastMessageAt: piSessions.lastMessageAt,
    lastViewedAt: piSessions.lastViewedAt,
    archivedAt: piSessions.archivedAt,
  });
  if (!updatedSession) {
    throw new MobileChatError('SESSION_NOT_FOUND', 'The chat session was not found.', 404);
  }
  if (title !== undefined) {
    await db.update(sessionChannelLinks)
      .set({ displayName: title.slice(0, 120), updatedAt: now })
      .where(and(
        eq(sessionChannelLinks.sessionId, session.sessionId),
        eq(sessionChannelLinks.userId, input.userId),
      ));
  }
  return {
    id: session.sessionId,
    title: updatedSession.title?.trim() || DEFAULT_SESSION_TITLE,
    agentId: session.agentId,
    createdAt: session.createdAt.toISOString(),
    lastMessageAt: updatedSession.lastMessageAt?.toISOString() || null,
    lastViewedAt: updatedSession.lastViewedAt?.toISOString() || null,
    hasUnread: hasUnreadAssistantResponse(updatedSession.lastMessageAt, updatedSession.lastViewedAt),
    archived: Boolean(updatedSession.archivedAt),
  };
}

export async function createMobileChatSession(input: ChatActor & {
  agentId?: string;
  title?: string;
  clientRequestId?: string;
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
  let inserted: Awaited<ReturnType<typeof createPiSessionWithRuntimeSnapshot>>;
  try {
    inserted = await createPiSessionWithRuntimeSnapshot({
      sessionId,
      clientRequestId: input.clientRequestId,
      userId: input.userId,
      agentId,
      title,
      titleGenerationState: input.title?.trim() ? 'manual' : 'pending',
      workspace: workspaceToPiSessionFields(workspace),
      runtimeSnapshot: prepared.snapshot,
      systemPromptSnapshot: promptSnapshot,
    });
  } catch (error) {
    if (error instanceof PiSessionClientRequestConflictError) {
      throw new MobileChatError('CLIENT_REQUEST_CONFLICT', 'This conversation request conflicts with an earlier request.', 409);
    }
    throw error;
  }
  await ensureSessionChannelLink({
    sessionId: inserted.sessionId,
    userId: input.userId,
    channelId: WEB_CHANNEL_ID,
    channelSessionKey: webChannelSessionKey(input.userId),
    displayName: inserted.title?.trim() || DEFAULT_SESSION_TITLE,
    isPrimary: true,
  });
  return {
    id: inserted.sessionId,
    title: inserted.title?.trim() || DEFAULT_SESSION_TITLE,
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
  const { session } = await requireMobileChatSession(input);
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
  let toolInputsById = mobileToolInputsById(pageRows);
  const missingInputIds = missingToolInputIds(pageRows, toolInputsById);
  if (missingInputIds.length > 0 && pageRows[0]) {
    const contextRows = await db.select({
      id: piMessages.id,
      sequence: piMessages.sequence,
      timestamp: piMessages.timestamp,
      content: piMessages.content,
    })
      .from(piMessages)
      .where(and(
        eq(piMessages.piSessionDbId, session.id),
        lt(piMessages.sequence, pageRows[0].sequence),
      ))
      .orderBy(desc(piMessages.sequence), desc(piMessages.id))
      .limit(100);
    toolInputsById = mobileToolInputsById([...contextRows, ...pageRows]);
  }
  return {
    messages: pageRows.map((row) => serializeMobileChatMessage(row, toolInputsById)),
    nextBeforeSequence: rows.length > limit ? pageRows[0]?.sequence || null : null,
  };
}
