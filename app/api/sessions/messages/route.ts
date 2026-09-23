import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { legacyAiTablesExist } from '@/app/lib/db/legacy-ai-tables';
import { aiSessions, piSessions } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { InvalidMessagePaginationError, parseMessagePagination, readPiSessionMessages, readLegacySessionMessages } from '@/app/lib/chat/session-message-read';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

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
  try {
    await requireAgentAccess(session.user.id, agentId, 'canUse');
  } catch {
    return NextResponse.json({ success: false, code: 'AGENT_ACCESS_DENIED', error: 'Agent access denied.' }, { status: 403 });
  }

  try {
    const pagination = parseMessagePagination(searchParams);
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

      return NextResponse.json(await readPiSessionMessages(db, piSession.id, pagination));
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

    return NextResponse.json(await readLegacySessionMessages(db, dbAiSessions[0].id, pagination));
  } catch (error) {
    if (error instanceof InvalidMessagePaginationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error('[API] Failed to fetch messages:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
