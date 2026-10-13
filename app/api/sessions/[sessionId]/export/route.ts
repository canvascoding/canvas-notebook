import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { aiMessages, aiSessions, piMessages } from '@/app/lib/db/schema';
import { legacyAiTablesExist } from '@/app/lib/db/legacy-ai-tables';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { findOwnedPiSessionForRuntime, isPiSessionInWorkspace } from '@/app/lib/pi/session-runtime-access';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { parsePersistedPiMessage } from '@/app/lib/pi/message-projection';
import { exportSessionMarkdown } from '@/app/lib/chat/session-markdown-export';

export const dynamic = 'force-dynamic';

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** Read-only debug export of the complete persisted history, including pre-compaction messages. */
export async function GET(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return reply({ error: 'Unauthorized' }, 401);
  const { sessionId } = await context.params;
  const workspaceId = request.nextUrl.searchParams.get('workspaceId');
  if (!sessionId || sessionId.length > 500 || !workspaceId || workspaceId.length > 200) return reply({ error: 'Invalid export request.' }, 400);
  let agentId: string;
  try { agentId = normalizeManagedAgentId(request.nextUrl.searchParams.get('agentId')); }
  catch { return reply({ error: 'Invalid agent.' }, 400); }
  let workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>>;
  try {
    workspace = await resolveAgentSessionWorkspaceForUser({ userId: session.user.id, workspaceId, permissions: ['canRead', 'canRunAgent'] });
    await requireAgentAccess(session.user.id, agentId, 'canUse', {
      organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, projectId: workspace.projectId,
    });
  } catch { return reply({ error: 'Workspace or agent inaccessible.' }, 403); }
  try {
    const owned = await findOwnedPiSessionForRuntime({ sessionId, userId: session.user.id, agentId });
    if (owned) {
      if (!isPiSessionInWorkspace(owned, workspace) || owned.sessionKind === 'delegation_worker') return reply({ error: 'Session is outside this chat context.' }, 403);
      const rows = await db.select().from(piMessages).where(eq(piMessages.piSessionDbId, owned.id)).orderBy(asc(piMessages.sequence), asc(piMessages.id));
      const messages = rows.map((row) => ({
        ...parsePersistedPiMessage(row.content, 'raw'), id: row.id, sequence: row.sequence, createdAt: new Date(row.timestamp).toISOString(),
      }));
      return reply(await exportSessionMarkdown({
        title: owned.title || 'Chat', sessionId, agentId, messages,
        identity: { userId: owned.userId, organizationId: owned.organizationId, sessionId: owned.sessionId, workspaceId: owned.workspaceId ?? undefined },
      }));
    }
    if (agentId !== DEFAULT_AGENT_ID || workspace.workspaceType !== 'personal' || !(await legacyAiTablesExist())) return reply({ error: 'Session not found.' }, 404);
    const [legacy] = await db.select().from(aiSessions).where(and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.userId, session.user.id))).limit(1);
    if (!legacy) return reply({ error: 'Session not found.' }, 404);
    const messages = await db.select().from(aiMessages).where(eq(aiMessages.aiSessionDbId, legacy.id)).orderBy(asc(aiMessages.createdAt), asc(aiMessages.id));
    return reply(await exportSessionMarkdown({ title: legacy.title || 'Chat', sessionId, agentId, messages }));
  } catch {
    return reply({ error: 'The complete chat or a stored tool output could not be read.' }, 500);
  }
}
