import { NextRequest, NextResponse } from 'next/server';

import { readMobileFileDetail } from '@/app/lib/mobile/files';
import { mobileFilesErrorResponse, mobileFilesResponseHeaders } from '@/app/lib/mobile/files-route';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'mobile-files-detail',
  });
  if (limited) return limited;
  try {
    const file = await readMobileFileDetail({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      path: request.nextUrl.searchParams.get('path'),
      baseUrl: getPublicRequestOrigin(request),
    });
    return NextResponse.json({ success: true, file }, { headers: mobileFilesResponseHeaders });
  } catch (error) {
    return mobileFilesErrorResponse(error, '[API] Mobile file detail error:');
  }
}
