import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import {
  createMobileStudioLibraryEntity,
  listMobileStudioLibrary,
  parseMobileStudioLibraryKind,
} from '@/app/lib/mobile/studio-management';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

export async function GET(request: NextRequest, context: { params: Promise<{ kind: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { kind: rawKind } = await context.params;
    const kind = parseMobileStudioLibraryKind(rawKind);
    return NextResponse.json({ success: true, items: await listMobileStudioLibrary(kind, studioRequest.scope) }, { headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio library list failed:'); }
}

export async function POST(request: NextRequest, context: { params: Promise<{ kind: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { kind: rawKind } = await context.params;
    const item = await createMobileStudioLibraryEntity(parseMobileStudioLibraryKind(rawKind), studioRequest.scope, await request.json().catch(() => null));
    return NextResponse.json({ success: true, item }, { status: 201, headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio library create failed:'); }
}
