import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { findOwnedPiSessionForRuntime, isPiSessionInWorkspace } from '@/app/lib/pi/session-runtime-access';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { readStoredToolOutput } from '@/app/lib/pi/tool-output-store';
import { readTextWindow } from '@/app/lib/pi/text-read-window';
import { TOOL_OUTPUT_READ_DEFAULT_CHARACTERS, TOOL_OUTPUT_READ_MAX_CHARACTERS } from '@/app/lib/pi/tool-output-policy';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** Display-only retrieval. This endpoint neither starts a runtime nor adds messages. */
export async function GET(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return reply({ error: 'Unauthorized' }, 401);
  const limited = rateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: `tool-output-read:${session.user.id}` });
  if (!limited.ok) return limited.response;
  const { sessionId } = await context.params;
  const query = request.nextUrl.searchParams;
  const reference = query.get('reference') ?? '';
  const workspaceId = query.get('workspaceId');
  const offset = Number(query.get('offset') ?? 0);
  const maxChars = Number(query.get('maxChars') ?? TOOL_OUTPUT_READ_DEFAULT_CHARACTERS);
  if (!sessionId || sessionId.length > 500 || !workspaceId || workspaceId.length > 200
    || !/^tool-output:\/\/call-[a-f0-9]{64}\/output-[a-f0-9]{32}\.(?:txt|json)$/.test(reference)
    || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 2) {
    return reply({ error: 'Invalid tool output request.' }, 400);
  }
  let agentId: string;
  try { agentId = normalizeManagedAgentId(query.get('agentId')); }
  catch { return reply({ error: 'Invalid agent.' }, 400); }
  const owned = await findOwnedPiSessionForRuntime({ sessionId, userId: session.user.id, agentId });
  if (!owned) return reply({ error: 'Session not found.' }, 404);
  try {
    const workspace = await resolveAgentSessionWorkspaceForUser({ userId: session.user.id, workspaceId, permissions: ['canRead', 'canRunAgent'] });
    if (!isPiSessionInWorkspace(owned, workspace)) return reply({ error: 'Session is outside this workspace.' }, 403);
    await requireAgentAccess(session.user.id, agentId, 'canUse', {
      organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, projectId: workspace.projectId,
    });
  } catch { return reply({ error: 'Workspace or agent inaccessible.' }, 403); }
  try {
    const stored = await readStoredToolOutput({ userId: owned.userId, organizationId: owned.organizationId,
      sessionId: owned.sessionId, workspaceId: owned.workspaceId ?? undefined }, reference);
    const range = readTextWindow(stored.content, offset, Math.min(maxChars, TOOL_OUTPUT_READ_MAX_CHARACTERS));
    return reply({ content: range.text, offset: range.offset, nextOffset: range.nextOffset, totalChars: range.totalChars, eof: range.eof, sha256: stored.sha256 });
  } catch { return reply({ error: 'Stored output is unavailable.' }, 404); }
}
