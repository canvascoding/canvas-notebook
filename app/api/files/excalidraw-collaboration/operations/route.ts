import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { listExcalidrawAgentOperations } from '@/app/lib/excalidraw-collaboration/agent-operations';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'excalidraw-collaboration-operations-list',
  });
  if (limited) return limited;
  const documentId = request.nextUrl.searchParams.get('documentId')?.trim();
  if (!documentId) return NextResponse.json({ success: false, error: 'documentId is required.' }, { status: 400 });
  const operations = await listExcalidrawAgentOperations({
    documentId,
    workspace: workspaceResult.workspace,
    userId: workspaceResult.session.user.id,
    pendingOnly: request.nextUrl.searchParams.get('pending') === '1',
  });
  return NextResponse.json({ success: true, operations }, { headers: { 'Cache-Control': 'no-store' } });
}
