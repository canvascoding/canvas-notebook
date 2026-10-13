import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { readCollaborationOperationIdempotencyKey } from '@/app/lib/collaboration/operation-route';
import { reviewExcalidrawOperation } from '@/app/lib/excalidraw-collaboration/operation-service';
import { excalidrawRequestAuthority, excalidrawRouteError, requireExcalidrawRequestWorkspace } from '@/app/lib/excalidraw-collaboration/http';

export async function POST(request: NextRequest, context: { params: Promise<{ operationId: string }> }) {
  try {
    const workspaceResult = await requireExcalidrawRequestWorkspace(request, { permissions: 'canWrite' });
    if (workspaceResult.response) return workspaceResult.response;
    const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'excalidraw-operation-cancel' });
    if (limited) return limited;
    const body = await readCollaborationOperationIdempotencyKey(request);
    if (body.response) return body.response;
    const { operationId } = await context.params;
    const operation = await reviewExcalidrawOperation({
      operationId,
      workspace: workspaceResult.workspace,
      userId: workspaceResult.session.user.id,
      sessionId: workspaceResult.session.session.id,
      decision: 'cancel',
      beforeApply: excalidrawRequestAuthority(request, workspaceResult, 'canWrite'),
    });
    return NextResponse.json({ success: true, operation }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return excalidrawRouteError(error);
  }
}
