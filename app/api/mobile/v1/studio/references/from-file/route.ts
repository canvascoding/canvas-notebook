import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { importMobileStudioWorkspaceReference } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: mobileStudioResponseHeaders },
    );
  }
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope || !studioRequest.workspace) return studioRequest.response;
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-studio-file-reference' });
  if (limited) return limited;
  try {
    const body = await request.json().catch(() => null) as { path?: unknown } | null;
    const reference = await importMobileStudioWorkspaceReference({
      scope: studioRequest.scope,
      fileOptions: workspaceFileOptions(studioRequest.workspace),
      sourcePath: body?.path,
    });
    return NextResponse.json({ success: true, reference }, { status: 201, headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio file reference failed:');
  }
}
