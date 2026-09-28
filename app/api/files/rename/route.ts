import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { checkRenameConflict, type RenameConflictError } from '@/app/lib/filesystem/workspace-files';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { renameWorkspacePath } from '@/app/lib/files/rename-service';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import {
  applyWorkspaceLinkRename,
  buildWorkspaceLinkIndex,
  type WorkspaceLinkRenameResult,
} from '@/app/lib/markdown/workspace-link-index';
import type { WorkspaceLinkIndex } from '@/app/lib/markdown/workspace-link-index-core';
import { buildWorkspaceFileOperationPreview, WorkspacePreviewStaleError, WorkspacePreviewUnavailableError } from '@/app/lib/markdown/workspace-file-operation-preview';
import { assessWorkspaceRenameLinks } from '@/app/lib/markdown/workspace-file-operation-status';

interface RenameRequestBody {
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
  updateLinks?: boolean;
  dryRun?: boolean;
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: ['canWrite', 'canDelete'] });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-rename',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<RenameRequestBody>(request);
    const { oldPath, newPath, overwrite = false, updateLinks = true, dryRun = false } = body;

    if (!oldPath || !newPath) {
      return jsonError('oldPath and newPath are required', 400);
    }
    if (isProtectedAppOutputFolder(oldPath)) {
      return jsonError(`Protected app output folder cannot be modified: ${oldPath}`, 403);
    }
    if (isProtectedAppOutputFolder(newPath)) {
      return jsonError(`Protected app output folder cannot be overwritten: ${newPath}`, 403);
    }

    if (dryRun) {
      if (overwrite) {
        return jsonError('Dry run cannot safely preview overwrite with the current rename executor.', 422, {
          code: 'PREVIEW_UNSUPPORTED_COLLISION_POLICY',
        });
      }
      const plan = await buildWorkspaceFileOperationPreview({
        kind: 'rename',
        sourceWorkspaceId: workspaceResult.workspace.workspaceId,
        destinationWorkspaceId: workspaceResult.workspace.workspaceId,
        sourceOptions: fileOptions,
        destinationOptions: fileOptions,
        selections: [{ sourcePath: oldPath, destinationPath: newPath }],
      });
      const { previewContents: _previewContents, ...publicPlan } = plan;
      return jsonSuccess({ dryRun: true, requiresRevalidation: true, plan: publicPlan });
    }

    // Resolve missing sources through the conflict path before reading metadata.
    // This keeps stale/repeated move requests recoverable for bulk operations
    // instead of leaking a raw ENOENT as a 500 response.
    const conflict = await checkRenameConflict(oldPath, newPath, fileOptions);
    if (conflict) {
      const conflictError = conflict as RenameConflictError;
      if (!(overwrite && conflictError.code === 'FILE_EXISTS' && conflictError.type === 'file')) {
        return jsonError(conflict.message, 409, {
          code: conflictError.code,
          type: conflictError.type,
          sourcePath: conflictError.sourcePath,
          destPath: conflictError.destPath,
        });
      }
    }

    const shouldUpdateLinks = updateLinks;
    let preparedLinkIndex: WorkspaceLinkIndex | null = null;
    let linkIndexWarning: string | null = null;
    const prepareLinkIndex = async () => {
      if (!shouldUpdateLinks || preparedLinkIndex || linkIndexWarning) return;
      try {
        preparedLinkIndex = await buildWorkspaceLinkIndex(fileOptions);
      } catch (error) {
        linkIndexWarning = error instanceof Error ? error.message : String(error);
      }
    };
    const updateRenamedLinks = async (): Promise<WorkspaceLinkRenameResult> => {
      if (!preparedLinkIndex) {
        return {
          updatedFiles: [],
          updatedLinks: 0,
          warnings: linkIndexWarning ? [`Link index: ${linkIndexWarning}`] : [],
        };
      }
      try {
        return await applyWorkspaceLinkRename(
          preparedLinkIndex,
          oldPath,
          newPath,
          fileOptions,
        );
      } catch (error) {
        return {
          updatedFiles: [],
          updatedLinks: 0,
          warnings: [`Link update failed after the path changed: ${error instanceof Error ? error.message : String(error)}`],
        };
      }
    };

    await prepareLinkIndex();
    const renameResult = await renameWorkspacePath({
      workspace: workspaceResult.workspace,
      oldPath,
      newPath,
      overwrite,
      fileOptions,
    });
    const linkUpdates = await updateRenamedLinks();
    linkUpdates.warnings.unshift(...renameResult.warnings);
    const linkAssessment = assessWorkspaceRenameLinks({
      index: preparedLinkIndex,
      oldPath,
      newPath,
      updateLinks,
      result: linkUpdates,
      indexError: linkIndexWarning,
    });
    linkUpdates.warnings = linkAssessment.warnings;
    invalidateWorkspaceFileViews({
      fileOptions,
      fullTree: true,
      mutations: [
        ...linkUpdates.updatedFiles.map((path) => ({ path, type: 'change' as const })),
      ],
    });
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: newPath,
      action: 'file.rename',
      status: 'success',
      summary: `Path renamed from ${oldPath} to ${newPath}.`,
      metadata: {
        oldPath,
        newPath,
        overwrite,
        linkUpdates,
        linkStatus: linkAssessment.status,
        workspaceType: workspaceResult.workspace.workspaceType,
      },
    });

    return jsonSuccess({ linkUpdates, linkStatus: linkAssessment.status, mutation: renameResult.mutation });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to rename path';
    if (error instanceof WorkspacePreviewStaleError) return jsonError(message, 409, { code: 'PREVIEW_STALE' });
    if (error instanceof WorkspacePreviewUnavailableError) return jsonError(message, 422, { code: 'PREVIEW_UNREADABLE' });
    
    // Check if this is a conflict error
    const conflictError = error as RenameConflictError;
    if (conflictError.code && ['FILE_EXISTS', 'DIRECTORY_EXISTS', 'SOURCE_NOT_FOUND'].includes(conflictError.code)) {
      return jsonError(message, 409, {
        code: conflictError.code,
        type: conflictError.type,
        sourcePath: conflictError.sourcePath,
        destPath: conflictError.destPath,
      });
    }
    
    return jsonServerError('[API] File rename error:', error, 'Failed to rename path');
  }
}
