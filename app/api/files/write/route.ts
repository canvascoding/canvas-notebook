import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { getFileStats, writeFile } from '@/app/lib/filesystem/workspace-files';
import {
  WorkspaceFileRevisionError,
  assertWorkspaceFileRevisionAllowed,
  sha256Buffer,
  workspaceRequiresRevisionCheck,
} from '@/app/lib/files/revision-guard';
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

    const body = await readJsonBody<{ path?: string; content?: string; expectedSha256?: string | null }>(request);
    const { path, content, expectedSha256 } = body;

    if (!path || content === undefined) {
      return jsonError('Path and content are required', 400);
    }

    // Check if content is base64 encoded (prefix with base64: to distinguish from plain text)
    let finalContent: Buffer | string = content;
    if (typeof content === 'string' && content.startsWith('base64:')) {
      finalContent = Buffer.from(content.substring(7), 'base64');
    }

    await assertWorkspaceFileRevisionAllowed({
      path,
      expectedSha256,
      options: fileOptions,
      requireExpectedRevision: workspaceRequiresRevisionCheck(workspaceResult.workspace),
    });

    await writeFile(path, finalContent, fileOptions);
    const contentBuffer = Buffer.isBuffer(finalContent) ? finalContent : Buffer.from(finalContent);
    const afterSha256 = sha256Buffer(contentBuffer);
    const stats = await getFileStats(path, fileOptions);
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
        expectedSha256: expectedSha256 ?? null,
        afterSha256,
      },
      input: {
        path,
        contentLength: typeof content === 'string' ? content.length : null,
      },
    });

    return jsonSuccess({
      data: {
        path,
        stats: {
          size: stats.size,
          modified: stats.modified,
          permissions: stats.permissions,
          sha256: afterSha256,
        },
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceFileRevisionError) {
      return jsonError(error.message, error.status, {
        code: error.code,
        path: error.path,
        expectedSha256: error.expectedSha256,
        currentSha256: error.currentSha256,
        currentStats: error.currentStats,
      });
    }
    return jsonServerError('[API] File write error:', error, 'Failed to write file');
  }
}
