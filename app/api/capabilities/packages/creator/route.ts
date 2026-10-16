import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { managementErrorDetails } from '@/app/lib/agents/management-actions';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { prepareCapabilityPackageCreatorChatAction, readCapabilityPackageCreatorOptionsAction } from '@/app/lib/capabilities/packages/creator-chat';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
async function handle(request: NextRequest, start: boolean) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers });
  try {
    const query = request.nextUrl.searchParams, workspaceId = query.get('workspaceId'), header = request.headers.get(WORKSPACE_ID_HEADER);
    if ([...query.keys()].some(key => key !== 'workspaceId') || query.getAll('workspaceId').length !== 1
      || !workspaceId || workspaceId.length > 256 || workspaceId !== workspaceId.trim() || /[\p{Cc}\p{Cf}]/u.test(workspaceId)
      || header !== null && header !== workspaceId) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'Choose one exact current workspace.');
    const actor = { userId: session.user.id, sessionId: session.session.id, workspaceId };
    let data;
    if (start) {
      const parsed = await readBoundedJson(request, 16_384);
      if (parsed.response) { parsed.response.headers.set('Cache-Control', headers['Cache-Control']); return parsed.response; }
      data = await prepareCapabilityPackageCreatorChatAction(actor, parsed.body);
    } else data = await readCapabilityPackageCreatorOptionsAction(actor);
    return NextResponse.json({ success: true, data }, { headers });
  } catch (error) {
    const details = managementErrorDetails(error);
    return NextResponse.json({ success: false, code: details.code, error: details.message }, { status: details.status, headers });
  }
}
export const GET = (request: NextRequest) => handle(request, false);
export const POST = (request: NextRequest) => handle(request, true);
