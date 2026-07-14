import { NextRequest, NextResponse } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { getStudioGeneration, deleteStudioGeneration } from '@/app/lib/integrations/studio-generation-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(_request, session);
  if (!studioRequest.scope) return studioRequest.response;

  const { id } = await params;
  try {
    const generation = await getStudioGeneration(id, studioRequest.scope);
    if (!generation) {
      return NextResponse.json({ success: false, error: 'Generation not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, generation });
  } catch (error) {
    console.error('[Studio Generation Detail] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to get generation' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const studioPermission = await requireOrganizationPermission(_request, 'canDeleteStudioAssets', {
    errorMessage: 'Forbidden: Studio asset delete permission required',
  });
  if (!studioPermission.ok) return studioPermission.response;
  const studioRequest = await requireStudioRequestScope(_request, studioPermission.session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;

  const { id } = await params;
  try {
    await deleteStudioGeneration(id, studioRequest.scope);
    await recordAuditEvent({
      organizationId: studioPermission.state.organizationId,
      userId: studioPermission.session.user.id,
      source: 'studio',
      eventType: 'studio',
      entityType: 'studio_generation',
      entityId: id,
      action: 'studio_generation.delete',
      status: 'success',
      summary: `Studio generation ${id} deleted.`,
      metadata: {
        permissionRole: studioPermission.permission.role,
      },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 400 });
    }
    console.error('[Studio Generation Delete] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete generation' }, { status: 500 });
  }
}
