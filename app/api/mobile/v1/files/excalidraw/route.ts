import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import {
  MobileExcalidrawError,
  readMobileExcalidrawDocument,
  saveMobileExcalidrawDocument,
  MAX_MOBILE_EXCALIDRAW_REQUEST_BYTES,
} from '@/app/lib/mobile/excalidraw';
import {
  mobileNotebookErrorResponse,
  mobileNotebookResponseHeaders,
} from '@/app/lib/mobile/notebook-route';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import { ExcalidrawApiInputError } from '@/app/lib/excalidraw-collaboration/api-contract';
import { excalidrawRequestAuthority, excalidrawRouteError, requireExcalidrawRequestWorkspace } from '@/app/lib/excalidraw-collaboration/http';

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
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^(?:EXCALIDRAW_|INVALID_EXCALIDRAW_)/u.test(error.code)) {
    const response = excalidrawRouteError(error);
    for (const [key, value] of Object.entries(mobileNotebookResponseHeaders)) response.headers.set(key, value);
    return response;
  }
  return mobileNotebookErrorResponse(error, context);
}

export async function GET(request: NextRequest) {
  const limited = applyRateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'mobile-excalidraw-read',
  });
  if (limited) return limited;
  try {
    const workspaceResult = await requireExcalidrawRequestWorkspace(request, { permissions: 'canRead' });
    if (workspaceResult.response) return workspaceResult.response;
    const document = await readMobileExcalidrawDocument({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      path: request.nextUrl.searchParams.get('path'),
      beforeRead: excalidrawRequestAuthority(request, workspaceResult, 'canRead'),
    });
    return NextResponse.json({ success: true, document }, { headers: mobileNotebookResponseHeaders });
  } catch (error) {
    return excalidrawErrorResponse(error, '[API] Mobile Excalidraw read error:');
  }
}

export async function PUT(request: NextRequest) {
  const limited = applyRateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'mobile-excalidraw-save',
  });
  if (limited) return limited;
  try {
    const parsed = await readBoundedJson(request, MAX_MOBILE_EXCALIDRAW_REQUEST_BYTES);
    if (parsed.response) return parsed.response;
    if (!parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body)) throw new ExcalidrawApiInputError('A JSON object is required.');
    const body = parsed.body as {
      path?: unknown;
      content?: unknown;
      expectedSha256?: unknown;
      baseRevisionId?: unknown;
      baseSceneSequence?: unknown;
      workspaceId?: string;
      documentId?: unknown;
      lifecycleGeneration?: unknown;
    };
    if (body.workspaceId !== undefined && typeof body.workspaceId !== 'string') throw new ExcalidrawApiInputError('workspaceId must be a string.');
    const workspaceResult = await requireExcalidrawRequestWorkspace(request, { workspaceId: body.workspaceId, permissions: 'canWrite' });
    if (workspaceResult.response) return workspaceResult.response;
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
      documentId: body.documentId,
      lifecycleGeneration: body.lifecycleGeneration,
      beforeApply: excalidrawRequestAuthority(request, workspaceResult, 'canWrite'),
    });
    return NextResponse.json({ success: true, document }, { headers: mobileNotebookResponseHeaders });
  } catch (error) {
    return excalidrawErrorResponse(error, '[API] Mobile Excalidraw save error:');
  }
}
