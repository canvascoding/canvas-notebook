import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import {
  MobileExcalidrawError,
  readMobileExcalidrawDocument,
  saveMobileExcalidrawDocument,
} from '@/app/lib/mobile/excalidraw';
import {
  mobileNotebookErrorResponse,
  mobileNotebookResponseHeaders,
} from '@/app/lib/mobile/notebook-route';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function excalidrawErrorResponse(error: unknown, context: string) {
  if (error instanceof MobileExcalidrawError) {
    return NextResponse.json({
      success: false,
      error: error.message,
      code: error.code,
      currentSceneSequence: error.currentSceneSequence,
    }, { status: error.status, headers: mobileNotebookResponseHeaders });
  }
  return mobileNotebookErrorResponse(error, context);
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'mobile-excalidraw-read',
  });
  if (limited) return limited;
  try {
    const document = await readMobileExcalidrawDocument({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      path: request.nextUrl.searchParams.get('path'),
    });
    return NextResponse.json({ success: true, document }, { headers: mobileNotebookResponseHeaders });
  } catch (error) {
    return excalidrawErrorResponse(error, '[API] Mobile Excalidraw read error:');
  }
}

export async function PUT(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'mobile-excalidraw-save',
  });
  if (limited) return limited;
  try {
    const body = await readJsonBody<{
      path?: unknown;
      content?: unknown;
      expectedSha256?: unknown;
      baseRevisionId?: unknown;
      baseSceneSequence?: unknown;
    }>(request);
    const document = await saveMobileExcalidrawDocument({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      actorUserId: workspaceResult.session.user.id,
      actorSessionId: String(workspaceResult.session.session.id),
      path: body.path,
      content: body.content,
      expectedSha256: body.expectedSha256,
      baseRevisionId: body.baseRevisionId,
      baseSceneSequence: body.baseSceneSequence,
    });
    return NextResponse.json({ success: true, document }, { headers: mobileNotebookResponseHeaders });
  } catch (error) {
    return excalidrawErrorResponse(error, '[API] Mobile Excalidraw save error:');
  }
}
