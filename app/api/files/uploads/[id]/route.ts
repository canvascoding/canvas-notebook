import { NextRequest, NextResponse } from 'next/server';

import { workspaceUploadErrorResponse } from '@/app/lib/files/workspace-upload-responses';
import {
  cancelWorkspaceUploadSession,
  getWorkspaceUploadSession,
  publicWorkspaceUploadSession,
  writeWorkspaceUploadChunk,
} from '@/app/lib/files/workspace-upload-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

function parseInteger(value: string | null, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const { id } = await params;
    const upload = await getWorkspaceUploadSession({
      sessionId: id,
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
    });
    return NextResponse.json({ success: true, upload: publicWorkspaceUploadSession(upload) });
  } catch (error) {
    return workspaceUploadErrorResponse(error, '[API] Failed to read workspace upload:');
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;

  const limited = rateLimit(request, {
    limit: 5_000,
    windowMs: 60_000,
    keyPrefix: 'workspace-upload-chunk',
  });
  if (!limited.ok) return limited.response;

  try {
    const { id } = await params;
    const fileId = request.nextUrl.searchParams.get('fileId')?.trim() || '';
    const offset = parseInteger(request.nextUrl.searchParams.get('offset'), 'Upload offset');
    const expectedBytes = parseInteger(
      request.nextUrl.searchParams.get('expectedBytes') ?? request.headers.get('content-length'),
      'Upload chunk size',
    );
    const result = await writeWorkspaceUploadChunk({
      sessionId: id,
      fileId,
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      offset,
      expectedBytes,
      body: request.body,
    });
    return NextResponse.json({
      success: true,
      file: result.file,
      alreadyReceived: result.alreadyReceived,
    });
  } catch (error) {
    return workspaceUploadErrorResponse(error, '[API] Failed to write workspace upload chunk:');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const { id } = await params;
    await cancelWorkspaceUploadSession({
      sessionId: id,
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return workspaceUploadErrorResponse(error, '[API] Failed to cancel workspace upload:');
  }
}
