import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { getExcalidrawOperation } from '@/app/lib/excalidraw-collaboration/operation-service';
import { excalidrawRequestAuthority, excalidrawRouteError, requireExcalidrawRequestWorkspace } from '@/app/lib/excalidraw-collaboration/http';

export async function GET(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  try {
    const workspaceResult = await requireExcalidrawRequestWorkspace(request, { permissions: 'canRead' });
    if (workspaceResult.response) return workspaceResult.response;
    const limited = applyRateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: 'excalidraw-collaboration-operation-get',
    });
    if (limited) return limited;
    const { operationId } = await context.params;
    const operation = await getExcalidrawOperation({
      operationId,
      workspace: workspaceResult.workspace,
      userId: workspaceResult.session.user.id,
      beforeRead: excalidrawRequestAuthority(request, workspaceResult, 'canRead'),
    });
    return NextResponse.json({ success: true, operation }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return excalidrawRouteError(error); }
}
