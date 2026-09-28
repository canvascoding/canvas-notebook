import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { batchCopyBetweenWorkspaces, getFileStats, withWorkspaceCopyMutationLocks } from '@/app/lib/filesystem/workspace-files';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { compactWorkspaceSelection, getWorkspacePathName, resolveMoveDestination } from '@/app/lib/files/operation-flows';
import { buildWorkspaceFileOperationPreview, WorkspacePreviewStaleError, WorkspacePreviewUnavailableError } from '@/app/lib/markdown/workspace-file-operation-preview';
import { initializeCopiedFileCollaborationPaths } from '@/app/lib/files/collaboration-policy';
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
      dryRun?: boolean;
    }>(request);
    const {
      sources,
      destDir,
      overwrite = false,
      renameOnCollision = false,
      sourceWorkspaceId,
      targetWorkspaceId,
      dryRun = false,
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
    const targetFileOptions = { ...workspaceFileOptions(targetWorkspaceResult.workspace), mutationActorUserId: session.user.id };

    const protectedPaths = copySources.filter((p) => isProtectedAppOutputFolder(p));
    if (protectedPaths.length > 0) {
      return jsonError(`Protected app output folder(s) cannot be copied: ${protectedPaths.join(', ')}`, 403);
    }

    if (dryRun) {
      if (overwrite) {
        return jsonError('Dry run cannot safely preview overwrite with the current copy executor.', 422, {
          code: 'PREVIEW_UNSUPPORTED_COLLISION_POLICY',
        });
      }
      try {
        const destinationStats = await getFileStats(destDir, targetFileOptions);
        if (!destinationStats.isDirectory) return jsonError('Destination must be a directory', 409, { code: 'DESTINATION_NOT_DIRECTORY' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return jsonError('Destination directory was not found', 404, { code: 'DESTINATION_NOT_FOUND' });
        }
        if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          return jsonError('Destination directory could not be read', 422, { code: 'PREVIEW_UNREADABLE' });
        }
        throw error;
      }
      const plan = await buildWorkspaceFileOperationPreview({
        kind: 'copy',
        sourceWorkspaceId: sourceWorkspaceResult.workspace.workspaceId,
        destinationWorkspaceId: targetWorkspaceResult.workspace.workspaceId,
        sourceOptions: sourceFileOptions,
        destinationOptions: targetFileOptions,
        renameOnCollision,
        selections: copySources.map((sourcePath) => ({
          sourcePath,
          destinationPath: resolveMoveDestination(destDir, getWorkspacePathName(sourcePath)),
        })),
      });
      const { previewContents: _previewContents, ...publicPlan } = plan;
      return jsonSuccess({ dryRun: true, requiresRevalidation: true, plan: publicPlan });
    }

    const result = await withWorkspaceCopyMutationLocks(sourceFileOptions, targetFileOptions, async () => {
      const copied = await batchCopyBetweenWorkspaces(copySources, destDir, overwrite, renameOnCollision, {
        source: sourceFileOptions, target: targetFileOptions,
      });
      const initialized = new Set(copied.collaborationInitializedPaths);
      await initializeCopiedFileCollaborationPaths({
        workspace: targetWorkspaceResult.workspace, paths: copied.copied.filter((entry) => !initialized.has(entry)),
      });
      return copied;
    });

    invalidateWorkspaceFileViews({
      fileOptions: targetFileOptions,
      subtreeDirs: [destDir],
      mutations: result.copied.map((path) => ({ path, type: 'add' as const })),
    });
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
        linkStatus: 'incomplete',
        linkWarnings: ['Copied Markdown links were not checked or rewritten.'],
      },
    });

    return jsonSuccess({
      copied: result.copied,
      failed: result.failed,
      skipped: result.skipped,
      sourceWorkspaceId: sourceWorkspaceResult.workspace.workspaceId,
      targetWorkspaceId: targetWorkspaceResult.workspace.workspaceId,
      linkStatus: 'incomplete',
      linkWarnings: ['Copied Markdown links were not checked or rewritten.'],
    });
  } catch (error) {
    if (error instanceof WorkspacePreviewStaleError) return jsonError(error.message, 409, { code: 'PREVIEW_STALE' });
    if (error instanceof WorkspacePreviewUnavailableError) return jsonError(error.message, 422, { code: 'PREVIEW_UNREADABLE' });
    return jsonServerError('[API] File copy error:', error, 'Failed to copy files');
  }
}
