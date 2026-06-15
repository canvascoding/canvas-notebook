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
  requireApiSession,
} from '@/app/lib/api/route-helpers';

interface RenameRequestBody {
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

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
    const conflict = await checkRenameConflict(oldPath, newPath);
    if (conflict) {
      const conflictError = conflict as RenameConflictError;
      if (overwrite && conflictError.code === 'FILE_EXISTS' && conflictError.type === 'file') {
        await renameFile(oldPath, newPath, true);
        await syncPublicSharesAfterMove(oldPath, newPath);
        invalidateWorkspaceFileViews({ fullTree: true });
        return jsonSuccess();
      }

      return jsonError(conflict.message, 409, {
        code: conflictError.code,
        type: conflictError.type,
        sourcePath: conflictError.sourcePath,
        destPath: conflictError.destPath,
      });
    }

    await renameFile(oldPath, newPath, overwrite);
    await syncPublicSharesAfterMove(oldPath, newPath);
    invalidateWorkspaceFileViews({ fullTree: true });

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
