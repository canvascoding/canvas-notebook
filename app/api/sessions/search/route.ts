import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { auth } from '@/app/lib/auth';
import { listAgentAccessForUser, requireAgentAccess } from '@/app/lib/agents/access';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { db } from '@/app/lib/db';
import { legacyAiTablesExist } from '@/app/lib/db/legacy-ai-tables';
import { aiMessages, aiSessions, piMessages, piSessions } from '@/app/lib/db/schema';
import {
  createSessionSearchSnippet,
  escapeSessionSearchLikeValue,
  extractPersistedMessageText,
  getSessionTitleSearchRank,
} from '@/app/lib/chat/session-search-text';
import type { AISession, ChatHistorySearchResult } from '@/app/lib/chat/types';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import {
  resolveAgentSessionWorkspaceForUser,
  storedPiSessionWorkspaceToSummary,
} from '@/app/lib/pi/session-workspace-context';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 30;
const TITLE_SCAN_LIMIT = 100;
const MESSAGE_SCAN_LIMIT = 240;

const piSessionSelection = {
  id: piSessions.id,
  sessionId: piSessions.sessionId,
  title: piSessions.title,
  titleGenerationState: piSessions.titleGenerationState,
  agentId: piSessions.agentId,
  model: piSessions.model,
  provider: piSessions.provider,
  thinkingLevel: piSessions.thinkingLevel,
  createdAt: piSessions.createdAt,
  lastMessageAt: piSessions.lastMessageAt,
  lastViewedAt: piSessions.lastViewedAt,
  organizationId: piSessions.organizationId,
  workspaceId: piSessions.workspaceId,
  workspaceType: piSessions.workspaceType,
  workspaceName: piSessions.workspaceName,
  workspaceRootRelativePath: piSessions.workspaceRootRelativePath,
};

const legacySessionSelection = {
  id: aiSessions.id,
  sessionId: aiSessions.sessionId,
  title: aiSessions.title,
  model: aiSessions.model,
  createdAt: aiSessions.createdAt,
};

type PiSessionRecord = typeof piSessions.$inferSelect;
type PiSessionSearchRow = Pick<
  PiSessionRecord,
  | 'id'
  | 'sessionId'
  | 'title'
  | 'titleGenerationState'
  | 'agentId'
  | 'model'
  | 'provider'
  | 'thinkingLevel'
  | 'createdAt'
  | 'lastMessageAt'
  | 'lastViewedAt'
  | 'organizationId'
  | 'workspaceId'
  | 'workspaceType'
  | 'workspaceName'
  | 'workspaceRootRelativePath'
>;

type LegacySessionRecord = typeof aiSessions.$inferSelect;
type LegacySessionSearchRow = Pick<LegacySessionRecord, 'id' | 'sessionId' | 'title' | 'model' | 'createdAt'>;

type SearchCandidate = ChatHistorySearchResult & {
  activityAt: number;
  titleRank: number;
};

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_RESULTS;
  if (!Number.isFinite(parsed)) return DEFAULT_RESULTS;
  return Math.max(1, Math.min(parsed, MAX_RESULTS));
}

function buildWorkspaceCondition(
  workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>> | null,
): SQL | null {
  if (!workspace) return null;
  if (workspace.workspaceType === 'personal') {
    return or(eq(piSessions.workspaceId, workspace.workspaceId), isNull(piSessions.workspaceId))!;
  }
  return eq(piSessions.workspaceId, workspace.workspaceId);
}

function mapPiSession(row: PiSessionSearchRow): AISession {
  return {
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    titleGenerationState: row.titleGenerationState as AISession['titleGenerationState'],
    agentId: row.agentId,
    model: row.model,
    provider: row.provider,
    thinkingLevel: row.thinkingLevel as AISession['thinkingLevel'],
    createdAt: row.createdAt.toISOString(),
    engine: 'pi',
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
    hasUnread: hasUnreadAssistantResponse(row.lastMessageAt, row.lastViewedAt),
    workspace: storedPiSessionWorkspaceToSummary({
      workspaceId: row.workspaceId,
      workspaceType: row.workspaceType,
      workspaceName: row.workspaceName,
      workspaceRootRelativePath: row.workspaceRootRelativePath,
      organizationId: row.organizationId,
    }),
  };
}

function mapLegacySession(row: LegacySessionSearchRow): AISession {
  return {
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    agentId: DEFAULT_AGENT_ID,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    engine: 'legacy',
    lastMessageAt: null,
    lastViewedAt: null,
    hasUnread: false,
    workspace: null,
  };
}

function activityTime(session: AISession): number {
  return new Date(session.lastMessageAt || session.createdAt).getTime();
}

function titleCandidate(session: AISession, query: string): SearchCandidate {
  return {
    session,
    match: { kind: 'title' },
    activityAt: activityTime(session),
    titleRank: getSessionTitleSearchRank(session.title, query),
  };
}

function contentCandidate(
  session: AISession,
  query: string,
  message: { id: number; role: string; content: string; timestamp: number | Date },
): SearchCandidate | null {
  const text = extractPersistedMessageText(message.content);
  if (!text.toLocaleLowerCase('en-US').includes(query.toLocaleLowerCase('en-US'))) {
    return null;
  }
  return {
    session,
    match: {
      kind: 'content',
      messageId: message.id,
      role: message.role,
      snippet: createSessionSearchSnippet(text, query),
    },
    activityAt: message.timestamp instanceof Date ? message.timestamp.getTime() : message.timestamp,
    titleRank: 3,
  };
}

export async function GET(request: NextRequest) {
  const authSession = await auth.api.getSession({ headers: request.headers });
  if (!authSession) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'sessions-search-get',
  });
  if (!limited.ok) return limited.response;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query')?.replace(/\s+/g, ' ').trim().slice(0, 120) || '';
  if (query.length < 2) {
    return NextResponse.json({ success: true, results: [] });
  }

  const workspaceId = normalizeOptionalString(searchParams.get('workspaceId'));
  const rawAgentId = searchParams.get('agentId') || 'all';
  const includeAllAgents = rawAgentId === 'all';
  const unreadOnly = searchParams.get('unreadOnly') === 'true';
  const limit = parseLimit(searchParams.get('limit'));

  let requestedAgentId: string | null = null;
  if (!includeAllAgents) {
    try {
      requestedAgentId = normalizeManagedAgentId(rawAgentId);
      await requireAgentAccess(authSession.user.id, requestedAgentId, 'canUse');
    } catch {
      return NextResponse.json(
        { success: false, code: 'AGENT_ACCESS_DENIED', error: 'Agent access denied.' },
        { status: 403 },
      );
    }
  }

  try {
    const accessibleAgentIds = includeAllAgents
      ? [...(await listAgentAccessForUser(authSession.user.id)).entries()]
          .filter(([, access]) => access.canUse)
          .map(([agentId]) => agentId)
      : [requestedAgentId!];
    if (accessibleAgentIds.length === 0) {
      return NextResponse.json({ success: true, results: [] });
    }

    let workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>> | null = null;
    if (workspaceId) {
      try {
        workspace = await resolveAgentSessionWorkspaceForUser({
          userId: authSession.user.id,
          workspaceId,
          permissions: ['canRead', 'canRunAgent'],
        });
      } catch {
        return NextResponse.json(
          { success: false, error: 'Workspace not found or inaccessible' },
          { status: 403 },
        );
      }
    }

    const workspaceCondition = buildWorkspaceCondition(workspace);
    const piConditions: SQL[] = [
      eq(piSessions.userId, authSession.user.id),
      eq(piSessions.sessionKind, 'conversation'),
      inArray(piSessions.agentId, accessibleAgentIds),
    ];
    if (workspaceCondition) piConditions.push(workspaceCondition);

    const pattern = `%${escapeSessionSearchLikeValue(query.toLocaleLowerCase('en-US'))}%`;
    const titleCondition = sql`lower(coalesce(${piSessions.title}, '')) LIKE ${pattern} ESCAPE '\\'`;
    const messageCondition = sql`lower(${piMessages.content}) LIKE ${pattern} ESCAPE '\\'`;
    const includeLegacy = await legacyAiTablesExist()
      && (includeAllAgents || requestedAgentId === DEFAULT_AGENT_ID)
      && (!workspace || workspace.workspaceType === 'personal');

    const [piTitleRows, piMessageRows, legacyTitleRows, legacyMessageRows] = await Promise.all([
      db
        .select(piSessionSelection)
        .from(piSessions)
        .where(and(...piConditions, titleCondition))
        .orderBy(desc(sql`coalesce(${piSessions.lastMessageAt}, ${piSessions.createdAt})`), desc(piSessions.id))
        .limit(TITLE_SCAN_LIMIT),
      db
        .select({
          ...piSessionSelection,
          messageId: piMessages.id,
          messageRole: piMessages.role,
          messageContent: piMessages.content,
          messageTimestamp: piMessages.timestamp,
        })
        .from(piMessages)
        .innerJoin(piSessions, eq(piMessages.piSessionDbId, piSessions.id))
        .where(and(
          ...piConditions,
          inArray(piMessages.role, ['user', 'assistant']),
          messageCondition,
        ))
        .orderBy(desc(piMessages.timestamp), desc(piMessages.id))
        .limit(MESSAGE_SCAN_LIMIT),
      includeLegacy
        ? db
            .select(legacySessionSelection)
            .from(aiSessions)
            .where(and(
              eq(aiSessions.userId, authSession.user.id),
              sql`lower(coalesce(${aiSessions.title}, '')) LIKE ${pattern} ESCAPE '\\'`,
            ))
            .orderBy(desc(aiSessions.createdAt), desc(aiSessions.id))
            .limit(TITLE_SCAN_LIMIT)
        : Promise.resolve([]),
      includeLegacy
        ? db
            .select({
              ...legacySessionSelection,
              messageId: aiMessages.id,
              messageRole: aiMessages.role,
              messageContent: aiMessages.content,
              messageTimestamp: aiMessages.createdAt,
            })
            .from(aiMessages)
            .innerJoin(aiSessions, eq(aiMessages.aiSessionDbId, aiSessions.id))
            .where(and(
              eq(aiSessions.userId, authSession.user.id),
              inArray(aiMessages.role, ['user', 'assistant']),
              sql`lower(${aiMessages.content}) LIKE ${pattern} ESCAPE '\\'`,
            ))
            .orderBy(desc(aiMessages.createdAt), desc(aiMessages.id))
            .limit(MESSAGE_SCAN_LIMIT)
        : Promise.resolve([]),
    ]);

    const candidates: SearchCandidate[] = [
      ...piTitleRows.map((row) => titleCandidate(mapPiSession(row), query)),
      ...legacyTitleRows.map((row) => titleCandidate(mapLegacySession(row), query)),
    ];

    for (const row of piMessageRows) {
      const candidate = contentCandidate(mapPiSession(row), query, {
        id: row.messageId,
        role: row.messageRole,
        content: row.messageContent,
        timestamp: row.messageTimestamp,
      });
      if (candidate) candidates.push(candidate);
    }
    for (const row of legacyMessageRows) {
      const candidate = contentCandidate(mapLegacySession(row), query, {
        id: row.messageId,
        role: row.messageRole,
        content: row.messageContent,
        timestamp: row.messageTimestamp,
      });
      if (candidate) candidates.push(candidate);
    }

    candidates.sort((a, b) => {
      if (a.match.kind !== b.match.kind) return a.match.kind === 'title' ? -1 : 1;
      if (a.titleRank !== b.titleRank) return a.titleRank - b.titleRank;
      return b.activityAt - a.activityAt;
    });

    const seen = new Set<string>();
    const results: ChatHistorySearchResult[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.session.sessionId)) continue;
      if (unreadOnly && !candidate.session.hasUnread) continue;
      seen.add(candidate.session.sessionId);
      results.push({ session: candidate.session, match: candidate.match });
      if (results.length >= limit) break;
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('[API Sessions Search] Failed to search sessions', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
