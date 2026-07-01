import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { batchCopyBetweenWorkspaces } from '@/app/lib/filesystem/workspace-files';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { compactWorkspaceSelection } from '@/app/lib/files/operation-flows';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import {
  requireSessionWorkspace,
  workspaceFileOptions,
} from '@/app/lib/workspaces/request';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return jsonError('Unauthorized', 401);
  }

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-copy',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{
      sources?: string[];
      destDir?: string;
      overwrite?: boolean;
      renameOnCollision?: boolean;
      sourceWorkspaceId?: string | null;
      targetWorkspaceId?: string | null;
    }>(request);
    const {
      sources,
      destDir,
      overwrite = false,
      renameOnCollision = false,
      sourceWorkspaceId,
      targetWorkspaceId,
    } = body;

    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return jsonError('Sources array is required and must not be empty', 400);
    }

    const copySources = compactWorkspaceSelection(sources);
    if (copySources.length === 0) {
      return jsonError('Sources array is required and must not be empty', 400);
    }

    if (!destDir || typeof destDir !== 'string') {
      return jsonError('destDir is required', 400);
    }

    const requestWorkspaceId = request.headers.get(WORKSPACE_ID_HEADER)?.trim() || null;
    const resolvedSourceWorkspaceId = typeof sourceWorkspaceId === 'string' && sourceWorkspaceId.trim()
      ? sourceWorkspaceId.trim()
      : requestWorkspaceId;
    const resolvedTargetWorkspaceId = typeof targetWorkspaceId === 'string' && targetWorkspaceId.trim()
      ? targetWorkspaceId.trim()
      : resolvedSourceWorkspaceId;

    const sourceWorkspaceResult = await requireSessionWorkspace(session, {
      workspaceId: resolvedSourceWorkspaceId,
      permissions: 'canRead',
    });
    if (sourceWorkspaceResult.response) return sourceWorkspaceResult.response;

    const targetWorkspaceResult = await requireSessionWorkspace(session, {
      workspaceId: resolvedTargetWorkspaceId,
      permissions: 'canWrite',
    });
    if (targetWorkspaceResult.response) return targetWorkspaceResult.response;

    const sourceFileOptions = workspaceFileOptions(sourceWorkspaceResult.workspace);
    const targetFileOptions = workspaceFileOptions(targetWorkspaceResult.workspace);

    const protectedPaths = copySources.filter((p) => isProtectedAppOutputFolder(p));
    if (protectedPaths.length > 0) {
      return jsonError(`Protected app output folder(s) cannot be copied: ${protectedPaths.join(', ')}`, 403);
    }

    const result = await batchCopyBetweenWorkspaces(copySources, destDir, overwrite, renameOnCollision, {
      source: sourceFileOptions,
      target: targetFileOptions,
    });

    invalidateWorkspaceFileViews({ fileOptions: targetFileOptions, subtreeDirs: [destDir] });
    await recordAuditEvent({
      organizationId: targetWorkspaceResult.workspace.organizationId,
      workspaceId: targetWorkspaceResult.workspace.workspaceId,
      userId: session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: destDir,
      action: 'file.copy',
      status: result.failed.length > 0 ? 'failure' : 'success',
      summary: `${result.copied.length} path(s) copied; ${result.failed.length} failed.`,
      metadata: {
        sources,
        copySources,
        destDir,
        copied: result.copied,
        failed: result.failed,
        skipped: result.skipped,
        sourceWorkspaceId: sourceWorkspaceResult.workspace.workspaceId,
        sourceWorkspaceType: sourceWorkspaceResult.workspace.workspaceType,
        targetWorkspaceId: targetWorkspaceResult.workspace.workspaceId,
        targetWorkspaceType: targetWorkspaceResult.workspace.workspaceType,
        overwrite,
        renameOnCollision,
      },
    });

    return jsonSuccess({
      copied: result.copied,
      failed: result.failed,
      skipped: result.skipped,
      sourceWorkspaceId: sourceWorkspaceResult.workspace.workspaceId,
      targetWorkspaceId: targetWorkspaceResult.workspace.workspaceId,
    });
  } catch (error) {
    return jsonServerError('[API] File copy error:', error, 'Failed to copy files');
  }
}
