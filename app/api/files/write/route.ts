import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { writeFile } from '@/app/lib/filesystem/workspace-files';
import {
  WorkspaceFileRevisionError,
  assertWorkspaceFileRevisionAllowed,
  getWorkspaceFileRevision,
  workspaceRequiresRevisionCheck,
} from '@/app/lib/files/revision-guard';
import {
  FileCollaborationPolicyError,
  assertFileCollaborationWriteAllowed,
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
} from '@/app/lib/files/collaboration-policy';
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

    const body = await readJsonBody<{
      path?: string;
      content?: string;
      expectedSha256?: string | null;
      baseRevisionId?: string | null;
    }>(request);
    const { path, content, expectedSha256, baseRevisionId } = body;

    if (!path || content === undefined) {
      return jsonError('Path and content are required', 400);
    }

    // Check if content is base64 encoded (prefix with base64: to distinguish from plain text)
    let finalContent: Buffer | string = content;
    if (typeof content === 'string' && content.startsWith('base64:')) {
      finalContent = Buffer.from(content.substring(7), 'base64');
    }

    const beforeRevision = await assertWorkspaceFileRevisionAllowed({
      path,
      expectedSha256,
      options: fileOptions,
      requireExpectedRevision: workspaceRequiresRevisionCheck(workspaceResult.workspace),
    });
    const storedBaseRevision = beforeRevision
      ? ensureFileRevisionForCurrentContent({
          workspace: workspaceResult.workspace,
          path,
          contentHash: beforeRevision.sha256,
          sizeBytes: beforeRevision.stats.size,
          actorType: 'system',
        })
      : null;

    assertFileCollaborationWriteAllowed({
      workspace: workspaceResult.workspace,
      path,
      actorUserId: workspaceResult.session.user.id,
      actorSessionId: null,
      actorType: 'user',
      baseRevisionId: baseRevisionId ?? null,
    });

    await writeFile(path, finalContent, fileOptions);
    const contentBuffer = Buffer.isBuffer(finalContent) ? finalContent : Buffer.from(finalContent);
    const afterRevision = await getWorkspaceFileRevision(path, fileOptions);
    if (!afterRevision) {
      return jsonError('Written file could not be read after save', 500);
    }
    const afterSha256 = afterRevision.sha256;
    const stats = afterRevision.stats;
    const revision = ensureFileRevisionForCurrentContent({
      workspace: workspaceResult.workspace,
      path,
      contentHash: afterSha256,
      sizeBytes: stats.size,
      actorUserId: workspaceResult.session.user.id,
      actorType: 'user',
      sourceSessionId: null,
      baseRevisionId: baseRevisionId ?? storedBaseRevision?.id ?? null,
    });
    const collaboration = getFileCollaborationState({
      workspace: workspaceResult.workspace,
      path,
      ensureDocument: true,
    });
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
        contentBytes: contentBuffer.byteLength,
        encoded: typeof content === 'string' && content.startsWith('base64:'),
        expectedSha256: expectedSha256 ?? null,
        afterSha256,
        baseRevisionId: baseRevisionId ?? storedBaseRevision?.id ?? null,
        revisionId: revision.id,
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
        revision,
        collaboration,
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
    if (error instanceof FileCollaborationPolicyError) {
      return jsonError(error.message, error.status, {
        code: error.code,
        path: error.path,
        currentRevisionId: error.currentRevisionId,
        baseRevisionId: error.baseRevisionId,
        activeLock: error.activeLock,
      });
    }
    return jsonServerError('[API] File write error:', error, 'Failed to write file');
  }
}
