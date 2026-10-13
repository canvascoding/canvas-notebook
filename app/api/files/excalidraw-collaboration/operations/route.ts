import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { listExcalidrawOperations } from '@/app/lib/excalidraw-collaboration/operation-service';
import { excalidrawRequestAuthority, excalidrawRouteError, requireExcalidrawRequestWorkspace } from '@/app/lib/excalidraw-collaboration/http';

export async function GET(request: NextRequest) {
  try {
    const workspaceResult = await requireExcalidrawRequestWorkspace(request, { permissions: 'canRead' });
    if (workspaceResult.response) return workspaceResult.response;
    const limited = applyRateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: 'excalidraw-collaboration-operations-list',
    });
    if (limited) return limited;
    const documentId = request.nextUrl.searchParams.get('documentId')?.trim();
    if (!documentId) return NextResponse.json({ success: false, code: 'INVALID_EXCALIDRAW_REQUEST', error: 'documentId is required.' }, { status: 400 });
    const operations = await listExcalidrawOperations({
      documentId,
      workspace: workspaceResult.workspace,
      userId: workspaceResult.session.user.id,
      pendingOnly: request.nextUrl.searchParams.get('pending') === '1',
      beforeRead: excalidrawRequestAuthority(request, workspaceResult, 'canRead'),
    });
    return NextResponse.json({ success: true, operations }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return excalidrawRouteError(error); }
}
