import { NextRequest, NextResponse } from 'next/server';

import {
  createMobileNotebookDocument,
  listMobileNotebookDocuments,
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
    limit: 40,
    windowMs: 60_000,
    keyPrefix: 'mobile-notebook-list',
  });
  if (limited) return limited;
  try {
    const result = await listMobileNotebookDocuments({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      query: request.nextUrl.searchParams.get('query'),
      cursor: request.nextUrl.searchParams.get('cursor'),
      limit: request.nextUrl.searchParams.get('limit'),
    });
    return NextResponse.json({ success: true, ...result }, { headers: mobileNotebookResponseHeaders });
  } catch (error) {
    return mobileNotebookErrorResponse(error, '[API] Mobile notebook error:');
  }
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'mobile-notebook-create',
  });
  if (limited) return limited;
  try {
    const body = await readJsonBody<{ title?: unknown; folder?: unknown }>(request);
    const document = await createMobileNotebookDocument({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      actorUserId: workspaceResult.session.user.id,
      actorSessionId: String(workspaceResult.session.session.id),
      title: body.title,
      folder: body.folder,
    });
    return NextResponse.json({ success: true, document }, { status: 201, headers: mobileNotebookResponseHeaders });
  } catch (error) {
    return mobileNotebookErrorResponse(error, '[API] Mobile notebook create error:');
  }
}
