import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { writeFile } from '@/app/lib/filesystem/workspace-files';
import { queuePublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { getParentDirectory } from '@/app/lib/files/path-utils';
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
  try {
    const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
    if (workspaceResult.response) return workspaceResult.response;
    const fileOptions = workspaceFileOptions(workspaceResult.workspace);

    const rateLimitResponse = applyRateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-write',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{ path?: string; content?: string }>(request);
    const { path, content } = body;

    if (!path || content === undefined) {
      return jsonError('Path and content are required', 400);
    }

    // Check if content is base64 encoded (prefix with base64: to distinguish from plain text)
    let finalContent: Buffer | string = content;
    if (typeof content === 'string' && content.startsWith('base64:')) {
      finalContent = Buffer.from(content.substring(7), 'base64');
    }

    await writeFile(path, finalContent, fileOptions);
    invalidateWorkspaceFileViews({ fileOptions, subtreeDirs: [getParentDirectory(path)] });
    queuePublicSharesAfterWrite([path], workspaceResult.workspace);
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: path,
      action: 'file.write',
      status: 'success',
      summary: `File written at ${path}.`,
      metadata: {
        path,
        workspaceType: workspaceResult.workspace.workspaceType,
        contentBytes: Buffer.isBuffer(finalContent) ? finalContent.byteLength : Buffer.byteLength(finalContent),
        encoded: typeof content === 'string' && content.startsWith('base64:'),
      },
      input: {
        path,
        contentLength: typeof content === 'string' ? content.length : null,
      },
    });

    return jsonSuccess();
  } catch (error) {
    return jsonServerError('[API] File write error:', error, 'Failed to write file');
  }
}
