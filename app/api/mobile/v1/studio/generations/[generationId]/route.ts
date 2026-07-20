import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { deleteStudioGeneration } from '@/app/lib/integrations/studio-generation-service';
import { getMobileStudioGeneration } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ generationId: string }> },
) {
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
    const { generationId } = await context.params;
    const generation = await getMobileStudioGeneration({ scope: studioRequest.scope, generationId });
    return NextResponse.json({ success: true, generation }, { headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio detail failed:');
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ generationId: string }> },
) {
  const studioPermission = await requireOrganizationPermission(request, 'canDeleteStudioAssets', {
    errorMessage: 'Forbidden: Studio asset delete permission required',
  });
  if (!studioPermission.ok) return studioPermission.response;
  const studioRequest = await requireStudioRequestScope(request, studioPermission.session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { generationId } = await context.params;
    await deleteStudioGeneration(generationId, studioRequest.scope);
    await recordAuditEvent({
      organizationId: studioPermission.state.organizationId,
      workspaceId: studioRequest.scope.workspaceId,
      userId: studioPermission.session.user.id,
      source: 'studio',
      eventType: 'studio',
      entityType: 'studio_generation',
      entityId: generationId,
      action: 'studio_generation.mobile_delete',
      status: 'success',
      summary: `Mobile Studio generation ${generationId} deleted.`,
    });
    return NextResponse.json({ success: true }, { headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio generation delete failed:');
  }
}
