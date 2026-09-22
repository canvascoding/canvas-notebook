import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { aiSessions } from '@/app/lib/db/schema';
import { legacyAiTablesExist } from '@/app/lib/db/legacy-ai-tables';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import { parseMessagePagination, readLegacySessionMessages, readPiSessionMessages } from '@/app/lib/chat/session-message-read';
import {
  findUnambiguousOwnedPiSessionForRuntime,
  isPiSessionInWorkspace,
  PiSessionRuntimeAccessError,
} from '@/app/lib/pi/session-runtime-access';
import {
  resolveAgentSessionWorkspaceForUser,
  storedPiSessionWorkspaceToSummary,
} from '@/app/lib/pi/session-workspace-context';

export const dynamic = 'force-dynamic';

/** Resolve an explicit chat independently of the paginated history list. */
export async function GET(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  const authSession = await auth.api.getSession({ headers: request.headers });
  if (!authSession) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await context.params;
  const workspaceId = new URL(request.url).searchParams.get('workspaceId')?.trim();
  if (!sessionId.trim() || !workspaceId) {
    return NextResponse.json({ success: false, error: 'Session ID and workspaceId required' }, { status: 400 });
  }

  try {
    let workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>>;
    try {
      workspace = await resolveAgentSessionWorkspaceForUser({
        userId: authSession.user.id,
        workspaceId,
        permissions: ['canRead', 'canRunAgent'],
      });
    } catch {
      return NextResponse.json({ success: false, error: 'Workspace not found or inaccessible' }, { status: 403 });
    }

    const piSession = await findUnambiguousOwnedPiSessionForRuntime({ sessionId, userId: authSession.user.id });
    if (piSession && !isPiSessionInWorkspace(piSession, workspace)) {
      return NextResponse.json({ success: false, code: 'SESSION_WORKSPACE_MISMATCH', error: 'Session is outside the active workspace' }, { status: 403 });
    }
    const agentId = piSession?.agentId ?? DEFAULT_AGENT_ID;
    try {
      await requireAgentAccess(authSession.user.id, agentId, 'canUse', {
        organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
      });
    } catch {
      return NextResponse.json({ success: false, code: 'AGENT_ACCESS_DENIED', error: 'Agent access denied.' }, { status: 403 });
    }

    const pagination = parseMessagePagination(new URLSearchParams());
    const creator = { name: authSession.user.name || null, email: authSession.user.email || null };
    if (piSession) {
      const messages = await readPiSessionMessages(db, piSession.id, pagination);
      return NextResponse.json({
        success: true,
        session: {
          id: piSession.id,
          sessionId: piSession.sessionId,
          title: piSession.title,
          titleGenerationState: piSession.titleGenerationState,
          agentId: piSession.agentId,
          model: piSession.model,
          provider: piSession.provider,
          thinkingLevel: piSession.thinkingLevel,
          createdAt: piSession.createdAt,
          lastMessageAt: piSession.lastMessageAt,
          lastViewedAt: piSession.lastViewedAt,
          engine: 'pi',
          hasUnread: hasUnreadAssistantResponse(piSession.lastMessageAt, piSession.lastViewedAt),
          workspace: storedPiSessionWorkspaceToSummary(piSession),
          creator,
        },
        messages,
      });
    }

    if (workspace.workspaceType === 'personal' && await legacyAiTablesExist()) {
      const [legacySession] = await db.select().from(aiSessions).where(and(
        eq(aiSessions.sessionId, sessionId),
        eq(aiSessions.userId, authSession.user.id),
      )).limit(1);
      if (legacySession) {
        return NextResponse.json({
          success: true,
          session: {
            id: legacySession.id,
            sessionId: legacySession.sessionId,
            title: legacySession.title,
            model: legacySession.model,
            createdAt: legacySession.createdAt,
            agentId: DEFAULT_AGENT_ID,
            engine: 'legacy',
            lastMessageAt: null,
            lastViewedAt: null,
            hasUnread: false,
            workspace: null,
            creator,
          },
          messages: await readLegacySessionMessages(db, legacySession.id, pagination),
        });
      }
    }
    return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
  } catch (error) {
    if (error instanceof PiSessionRuntimeAccessError) {
      return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: 409 });
    }
    console.error('[API Session Bootstrap] Failed to load session:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
