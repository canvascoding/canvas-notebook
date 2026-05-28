import { type AgentMessage, type AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';
import { and, asc, desc, eq, like, or } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piMessages, piSessions } from '@/app/lib/db/schema';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';

type SessionSearchArgs = {
  query?: string;
  limit?: number;
  sort?: 'newest' | 'oldest';
  session_id?: string;
  around_message_id?: number;
  window?: number;
  role_filter?: string;
};

type PiMessageRow = typeof piMessages.$inferSelect;
type PiSessionRow = typeof piSessions.$inferSelect;

const DEFAULT_DISCOVERY_LIMIT = 3;
const MAX_DISCOVERY_LIMIT = 10;
const DEFAULT_BROWSE_LIMIT = 10;
const MAX_BROWSE_LIMIT = 20;
const DEFAULT_WINDOW = 5;
const MAX_WINDOW = 20;
const SEARCH_SCAN_LIMIT = 80;

function normalizeAgentId(agentId?: string | null): string {
  try {
    return normalizeManagedAgentId(agentId);
  } catch {
    return DEFAULT_AGENT_ID;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function parseRoleFilter(value?: string): Set<string> {
  const roles = (value || 'user,assistant')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  return new Set(roles.length > 0 ? roles : ['user', 'assistant']);
}

function safeParseMessage(row: PiMessageRow): AgentMessage | null {
  try {
    return JSON.parse(row.content) as AgentMessage;
  } catch {
    return null;
  }
}

function extractMessageText(message: AgentMessage | null): string {
  if (!message) {
    return '';
  }
  if (!('content' in message)) {
    return `[${message.role}]`;
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      if (part && typeof part === 'object' && 'type' in part && part.type === 'image') {
        return '[image]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function shapeMessage(row: PiMessageRow, anchorId?: number) {
  const parsed = safeParseMessage(row);
  return {
    id: row.id,
    role: row.role,
    text: truncate(extractMessageText(parsed), 1200),
    timestamp: row.timestamp,
    ...(row.id === anchorId ? { anchor: true } : {}),
  };
}

function sessionSummary(session: PiSessionRow) {
  return {
    session_id: session.sessionId,
    agent_id: session.agentId,
    title: session.title || null,
    provider: session.provider,
    model: session.model,
    created_at: session.createdAt?.getTime?.() ?? null,
    updated_at: session.updatedAt?.getTime?.() ?? null,
    last_message_at: session.lastMessageAt?.getTime?.() ?? null,
    channel_id: session.channelId,
  };
}

async function getSessionForUser(sessionId: string, userId: string, agentId: string): Promise<PiSessionRow | null> {
  const rows = await db
    .select()
    .from(piSessions)
    .where(and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, userId),
      eq(piSessions.agentId, agentId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function getMessagesForSession(sessionDbId: number, roleFilter?: Set<string>): Promise<PiMessageRow[]> {
  const rows = await db
    .select()
    .from(piMessages)
    .where(eq(piMessages.piSessionDbId, sessionDbId))
    .orderBy(asc(piMessages.timestamp), asc(piMessages.id));

  if (!roleFilter) {
    return rows;
  }
  return rows.filter((row) => roleFilter.has(row.role));
}

async function getWindow(sessionDbId: number, aroundMessageId: number, window: number, roleFilter?: Set<string>) {
  const rows = await getMessagesForSession(sessionDbId, roleFilter);
  const anchorIndex = rows.findIndex((row) => row.id === aroundMessageId);
  if (anchorIndex < 0) {
    return null;
  }
  const start = Math.max(0, anchorIndex - window);
  const end = Math.min(rows.length, anchorIndex + window + 1);
  return {
    messages: rows.slice(start, end).map((row) => shapeMessage(row, aroundMessageId)),
    has_more_before: start > 0,
    has_more_after: end < rows.length,
  };
}

async function browseSessions(userId: string, agentId: string, args: SessionSearchArgs) {
  const limit = clampNumber(args.limit, DEFAULT_BROWSE_LIMIT, 1, MAX_BROWSE_LIMIT);
  const sessions = await db
    .select()
    .from(piSessions)
    .where(and(eq(piSessions.userId, userId), eq(piSessions.agentId, agentId)))
    .orderBy(desc(piSessions.lastMessageAt), desc(piSessions.updatedAt), desc(piSessions.createdAt))
    .limit(limit);

  return {
    mode: 'browse' as const,
    sessions: sessions.map(sessionSummary),
  };
}

async function scrollSession(userId: string, agentId: string, args: SessionSearchArgs) {
  const sessionId = args.session_id?.trim();
  if (!sessionId) {
    throw new Error('session_id is required for scroll mode.');
  }
  if (typeof args.around_message_id !== 'number' || !Number.isFinite(args.around_message_id)) {
    throw new Error('around_message_id is required for scroll mode.');
  }

  const session = await getSessionForUser(sessionId, userId, agentId);
  if (!session) {
    throw new Error('Session not found.');
  }

  const roleFilter = args.role_filter ? parseRoleFilter(args.role_filter) : undefined;
  const window = clampNumber(args.window, DEFAULT_WINDOW, 1, MAX_WINDOW);
  const view = await getWindow(session.id, Math.trunc(args.around_message_id), window, roleFilter);
  if (!view) {
    throw new Error('Message anchor not found in session.');
  }

  return {
    mode: 'scroll' as const,
    session: sessionSummary(session),
    around_message_id: Math.trunc(args.around_message_id),
    window,
    ...view,
  };
}

async function searchSessions(userId: string, agentId: string, args: SessionSearchArgs) {
  const query = args.query?.trim();
  if (!query) {
    return browseSessions(userId, agentId, args);
  }

  const roleFilter = parseRoleFilter(args.role_filter);
  const limit = clampNumber(args.limit, DEFAULT_DISCOVERY_LIMIT, 1, MAX_DISCOVERY_LIMIT);
  const likePattern = `%${escapeLike(query)}%`;
  const roleConditions = [...roleFilter].map((role) => eq(piMessages.role, role));
  const rows = await db
    .select({
      message: piMessages,
      session: piSessions,
    })
    .from(piMessages)
    .innerJoin(piSessions, eq(piMessages.piSessionDbId, piSessions.id))
    .where(and(
      eq(piSessions.userId, userId),
      eq(piSessions.agentId, agentId),
      like(piMessages.content, likePattern),
      roleConditions.length === 1 ? roleConditions[0] : or(...roleConditions),
    ))
    .orderBy(args.sort === 'oldest' ? asc(piMessages.timestamp) : desc(piMessages.timestamp), desc(piMessages.id))
    .limit(SEARCH_SCAN_LIMIT);

  const seenSessions = new Set<string>();
  const results = [];

  for (const row of rows) {
    if (seenSessions.has(row.session.sessionId)) {
      continue;
    }
    seenSessions.add(row.session.sessionId);

    const view = await getWindow(row.session.id, row.message.id, DEFAULT_WINDOW, roleFilter);
    const allMessages = await getMessagesForSession(row.session.id, roleFilter);
    results.push({
      session: sessionSummary(row.session),
      match_message_id: row.message.id,
      snippet: truncate(extractMessageText(safeParseMessage(row.message)), 500),
      messages: view?.messages ?? [shapeMessage(row.message, row.message.id)],
      bookend_start: allMessages.slice(0, 3).map((message) => shapeMessage(message)),
      bookend_end: allMessages.slice(-3).map((message) => shapeMessage(message)),
    });

    if (results.length >= limit) {
      break;
    }
  }

  return {
    mode: 'discovery' as const,
    query,
    results,
  };
}

type SessionSearchResult =
  | Awaited<ReturnType<typeof browseSessions>>
  | Awaited<ReturnType<typeof scrollSession>>
  | Awaited<ReturnType<typeof searchSessions>>;

function formatSessionSearchResult(result: SessionSearchResult): string {
  if (result.mode === 'browse') {
    if (result.sessions.length === 0) {
      return 'No sessions found.';
    }
    return [
      'Recent sessions:',
      ...result.sessions.map((session, index) => `${index + 1}. ${session.title || '(untitled)'} - ${session.session_id} - ${session.agent_id}`),
    ].join('\n');
  }

  if (result.mode === 'scroll') {
    return [
      `Session window: ${result.session.title || result.session.session_id}`,
      ...result.messages.map((message) => `${message.anchor ? '>' : '-'} [${message.id}] ${message.role}: ${message.text}`),
    ].join('\n');
  }

  if (result.results.length === 0) {
    return `No sessions matched "${result.query}".`;
  }
  return [
    `Session search results for "${result.query}":`,
    ...result.results.map((entry, index) => `${index + 1}. ${entry.session.title || '(untitled)'} - ${entry.session.session_id} - match ${entry.match_message_id}: ${entry.snippet}`),
  ].join('\n');
}

export function createSessionSearchTool(deps: { userId?: string; agentId?: string | null } = {}): AgentTool {
  return {
    name: 'session_search',
    label: 'Searching session history',
    description:
      'Browse, search, and read previous Canvas Agent conversations for this user and agent. ' +
      'Call with no arguments to browse recent sessions. Call with query to discover matching sessions. ' +
      'Call with session_id and around_message_id to scroll a concrete message window. This tool is read-only.',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Discovery mode. Search text to find relevant previous sessions.' })),
      limit: Type.Optional(Type.Number({ description: 'Max sessions to return. Discovery max 10, browse max 20.' })),
      sort: Type.Optional(Type.Union([Type.Literal('newest'), Type.Literal('oldest')], { description: 'Discovery ordering. Default newest.' })),
      session_id: Type.Optional(Type.String({ description: 'Scroll mode. Session ID returned by browse or discovery.' })),
      around_message_id: Type.Optional(Type.Number({ description: 'Scroll mode. Message ID to center the returned window around.' })),
      window: Type.Optional(Type.Number({ description: 'Scroll mode. Messages on each side of anchor. Default 5, max 20.' })),
      role_filter: Type.Optional(Type.String({ description: 'Comma-separated roles. Defaults to user,assistant. Use user,assistant,tool to include tool output.' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (!deps.userId) {
          throw new Error('User ID is required for session_search.');
        }
        const args = (params || {}) as SessionSearchArgs;
        const agentId = normalizeAgentId(deps.agentId);
        const result = args.session_id || args.around_message_id !== undefined
          ? await scrollSession(deps.userId, agentId, args)
          : await searchSessions(deps.userId, agentId, args);

        return {
          content: [{ type: 'text', text: formatSessionSearchResult(result) }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown session_search error';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
