import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { replaceWorkspaceFileFromPath } from '@/app/lib/filesystem/workspace-files';
import { runWorkspaceUploadWrite } from '@/app/lib/files/workspace-upload-flow';
import { workspaceUploadErrorResponse } from '@/app/lib/files/workspace-upload-responses';
import {
  completeWorkspaceUploadFile,
  publicWorkspaceUploadSession,
} from '@/app/lib/files/workspace-upload-service';
import { syncPublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;

  const limited = rateLimit(request, {
    limit: 2_000,
    windowMs: 60_000,
    keyPrefix: 'workspace-upload-complete',
  });
  if (!limited.ok) return limited.response;

  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const { id } = await params;
    const payload = await request.json() as { fileId?: unknown };
    const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
    const result = await completeWorkspaceUploadFile({
      sessionId: id,
      fileId,
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      commit: async ({ file, sourcePath }) => {
        await runWorkspaceUploadWrite({
          workspace: workspaceResult.workspace,
          fileOptions,
          actorUserId: workspaceResult.session.user.id,
          targetPath: file.targetPath,
          write: () => replaceWorkspaceFileFromPath(sourcePath, file.targetPath, fileOptions),
        });
      },
    });

    if (!result.alreadyCompleted) {
      await syncPublicSharesAfterWrite([result.file.targetPath], workspaceResult.workspace);
      invalidateWorkspaceFileViews({
        fileOptions,
        fullTree: true,
        mutations: [{ path: result.file.targetPath, type: 'add' }],
      });
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
        summary: `File uploaded: ${result.file.targetPath}`,
        metadata: {
          uploadSessionId: result.session.id,
          targetPath: result.file.targetPath,
          sizeBytes: result.file.size,
          mimeType: result.file.mimeType,
          workspaceType: workspaceResult.workspace.workspaceType,
          chunked: true,
        },
      });
    }

    return NextResponse.json({
      success: true,
      upload: publicWorkspaceUploadSession(result.session),
      file: result.file,
      alreadyCompleted: result.alreadyCompleted,
    });
  } catch (error) {
    return workspaceUploadErrorResponse(error, '[API] Failed to complete workspace upload file:');
  }
}
