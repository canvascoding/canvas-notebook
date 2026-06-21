import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { trashWorkspacePaths } from '@/app/lib/filesystem/workspace-trash';
import { syncPublicSharesAfterDelete } from '@/app/lib/public-sharing/public-file-shares';
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

export async function DELETE(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canDelete' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-delete',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{ path?: string | string[] }>(request);
    const { path } = body;

    if (!path || (Array.isArray(path) && path.length === 0)) {
      return jsonError('Path(s) are required', 400);
    }

    const pathsToDelete = Array.isArray(path) ? path : [path];
    const protectedPaths = pathsToDelete.filter((candidate) =>
      isProtectedAppOutputFolder(candidate)
    );
    if (protectedPaths.length > 0) {
      return jsonError(`Protected app output folder(s) cannot be deleted: ${protectedPaths.join(', ')}`, 403);
    }

    const result = await trashWorkspacePaths({
      workspace: workspaceResult.workspace,
      paths: pathsToDelete,
      deletedByUserId: workspaceResult.session.user.id,
    });
    const deletedPaths = result.trashed.map((entry) => entry.originalPath);
    await syncPublicSharesAfterDelete(deletedPaths, workspaceResult.workspace);

    invalidateWorkspaceFileViews({
      fileOptions,
      subtreeDirs: deletedPaths.map(getParentDirectory),
    });
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: deletedPaths.join(','),
      action: 'file.delete',
      status: result.failed.length > 0 ? 'failure' : 'success',
      summary: `${result.trashed.length} path(s) moved to trash; ${result.failed.length} failed.`,
      metadata: {
        deleteMode: 'trash',
        requestedPaths: pathsToDelete,
        trashed: result.trashed.map((entry) => ({
          id: entry.id,
          originalPath: entry.originalPath,
          itemType: entry.itemType,
          sizeBytes: entry.sizeBytes,
          expiresAt: entry.expiresAt.toISOString(),
        })),
        failed: result.failed,
        workspaceType: workspaceResult.workspace.workspaceType,
      },
    });

    return jsonSuccess({
      deleted: deletedPaths,
      trashEntries: result.trashed.map((entry) => ({
        id: entry.id,
        originalPath: entry.originalPath,
        itemType: entry.itemType,
        sizeBytes: entry.sizeBytes,
        expiresAt: entry.expiresAt.toISOString(),
      })),
      failed: result.failed,
    });
  } catch (error) {
    return jsonServerError('[API] File delete error:', error, 'Failed to delete path');
  }
}
