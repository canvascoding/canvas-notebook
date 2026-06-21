import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { createDirectory, writeFile } from '@/app/lib/filesystem/workspace-files';
import { createEmptyExcalidrawFileContent, isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-create',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{
      path?: string;
      type?: 'file' | 'directory';
      template?: 'excalidraw';
    }>(request);
    const { path, type, template } = body;

    if (!path || !type) {
      return jsonError('Path and type are required', 400);
    }

    if (type === 'directory') {
      await createDirectory(path, fileOptions);
    } else if (type === 'file') {
      await writeFile(
        path,
        template === 'excalidraw' || isExcalidrawFilePath(path)
          ? createEmptyExcalidrawFileContent()
          : '',
        fileOptions
      );
    } else {
      return jsonError('Invalid type', 400);
    }

    invalidateWorkspaceFileViews({ fileOptions, fullTree: true });
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: path,
      action: type === 'directory' ? 'file.directory.create' : 'file.create',
      status: 'success',
      summary: `${type} created at ${path}.`,
      metadata: {
        path,
        type,
        template: template ?? null,
        workspaceType: workspaceResult.workspace.workspaceType,
      },
    });

    return jsonSuccess();
  } catch (error) {
    return jsonServerError('[API] File create error:', error, 'Failed to create path');
  }
}
