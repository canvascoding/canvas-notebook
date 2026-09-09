import JSZip from 'jszip';
import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import {
  downloadEmailAttachmentBatch,
  emailAttachmentArchiveFilename,
  EmailAttachmentBatchError,
} from '@/app/lib/email/attachment-batch';
import { isEmailMessageNotFoundError } from '@/app/lib/email/errors';
import { isImapMailboxChangedError } from '@/app/lib/email/imap-service';
import { saveDownloadedEmailAttachmentsToWorkspace } from '@/app/lib/email/attachment-workspace-save';
import { fileContentDisposition } from '@/app/lib/files/content-disposition';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

function errorStatus(error: unknown): number {
  if (error instanceof EmailAttachmentBatchError) return error.status;
  if (isImapMailboxChangedError(error)) return error.status;
  if (isEmailMessageNotFoundError(error)) return 404;
  if (error && typeof error === 'object' && 'status' in error && Number.isInteger(Number(error.status))) {
    return Number(error.status);
  }
  if (error instanceof Error && /25 MB download limit/iu.test(error.message)) return 413;
  return 500;
}

function errorPayload(error: unknown) {
  if (error instanceof EmailAttachmentBatchError) return { success: false, code: error.code, error: error.message };
  if (isImapMailboxChangedError(error)) return { success: false, code: error.code, error: error.message };
  if (isEmailMessageNotFoundError(error)) {
    return { success: false, code: 'EMAIL_MESSAGE_NOT_FOUND', error: 'Email attachment is no longer available.' };
  }
  return { success: false, error: error instanceof Error ? error.message : 'Email attachment operation failed' };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string; messageId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'email-attachments-archive' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId, messageId } = await params;
    const folder = request.nextUrl.searchParams.get('folder') || undefined;
    const downloaded = await downloadEmailAttachmentBatch({
      userId: session.user.id,
      accountId,
      messageId,
      folder,
      readPolicy: { enforceReadPolicy: false },
    });
    const zip = new JSZip();
    for (const item of downloaded.attachments) {
      zip.file(item.attachment.filename, item.content);
    }
    const content = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 },
      streamFiles: true,
    });
    return new NextResponse(new Uint8Array(content), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': fileContentDisposition(emailAttachmentArchiveFilename(downloaded.subject)),
        'Content-Length': String(content.length),
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const status = errorStatus(error);
    if (status >= 500) console.error('[Email Attachments Archive] Error:', error);
    return NextResponse.json(errorPayload(error), { status });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string; messageId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const attachmentIds = Array.isArray(record.attachmentIds)
    ? record.attachmentIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  if (
    attachmentIds.length === 0
    || !Array.isArray(record.attachmentIds)
    || attachmentIds.length !== record.attachmentIds.length
  ) {
    return NextResponse.json({ success: false, error: 'attachmentIds is required' }, { status: 400 });
  }
  if (typeof record.targetPath !== 'string') {
    return NextResponse.json({ success: false, error: 'targetPath is required' }, { status: 400 });
  }

  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId: typeof record.targetWorkspaceId === 'string' ? record.targetWorkspaceId : null,
    permissions: 'canWrite',
  });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'email-attachments-workspace-save' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId, messageId } = await params;
    const folder = typeof record.folder === 'string' && record.folder.trim() ? record.folder : undefined;
    const targetPath = record.targetPath;
    const downloaded = await downloadEmailAttachmentBatch({
      userId: workspaceResult.session.user.id,
      accountId,
      messageId,
      folder,
      attachmentIds,
      readPolicy: { enforceReadPolicy: false },
    });
    const savedAttachments = await saveDownloadedEmailAttachmentsToWorkspace({
      workspace: workspaceResult.workspace,
      actorUserId: workspaceResult.session.user.id,
      actorType: 'user',
      attachments: downloaded.attachments,
      destination: { type: 'directory', path: targetPath, renameConflicts: true },
    });
    const paths = savedAttachments.map((attachment) => attachment.path);
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'email',
      eventType: 'file',
      entityType: 'email_attachment',
      entityId: `${accountId}:${messageId}`,
      action: 'email_attachment.save_to_workspace',
      status: 'success',
      summary: `${paths.length} email attachment(s) saved to workspace.`,
      metadata: {
        accountId,
        messageId,
        attachmentIds,
        paths,
        targetPath,
        targetWorkspaceId: workspaceResult.workspace.workspaceId,
      },
    });
    return NextResponse.json({
      success: true,
      paths,
      savedCount: paths.length,
      targetWorkspaceId: workspaceResult.workspace.workspaceId,
    });
  } catch (error) {
    const status = errorStatus(error);
    if (status >= 500) console.error('[Email Attachments Workspace Save] Error:', error);
    return NextResponse.json(errorPayload(error), { status });
  }
}
