import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import { getMobileStudioCatalog } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: mobileStudioResponseHeaders },
    );
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const permissionState = await readOrganizationPermissionForUser(session.user.id);
    const studio = await getMobileStudioCatalog({
      scope: studioRequest.scope,
      userId: session.user.id,
      canWrite: Boolean(studioRequest.workspace?.permissions.canWrite),
      canDeleteAssets: permissionState.permission?.canDeleteStudioAssets === true
        || (!permissionState.configured && isAdminUser(session.user)),
    });
    return NextResponse.json({ success: true, studio }, { headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio catalog failed:');
  }
}
