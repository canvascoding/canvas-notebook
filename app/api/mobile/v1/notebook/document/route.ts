import { NextRequest, NextResponse } from 'next/server';

import {
  readMobileNotebookDocument,
  saveMobileNotebookDocument,
} from '@/app/lib/mobile/notebook';
import {
  mobileNotebookErrorResponse,
  mobileNotebookResponseHeaders,
} from '@/app/lib/mobile/notebook-route';
import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 90,
    windowMs: 60_000,
    keyPrefix: 'mobile-notebook-read',
  });
  if (limited) return limited;
  try {
    const document = await readMobileNotebookDocument({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      actorUserId: workspaceResult.session.user.id,
      path: request.nextUrl.searchParams.get('path'),
    });
    return NextResponse.json({ success: true, document }, { headers: mobileNotebookResponseHeaders });
  } catch (error) {
    return mobileNotebookErrorResponse(error, '[API] Mobile notebook read error:');
  }
}

export async function PUT(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'mobile-notebook-save',
  });
  if (limited) return limited;
  try {
    const body = await readJsonBody<{
      path?: unknown;
      content?: unknown;
      expectedSha256?: unknown;
      baseRevisionId?: unknown;
    }>(request);
    const document = await saveMobileNotebookDocument({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      actorUserId: workspaceResult.session.user.id,
      actorSessionId: String(workspaceResult.session.session.id),
      path: body.path,
      content: body.content,
      expectedSha256: body.expectedSha256,
      baseRevisionId: body.baseRevisionId,
    });
    return NextResponse.json({ success: true, document }, { headers: mobileNotebookResponseHeaders });
  } catch (error) {
    return mobileNotebookErrorResponse(error, '[API] Mobile notebook save error:');
  }
}
