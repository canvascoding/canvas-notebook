import { NextRequest, NextResponse } from 'next/server';

import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { auth } from '@/app/lib/auth';
import { getCachedFileReferenceEntries } from '@/app/lib/filesystem/file-reference-cache';
import { searchFileReferenceEntries } from '@/app/lib/filesystem/file-reference-search';
import { assertUnambiguousOwnedPiSessionForRuntime } from '@/app/lib/pi/session-runtime-access';
import {
  resolveAgentExecutionContextForSession,
  resolveAgentSessionWorkspaceForUser,
} from '@/app/lib/pi/session-workspace-context';
import { MAX_BROWSER_UPLOAD_FILE_BYTES } from '@/app/lib/pi/browser/view-transfers';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';

const MAX_RESULTS = 100;

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'browser-view-files' });
  if (!limited.ok) return limited.response;

  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim() || '';
    if (!sessionId) return NextResponse.json({ success: false, error: 'Session is required.' }, { status: 400 });
    const agentId = normalizeManagedAgentId(request.nextUrl.searchParams.get('agentId'));
    const agentSession = await assertUnambiguousOwnedPiSessionForRuntime({
      sessionId,
      userId: session.user.id,
      agentId,
    });
    const executionContext = await resolveAgentExecutionContextForSession({
      sessionId: agentSession.sessionId,
      userId: session.user.id,
      agentId: agentSession.agentId,
    });
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: session.user.id,
      workspaceId: executionContext.workspaceId,
      permissions: ['canRead', 'canRunAgent'],
    });
    if (
      workspace.workspaceId !== executionContext.workspaceId
      || workspace.workspaceType !== executionContext.workspaceType
      || (workspace.organizationId ?? null) !== executionContext.organizationId
    ) {
      return NextResponse.json({ success: false, error: 'Browser workspace scope changed.' }, { status: 409 });
    }

    const query = (request.nextUrl.searchParams.get('q') || '').trim().slice(0, 256);
    const entries = await getCachedFileReferenceEntries(false, workspaceFileOptions(workspace));
    const files = searchFileReferenceEntries(entries, query).slice(0, MAX_RESULTS).map((entry) => ({
      name: entry.name,
      path: entry.path,
      size: entry.size ?? 0,
      selectable: typeof entry.size === 'number' && entry.size <= MAX_BROWSER_UPLOAD_FILE_BYTES,
    }));
    return NextResponse.json({
      success: true,
      data: { files, maxFileBytes: MAX_BROWSER_UPLOAD_FILE_BYTES },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load workspace files.';
    const status = message.toLowerCase().includes('not found') ? 404 : 500;
    return NextResponse.json({ success: false, error: 'Could not load workspace files.' }, { status });
  }
}
