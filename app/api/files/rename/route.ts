import { NextRequest } from 'next/server';
import { renameFile, checkRenameConflict, type RenameConflictError } from '@/app/lib/filesystem/workspace-files';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { syncPublicSharesAfterMove } from '@/app/lib/public-sharing/public-file-shares';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

interface RenameRequestBody {
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
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
    const { oldPath, newPath, overwrite = false } = body;

    if (!oldPath || !newPath) {
      return jsonError('oldPath and newPath are required', 400);
    }
    if (isProtectedAppOutputFolder(oldPath)) {
      return jsonError(`Protected app output folder cannot be modified: ${oldPath}`, 403);
    }
    if (isProtectedAppOutputFolder(newPath)) {
      return jsonError(`Protected app output folder cannot be overwritten: ${newPath}`, 403);
    }

    // Check for conflicts first (for better error messages)
    const conflict = await checkRenameConflict(oldPath, newPath, fileOptions);
    if (conflict) {
      const conflictError = conflict as RenameConflictError;
      if (overwrite && conflictError.code === 'FILE_EXISTS' && conflictError.type === 'file') {
        await renameFile(oldPath, newPath, true, fileOptions);
        await syncPublicSharesAfterMove(oldPath, newPath, workspaceResult.workspace);
        invalidateWorkspaceFileViews({ fileOptions, fullTree: true });
        return jsonSuccess();
      }

      return jsonError(conflict.message, 409, {
        code: conflictError.code,
        type: conflictError.type,
        sourcePath: conflictError.sourcePath,
        destPath: conflictError.destPath,
      });
    }

    await renameFile(oldPath, newPath, overwrite, fileOptions);
    await syncPublicSharesAfterMove(oldPath, newPath, workspaceResult.workspace);
    invalidateWorkspaceFileViews({ fileOptions, fullTree: true });

    return jsonSuccess();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to rename path';
    
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
