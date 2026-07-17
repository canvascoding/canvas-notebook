import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { getExcalidrawAgentOperation } from '@/app/lib/excalidraw-collaboration/agent-operations';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'excalidraw-collaboration-operation-get',
  });
  if (limited) return limited;
  const { operationId } = await context.params;
  const operation = await getExcalidrawAgentOperation({
    operationId,
    workspace: workspaceResult.workspace,
    userId: workspaceResult.session.user.id,
  });
  if (!operation) return NextResponse.json({ success: false, error: 'Operation not found.' }, { status: 404 });
  return NextResponse.json({ success: true, operation }, { headers: { 'Cache-Control': 'no-store' } });
}
