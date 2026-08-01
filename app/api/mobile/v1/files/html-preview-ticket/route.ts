import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { isHtmlFile } from '@/app/lib/html-preview';
import {
  issueMobileHtmlPreviewTicket,
  mobileHtmlPreviewPath,
} from '@/app/lib/mobile/html-preview-ticket';
import {
  MobileFilesError,
  normalizeMobileFilePath,
  readMobileFileDetail,
} from '@/app/lib/mobile/files';
import {
  mobileFilesErrorResponse,
  mobileFilesResponseHeaders,
} from '@/app/lib/mobile/files-route';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: `mobile-html-preview-ticket:${workspaceResult.session.user.id}`,
  });
  if (limited) return limited;

  try {
    const body = await readJsonBody<{ path?: unknown }>(request);
    const filePath = normalizeMobileFilePath(body.path, false);
    if (!isHtmlFile(filePath)) {
      throw new MobileFilesError('The selected file is not HTML.', 400, 'HTML_FILE_REQUIRED');
    }
    await readMobileFileDetail({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      path: filePath,
    });
    const issued = issueMobileHtmlPreviewTicket({
      userId: workspaceResult.session.user.id,
      sessionId: String(workspaceResult.session.session.id),
      rootHtmlPath: filePath,
      workspace: workspaceResult.workspace,
    });
    return NextResponse.json({
      success: true,
      preview: {
        urlPath: mobileHtmlPreviewPath(issued.ticket, filePath),
        expiresAt: issued.expiresAt,
      },
    }, { headers: mobileFilesResponseHeaders });
  } catch (error) {
    return mobileFilesErrorResponse(error, '[API] Mobile HTML preview ticket error:');
  }
}
