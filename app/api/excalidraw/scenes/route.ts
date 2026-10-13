import { NextRequest, NextResponse } from 'next/server';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { EXCALIDRAW_API_MAX_REQUEST_BYTES, parseExcalidrawCreateInput } from '@/app/lib/excalidraw-collaboration/api-contract';
import { excalidrawRequestAuthority, excalidrawRouteError, requireExcalidrawRequestWorkspace } from '@/app/lib/excalidraw-collaboration/http';
import { createExcalidrawDocument } from '@/app/lib/excalidraw-collaboration/scene-service';

export async function POST(request: NextRequest) {
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'excalidraw-scenes-create' });
  if (limited) return limited;
  try {
    const body = await readBoundedJson(request, EXCALIDRAW_API_MAX_REQUEST_BYTES);
    if (body.response) return body.response;
    const input = parseExcalidrawCreateInput(body.body);
    const access = await requireExcalidrawRequestWorkspace(request, { workspaceId: input.workspaceId, permissions: 'canWrite' });
    if (access.response) return access.response;
    const verify = excalidrawRequestAuthority(request, access, 'canWrite');
    const document = await createExcalidrawDocument({ ...input, workspace: access.workspace,
      actor: { userId: access.session.user.id, actorId: `user:${access.session.user.id}`,
        actorType: 'user', sessionId: access.session.session.id }, beforeApply: async () => { await verify(); } });
    return NextResponse.json({ success: true, document }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return excalidrawRouteError(error); }
}
