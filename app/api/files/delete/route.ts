import { NextRequest } from 'next/server';
import { batchDelete } from '@/app/lib/filesystem/workspace-files';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
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

    const result = await batchDelete(pathsToDelete, fileOptions);
    await syncPublicSharesAfterDelete(result.deleted);

    invalidateWorkspaceFileViews({
      subtreeDirs: result.deleted.map(getParentDirectory),
    });

    return jsonSuccess({
      deleted: result.deleted,
      failed: result.failed,
    });
  } catch (error) {
    return jsonServerError('[API] File delete error:', error, 'Failed to delete path');
  }
}
