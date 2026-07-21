import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import {
  deleteMobileStudioLibraryEntity,
  parseMobileStudioLibraryKind,
  updateMobileStudioLibraryEntity,
} from '@/app/lib/mobile/studio-management';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';

export async function PATCH(request: NextRequest, context: { params: Promise<{ kind: string; entityId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { kind: rawKind, entityId } = await context.params;
    const item = await updateMobileStudioLibraryEntity(parseMobileStudioLibraryKind(rawKind), entityId, studioRequest.scope, await request.json().catch(() => null));
    return NextResponse.json({ success: true, item }, { headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio library update failed:'); }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ kind: string; entityId: string }> }) {
  const permission = await requireOrganizationPermission(request, 'canDeleteStudioAssets');
  if (!permission.ok) return permission.response;
  const studioRequest = await requireStudioRequestScope(request, permission.session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { kind: rawKind, entityId } = await context.params;
    await deleteMobileStudioLibraryEntity(parseMobileStudioLibraryKind(rawKind), entityId, studioRequest.scope);
    return NextResponse.json({ success: true }, { headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio library delete failed:'); }
}
