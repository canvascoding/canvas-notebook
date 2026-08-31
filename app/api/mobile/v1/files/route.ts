import { NextRequest, NextResponse } from 'next/server';

import { listMobileFiles } from '@/app/lib/mobile/files';
import { mobileFilesErrorResponse, mobileFilesResponseHeaders } from '@/app/lib/mobile/files-route';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'mobile-files-list',
  });
  if (limited) return limited;
  try {
    const result = await listMobileFiles({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      directory: request.nextUrl.searchParams.get('directory'),
      query: request.nextUrl.searchParams.get('query'),
      filter: request.nextUrl.searchParams.get('filter'),
      sort: request.nextUrl.searchParams.get('sort'),
      sortOrder: request.nextUrl.searchParams.get('sortOrder'),
      cursor: request.nextUrl.searchParams.get('cursor'),
      limit: request.nextUrl.searchParams.get('limit'),
      baseUrl: getPublicRequestOrigin(request),
    });
    return NextResponse.json({ success: true, ...result }, { headers: mobileFilesResponseHeaders });
  } catch (error) {
    return mobileFilesErrorResponse(error, '[API] Mobile files list error:');
  }
}
