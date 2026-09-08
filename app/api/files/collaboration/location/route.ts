import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { WorkspaceMutationLockError } from '@/app/lib/files/workspace-mutation-lock';
import { liveCollaborationRuntimeAvailable } from '@/app/lib/collaboration/runtime-policy';
import { resolveCollaborationDocumentLocation } from '@/app/lib/collaboration/document-location';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const documentId = request.nextUrl.searchParams.get('documentId')?.trim();
  if (!documentId || documentId.length > 256) {
    return NextResponse.json({ success: false, error: 'A collaboration document ID is required.' }, { status: 400, headers });
  }
  if (!liveCollaborationRuntimeAvailable()) {
    return NextResponse.json({ success: false, error: 'Live collaboration requires Postgres.' }, { status: 409, headers });
  }
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'collaboration-location' });
  if (limited) return limited;
  try {
    const location = await resolveCollaborationDocumentLocation(workspaceResult.workspace.workspaceId, documentId);
    if (!location) return NextResponse.json({ success: false, code: 'document_unavailable',
      error: 'The collaboration document is no longer available.' }, { status: 404, headers });
    return NextResponse.json({ success: true, ...location }, { headers });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof WorkspaceMutationLockError
      ? error.message : 'Could not resolve the collaboration document location.' }, {
      status: error instanceof WorkspaceMutationLockError ? error.status : 500, headers,
    });
  }
}
