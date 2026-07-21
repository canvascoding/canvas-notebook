import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import {
  deleteStudioOutput,
  getStudioOutputForUser,
  setStudioOutputFavorite,
} from '@/app/lib/integrations/studio-generation-service';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ generationId: string; outputId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: mobileStudioResponseHeaders },
    );
  }
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const body = await request.json().catch(() => null) as { isFavorite?: unknown } | null;
    if (typeof body?.isFavorite !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'isFavorite must be a boolean.', code: 'INVALID_STUDIO_REQUEST' },
        { status: 400, headers: mobileStudioResponseHeaders },
      );
    }
    const { generationId, outputId } = await context.params;
    const output = await setStudioOutputFavorite(generationId, outputId, body.isFavorite, studioRequest.scope);
    await recordAuditEvent({
      organizationId: studioRequest.scope.organizationId,
      workspaceId: studioRequest.scope.workspaceId,
      userId: session.user.id,
      source: 'studio',
      eventType: 'studio',
      entityType: 'studio_generation_output',
      entityId: outputId,
      action: 'studio_output.mobile_favorite_update',
      status: 'success',
      summary: `Mobile Studio output ${outputId} favorite state updated.`,
      metadata: { generationId, isFavorite: body.isFavorite },
    });
    return NextResponse.json({
      success: true,
      output: { id: output.id, isFavorite: Boolean(output.isFavorite) },
    }, { headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio favorite update failed:');
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ generationId: string; outputId: string }> },
) {
  const studioPermission = await requireOrganizationPermission(request, 'canDeleteStudioAssets', {
    errorMessage: 'Forbidden: Studio asset delete permission required',
  });
  if (!studioPermission.ok) return studioPermission.response;
  const studioRequest = await requireStudioRequestScope(request, studioPermission.session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { generationId, outputId } = await context.params;
    const output = await getStudioOutputForUser(outputId, studioRequest.scope);
    if (!output || output.generationId !== generationId) {
      return NextResponse.json(
        { success: false, error: 'Output was not found.', code: 'OUTPUT_NOT_FOUND' },
        { status: 404, headers: mobileStudioResponseHeaders },
      );
    }
    const result = await deleteStudioOutput(outputId, studioRequest.scope);
    await recordAuditEvent({
      organizationId: studioPermission.state.organizationId,
      workspaceId: studioRequest.scope.workspaceId,
      userId: studioPermission.session.user.id,
      source: 'studio',
      eventType: 'studio',
      entityType: 'studio_generation_output',
      entityId: outputId,
      action: 'studio_output.mobile_delete',
      status: 'success',
      summary: `Mobile Studio output ${outputId} deleted.`,
      metadata: { generationId, generationDeleted: result.generationDeleted },
    });
    return NextResponse.json({ success: true, generationDeleted: result.generationDeleted }, {
      headers: mobileStudioResponseHeaders,
    });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio output delete failed:');
  }
}
