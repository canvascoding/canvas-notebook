import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { legacyAiTablesExist } from '@/app/lib/db/legacy-ai-tables';
import { aiSessions, aiMessages, piSessions, piMessages } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { and, asc, desc, eq, lt, gt, or } from 'drizzle-orm';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { parsePersistedPiMessage, type PiMessageProjectionMode } from '@/app/lib/pi/message-projection';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

const DEFAULT_LIMIT = 50;

function parseCursorParam(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function normalizeSessionAgentId(value: string | null): string {
  try {
    return normalizeManagedAgentId(value);
  } catch {
    return '';
  }
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const agentId = normalizeSessionAgentId(searchParams.get('agentId'));
  const workspaceIdFilter = normalizeOptionalString(searchParams.get('workspaceId'));

  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
  }

  if (!agentId) {
    return NextResponse.json({ success: false, error: 'Invalid agentId' }, { status: 400 });
  }

  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 200) : DEFAULT_LIMIT;
  const beforeParam = searchParams.get('before');
  const afterParam = searchParams.get('after');
  const beforeIdParam = searchParams.get('beforeId');
  const afterIdParam = searchParams.get('afterId');
  const beforeSequenceParam = searchParams.get('beforeSequence');
  const afterSequenceParam = searchParams.get('afterSequence');
  const projectionMode: PiMessageProjectionMode = searchParams.get('raw') === 'true' ? 'raw' : 'display';
  const before = parseCursorParam(beforeParam);
  const after = parseCursorParam(afterParam);
  const beforeId = parseCursorParam(beforeIdParam);
  const afterId = parseCursorParam(afterIdParam);
  const beforeSequence = parseCursorParam(beforeSequenceParam);
  const afterSequence = parseCursorParam(afterSequenceParam);

  if (
    (beforeParam !== null && Number.isNaN(before)) ||
    (afterParam !== null && Number.isNaN(after)) ||
    (beforeIdParam !== null && Number.isNaN(beforeId)) ||
    (afterIdParam !== null && Number.isNaN(afterId)) ||
    (beforeSequenceParam !== null && Number.isNaN(beforeSequence)) ||
    (afterSequenceParam !== null && Number.isNaN(afterSequence))
  ) {
    return NextResponse.json({ success: false, error: 'Invalid pagination cursor' }, { status: 400 });
  }

  try {
    let scopedWorkspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>> | null = null;
    if (workspaceIdFilter) {
      try {
        scopedWorkspace = await resolveAgentSessionWorkspaceForUser({
          userId: session.user.id,
          workspaceId: workspaceIdFilter,
          permissions: ['canRead', 'canRunAgent'],
        });
      } catch {
        return NextResponse.json({ success: false, error: 'Workspace not found or inaccessible' }, { status: 403 });
      }
    }

    // Try PI session first (ownership enforced)
    const dbPiSessions = await db
      .select()
      .from(piSessions)
      .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id), eq(piSessions.agentId, agentId)))
      .limit(1);

    if (dbPiSessions.length > 0) {
      const piSession = dbPiSessions[0];
      if (scopedWorkspace) {
        const sessionWorkspaceId = piSession.workspaceId;
        const isLegacyPersonalSession = !sessionWorkspaceId && scopedWorkspace.workspaceType === 'personal';
        const isMatchingWorkspaceSession = sessionWorkspaceId === scopedWorkspace.workspaceId;
        if (!isLegacyPersonalSession && !isMatchingWorkspaceSession) {
          return NextResponse.json({ success: false, error: 'Session is outside the active workspace' }, { status: 403 });
        }
      }

      const conditions = [eq(piMessages.piSessionDbId, dbPiSessions[0].id)];
      if (beforeSequence !== null) {
        conditions.push(
          beforeId !== null
            ? or(
                lt(piMessages.sequence, beforeSequence),
                and(eq(piMessages.sequence, beforeSequence), lt(piMessages.id, beforeId)),
              )!
            : lt(piMessages.sequence, beforeSequence),
        );
      } else if (before !== null) {
        conditions.push(
          beforeId !== null
            ? or(
                lt(piMessages.timestamp, before),
                and(eq(piMessages.timestamp, before), lt(piMessages.id, beforeId)),
              )!
            : lt(piMessages.timestamp, before),
        );
      }
      if (afterSequence !== null) {
        conditions.push(
          afterId !== null
            ? or(
                gt(piMessages.sequence, afterSequence),
                and(eq(piMessages.sequence, afterSequence), gt(piMessages.id, afterId)),
              )!
            : gt(piMessages.sequence, afterSequence),
        );
      } else if (after !== null) {
        conditions.push(
          afterId !== null
            ? or(
                gt(piMessages.timestamp, after),
                and(eq(piMessages.timestamp, after), gt(piMessages.id, afterId)),
              )!
            : gt(piMessages.timestamp, after),
        );
      }

      const isBackwardPage = beforeSequence !== null || before !== null || (before === null && after === null && afterSequence === null);

      // Fetch limit+1 to detect if there are more pages
      const rows = await db
        .select()
        .from(piMessages)
        .where(and(...conditions))
        .orderBy(
          isBackwardPage ? desc(piMessages.sequence) : asc(piMessages.sequence),
          isBackwardPage ? desc(piMessages.id) : asc(piMessages.id),
        )
        .limit(limit + 1);

      let hasMore = false;
      let resultRows = rows;
      if (rows.length > limit) {
        hasMore = true;
        resultRows = rows.slice(0, limit);
      }

      // Response order stays chronological even when fetched backwards for initial or older pages.
      if (isBackwardPage) {
        resultRows = [...resultRows].sort((a, b) => {
          if (a.sequence !== b.sequence) {
            return a.sequence - b.sequence;
          }
          return a.id - b.id;
        });
      }

      const mapped = resultRows.map(m => ({
        ...parsePersistedPiMessage(m.content, projectionMode),
        id: m.id,
        sequence: m.sequence,
        createdAt: new Date(m.timestamp),
      }));

      const oldestTimestamp = resultRows.length > 0 ? resultRows[0].timestamp : null;
      const newestTimestamp = resultRows.length > 0 ? resultRows[resultRows.length - 1].timestamp : null;
      const oldestMessageId = resultRows.length > 0 ? resultRows[0].id : null;
      const newestMessageId = resultRows.length > 0 ? resultRows[resultRows.length - 1].id : null;
      const oldestSequence = resultRows.length > 0 ? resultRows[0].sequence : null;
      const newestSequence = resultRows.length > 0 ? resultRows[resultRows.length - 1].sequence : null;

      return NextResponse.json({
        success: true,
        messages: mapped,
        engine: 'pi',
        hasMoreBefore: isBackwardPage ? hasMore : false,
        hasMoreAfter: after !== null ? hasMore : false,
        oldestTimestamp,
        newestTimestamp,
        oldestMessageId,
        newestMessageId,
        oldestSequence,
        newestSequence,
      });
    }

    if (agentId !== DEFAULT_AGENT_ID) {
      return NextResponse.json({ success: true, messages: [], hasMoreBefore: false, hasMoreAfter: false, oldestTimestamp: null, newestTimestamp: null });
    }

    if (!(await legacyAiTablesExist())) {
      return NextResponse.json({ success: true, messages: [], hasMoreBefore: false, hasMoreAfter: false, oldestTimestamp: null, newestTimestamp: null });
    }

    if (scopedWorkspace && scopedWorkspace.workspaceType !== 'personal') {
      return NextResponse.json({ success: false, error: 'Legacy session is outside the active workspace' }, { status: 403 });
    }

    // Fallback to legacy (ownership enforced)
    const dbAiSessions = await db
      .select()
      .from(aiSessions)
      .where(and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.userId, session.user.id)))
      .limit(1);

    if (dbAiSessions.length === 0) {
      return NextResponse.json({ success: true, messages: [], hasMoreBefore: false, hasMoreAfter: false, oldestTimestamp: null, newestTimestamp: null });
    }

    const conditions = [eq(aiMessages.aiSessionDbId, dbAiSessions[0].id)];
    if (before !== null) {
      conditions.push(
        beforeId !== null
          ? or(
              lt(aiMessages.createdAt, new Date(before)),
              and(eq(aiMessages.createdAt, new Date(before)), lt(aiMessages.id, beforeId)),
            )!
          : lt(aiMessages.createdAt, new Date(before)),
      );
    }
    if (after !== null) {
      conditions.push(
        afterId !== null
          ? or(
              gt(aiMessages.createdAt, new Date(after)),
              and(eq(aiMessages.createdAt, new Date(after)), gt(aiMessages.id, afterId)),
            )!
          : gt(aiMessages.createdAt, new Date(after)),
      );
    }

    const isBackwardPage = before !== null || (before === null && after === null);

    const rows = await db
      .select()
      .from(aiMessages)
      .where(and(...conditions))
      .orderBy(
        isBackwardPage ? desc(aiMessages.createdAt) : asc(aiMessages.createdAt),
        isBackwardPage ? desc(aiMessages.id) : asc(aiMessages.id),
      )
      .limit(limit + 1);

    let hasMore = false;
    let resultRows = rows;
    if (rows.length > limit) {
      hasMore = true;
      resultRows = rows.slice(0, limit);
    }

    if (isBackwardPage) {
      resultRows = [...resultRows].sort((a, b) => {
        const left = a.createdAt.getTime();
        const right = b.createdAt.getTime();
        if (left !== right) {
          return left - right;
        }
        return a.id - b.id;
      });
    }

    const oldestTimestamp = resultRows.length > 0 ? resultRows[0].createdAt.getTime() : null;
    const newestTimestamp = resultRows.length > 0 ? resultRows[resultRows.length - 1].createdAt.getTime() : null;
    const oldestMessageId = resultRows.length > 0 ? resultRows[0].id : null;
    const newestMessageId = resultRows.length > 0 ? resultRows[resultRows.length - 1].id : null;

    return NextResponse.json({
      success: true,
      messages: resultRows,
      engine: 'legacy',
      hasMoreBefore: isBackwardPage ? hasMore : false,
      hasMoreAfter: after !== null ? hasMore : false,
      oldestTimestamp,
      newestTimestamp,
      oldestMessageId,
      newestMessageId,
    });
  } catch (error) {
    console.error('[API] Failed to fetch messages:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
