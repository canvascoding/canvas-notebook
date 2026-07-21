import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { assertPresetEditableByUser, deletePreset, updatePreset } from '@/app/lib/integrations/studio-preset-service';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';
import { parseMobileStudioPresetInput, serializeMobileStudioPreset } from '@/app/lib/mobile/studio-presets';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';

export async function PATCH(request: NextRequest, context: { params: Promise<{ presetId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { presetId } = await context.params;
    await assertPresetEditableByUser(presetId, studioRequest.scope);
    const preset = await updatePreset(presetId, studioRequest.scope, parseMobileStudioPresetInput(await request.json().catch(() => null)));
    return NextResponse.json({ success: true, preset: serializeMobileStudioPreset(preset, studioRequest.scope.workspaceId) }, { headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio preset update failed:'); }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ presetId: string }> }) {
  const permission = await requireOrganizationPermission(request, 'canDeleteStudioAssets');
  if (!permission.ok) return permission.response;
  const studioRequest = await requireStudioRequestScope(request, permission.session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { presetId } = await context.params;
    await assertPresetEditableByUser(presetId, studioRequest.scope);
    await deletePreset(presetId, studioRequest.scope);
    return NextResponse.json({ success: true }, { headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio preset delete failed:'); }
}
