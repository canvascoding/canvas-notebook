import { NextRequest, NextResponse } from 'next/server';
import { renameFile, checkRenameConflict, type RenameConflictError } from '@/app/lib/filesystem/workspace-files';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { auth } from '@/app/lib/auth';

interface RenameRequestBody {
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-rename',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = await request.json() as RenameRequestBody;
    const { oldPath, newPath, overwrite = false } = body;

    if (!oldPath || !newPath) {
      return NextResponse.json(
        { success: false, error: 'oldPath and newPath are required' },
        { status: 400 }
      );
    }
    if (isProtectedAppOutputFolder(oldPath)) {
      return NextResponse.json(
        { success: false, error: `Protected app output folder cannot be modified: ${oldPath}` },
        { status: 403 }
      );
    }

    // Check for conflicts first (for better error messages)
    const conflict = await checkRenameConflict(oldPath, newPath);
    if (conflict) {
      const conflictError = conflict as RenameConflictError;
      return NextResponse.json(
        { 
          success: false, 
          error: conflict.message,
          code: conflictError.code,
          type: conflictError.type,
          sourcePath: conflictError.sourcePath,
          destPath: conflictError.destPath
        },
        { status: 409 }
      );
    }

    await renameFile(oldPath, newPath, overwrite);
    clearFileTreeCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] File rename error:', error);
    const message = error instanceof Error ? error.message : 'Failed to rename path';
    
    // Check if this is a conflict error
    const conflictError = error as RenameConflictError;
    if (conflictError.code && ['FILE_EXISTS', 'DIRECTORY_EXISTS', 'SOURCE_NOT_FOUND'].includes(conflictError.code)) {
      return NextResponse.json(
        { 
          success: false, 
          error: message,
          code: conflictError.code,
          type: conflictError.type,
          sourcePath: conflictError.sourcePath,
          destPath: conflictError.destPath
        },
        { status: 409 }
      );
    }
    
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
