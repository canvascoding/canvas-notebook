import { NextRequest, NextResponse } from 'next/server';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { EXCALIDRAW_API_MAX_REQUEST_BYTES, ExcalidrawApiInputError, excalidrawOperationFeedback,
  parseExcalidrawEditInput } from '@/app/lib/excalidraw-collaboration/api-contract';
import { excalidrawRequestAuthority, excalidrawRouteError, requireExcalidrawRequestWorkspace } from '@/app/lib/excalidraw-collaboration/http';
import { applyExcalidrawChanges } from '@/app/lib/excalidraw-collaboration/scene-service';

export async function POST(request: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'excalidraw-scenes-edit' });
  if (limited) return limited;
  try {
    const body = await readBoundedJson(request, EXCALIDRAW_API_MAX_REQUEST_BYTES);
    if (body.response) return body.response;
    const { documentId } = await context.params;
    const input = parseExcalidrawEditInput(body.body);
    if (input.documentId !== documentId) throw new ExcalidrawApiInputError('documentId must match the requested scene URL.');
    const access = await requireExcalidrawRequestWorkspace(request, { workspaceId: input.workspaceId, permissions: 'canWrite' });
    if (access.response) return access.response;
    const verify = excalidrawRequestAuthority(request, access, 'canWrite');
    const operation = await applyExcalidrawChanges({ ...input, workspace: access.workspace,
      actor: { userId: access.session.user.id, actorId: `user:${access.session.user.id}`,
        actorType: 'user', sessionId: access.session.session.id }, beforeApply: async () => { await verify(); } });
    return NextResponse.json({ success: true, operation: excalidrawOperationFeedback(operation) },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return excalidrawRouteError(error); }
}
