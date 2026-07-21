import { NextRequest, NextResponse } from 'next/server';

import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { auth } from '@/app/lib/auth';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { addMobileStudioLibraryImage, parseMobileStudioLibraryKind } from '@/app/lib/mobile/studio-management';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

export async function POST(request: NextRequest, context: { params: Promise<{ kind: string; entityId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const parsed = await parseMultipartFormData(request);
    if (!parsed.ok) return parsed.response;
    const file = parsed.formData.get('file');
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: 'Image file is required.' }, { status: 400, headers: mobileStudioResponseHeaders });
    const buffer = Buffer.from(await file.arrayBuffer());
    const { kind: rawKind, entityId } = await context.params;
    const item = await addMobileStudioLibraryImage(parseMobileStudioLibraryKind(rawKind), entityId, studioRequest.scope, {
      buffer, fileName: file.name, mimeType: file.type || 'application/octet-stream', fileSize: buffer.length, sourceType: 'upload',
    });
    return NextResponse.json({ success: true, item }, { status: 201, headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio library image failed:'); }
}
