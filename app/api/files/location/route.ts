import { NextRequest, NextResponse } from 'next/server';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { resolveWorkspaceFileLinkTarget } from '@/app/lib/files/file-link-service';
import { WorkspaceMutationLockError } from '@/app/lib/files/workspace-mutation-lock';

const headers = { 'Cache-Control': 'no-store' };
export async function GET(request: NextRequest) {
  const authorized = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (authorized.response) return authorized.response;
  const documentId = request.nextUrl.searchParams.get('documentId');
  const lineageId = request.nextUrl.searchParams.get('lineageId');
  if ((!documentId && !lineageId) || [documentId, lineageId].some(value => value !== null
    && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value))) {
    return NextResponse.json({ success: false, error: 'A valid documentId or lineageId is required.' }, { status: 400, headers });
  }
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'file-link-location' });
  if (limited) return limited;
  try {
    const target = await resolveWorkspaceFileLinkTarget(authorized.workspace, { documentId, lineageId });
    return target ? NextResponse.json({ success: true, ...target }, { headers })
      : NextResponse.json({ success: false, error: 'The linked file is unavailable.' }, { status: 404, headers });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Could not resolve the linked file.' },
      { status: error instanceof WorkspaceMutationLockError ? error.status : 500, headers });
  }
}
