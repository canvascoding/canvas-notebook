import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { parseExcalidrawGetInput } from '@/app/lib/excalidraw-collaboration/api-contract';
import { excalidrawRequestAuthority, excalidrawRouteError, requireExcalidrawRequestWorkspace } from '@/app/lib/excalidraw-collaboration/http';
import { getExcalidrawDocument } from '@/app/lib/excalidraw-collaboration/scene-service';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';

export async function GET(request: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'excalidraw-scenes-read' });
  if (limited) return limited;
  try {
    const { documentId } = await context.params;
    const input = parseExcalidrawGetInput({ documentId,
      ...(request.nextUrl.searchParams.has('path') ? { path: request.nextUrl.searchParams.get('path') } : {}) });
    const access = await requireExcalidrawRequestWorkspace(request, { permissions: 'canRead' });
    if (access.response) return access.response;
    const verify = excalidrawRequestAuthority(request, access, 'canRead');
    const document = await withWorkspaceMutationLock(access.workspace.workspaceId, async () =>
      getExcalidrawDocument({ ...input, workspace: await verify(), beforeRead: verify }));
    return NextResponse.json({ success: true, document }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return excalidrawRouteError(error); }
}
