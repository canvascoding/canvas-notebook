import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { writeWorkspaceFileFromPathIfAbsent } from '@/app/lib/filesystem/workspace-files';
import { runWorkspaceUploadWrite } from '@/app/lib/files/workspace-upload-flow';
import { workspaceUploadErrorResponse } from '@/app/lib/files/workspace-upload-responses';
import { completeWorkspaceUploadFile, publicWorkspaceUploadFile, publicWorkspaceUploadSession } from '@/app/lib/files/workspace-upload-service';
import { syncPublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { excalidrawRequestAuthority } from '@/app/lib/excalidraw-collaboration/http';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const workspaceResult = await requireRequestWorkspace(original, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 2_000, windowMs: 60_000, keyPrefix: 'mobile-files-upload-complete' });
  if (!limited.ok) return limited.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);
  try {
    const { id } = await params;
    const payload = await request.json() as { fileId?: unknown };
    const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
    const afterCompletion = async (result: Pick<Awaited<ReturnType<typeof completeWorkspaceUploadFile>>, 'session' | 'file'>) => {
      await syncPublicSharesAfterWrite([result.file.targetPath], workspaceResult.workspace);
      invalidateWorkspaceFileViews({ fileOptions, fullTree: true, mutations: [{ path: result.file.targetPath, type: 'add' }] });
      await recordAuditEvent({
        organizationId: workspaceResult.workspace.organizationId,
        workspaceId: workspaceResult.workspace.workspaceId,
        userId: workspaceResult.session.user.id,
        source: 'files',
        eventType: 'file',
        entityType: 'workspace_path',
        entityId: result.file.targetPath,
        action: 'file.upload',
        status: 'success',
        summary: `File uploaded from mobile: ${result.file.targetPath}`,
        metadata: { uploadSessionId: result.session.id, targetPath: result.file.targetPath, sizeBytes: result.file.size, mimeType: result.file.mimeType, workspaceType: workspaceResult.workspace.workspaceType, chunked: true, mobile: true },
      });
    };
    const result = await completeWorkspaceUploadFile({
      sessionId: id,
      fileId,
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      request: original,
      afterMarkdownCompletion: afterCompletion,
      commit: async ({ file, sourcePath, persistOfficeAttempt }) => {
        await runWorkspaceUploadWrite({
          workspace: workspaceResult.workspace,
          fileOptions,
          actorUserId: workspaceResult.session.user.id,
          targetPath: file.targetPath,
          sourcePath,
          createOnly: true,
          idempotencyKey: `upload:${id}:${file.id}`,
          officeAttempt: file.officeAttempt,
          persistOfficeAttempt,
          beforeWrite: file.targetPath.toLowerCase().endsWith('.excalidraw')
            ? async () => { await excalidrawRequestAuthority(request, workspaceResult, 'canWrite')(); } : undefined,
          write: () => writeWorkspaceFileFromPathIfAbsent(sourcePath, file.targetPath, fileOptions),
        });
      },
    });
    if (result.completion && result.completion.status !== 'completed') {
      // Existing native queues treat only non-2xx as retained work. A 202 with
      // an uploaded file would advance their queue and remove the local source.
      return NextResponse.json({ success: false, error: result.completion.status === 'unavailable'
        ? 'Markdown import is not available yet. The upload was retained.' : 'Markdown completion is pending. The upload was retained.',
      code: result.completion.code, completion: result.completion }, { status: 409 });
    }
    if (!result.alreadyCompleted && !result.completion) await afterCompletion(result);
    return NextResponse.json({ success: true, upload: publicWorkspaceUploadSession(result.session), file: publicWorkspaceUploadFile(result.file), alreadyCompleted: result.alreadyCompleted,
      ...(result.completion ? { completion: result.completion } : {}) });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      return NextResponse.json({ success: false, error: 'A file already exists at this upload destination.', code: 'UPLOAD_DESTINATION_EXISTS' }, { status: 409 });
    }
    return workspaceUploadErrorResponse(error, '[API] Failed to complete mobile workspace upload:');
  }
}
