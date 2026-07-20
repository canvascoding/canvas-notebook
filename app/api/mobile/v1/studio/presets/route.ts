import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  createPreset,
  getStudioPresetBlockCatalog,
  listPresets,
} from '@/app/lib/integrations/studio-preset-service';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';
import { parseMobileStudioPresetInput, serializeMobileStudioPreset } from '@/app/lib/mobile/studio-presets';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const presets = await listPresets(studioRequest.scope);
    return NextResponse.json({
      success: true,
      presets: presets.map((preset) => serializeMobileStudioPreset(preset, studioRequest.scope!.workspaceId)),
      catalog: getStudioPresetBlockCatalog(),
    }, { headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio presets failed:'); }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const preset = await createPreset(studioRequest.scope, parseMobileStudioPresetInput(await request.json().catch(() => null)));
    return NextResponse.json({ success: true, preset: serializeMobileStudioPreset(preset, studioRequest.scope.workspaceId) }, { status: 201, headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio preset create failed:'); }
}
