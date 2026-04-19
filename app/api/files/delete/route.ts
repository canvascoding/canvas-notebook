import { NextRequest, NextResponse } from 'next/server';
import { batchDelete } from '@/app/lib/filesystem/workspace-files';
import { clearSubtreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { auth } from '@/app/lib/auth';

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-delete',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = await request.json();
    const { path } = body as { path?: string | string[] };

    if (!path || (Array.isArray(path) && path.length === 0)) {
      return NextResponse.json(
        { success: false, error: 'Path(s) are required' },
        { status: 400 }
      );
    }

    const pathsToDelete = Array.isArray(path) ? path : [path];
    const protectedPaths = pathsToDelete.filter((candidate) =>
      isProtectedAppOutputFolder(candidate)
    );
    if (protectedPaths.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Protected app output folder(s) cannot be deleted: ${protectedPaths.join(', ')}`,
        },
        { status: 403 }
      );
    }

    const result = await batchDelete(pathsToDelete);

    for (const deletedPath of result.deleted) {
      const parentDir = deletedPath.includes('/') ? deletedPath.substring(0, deletedPath.lastIndexOf('/')) : '.';
      clearSubtreeCache(parentDir);
    }

    return NextResponse.json({
      success: true,
      deleted: result.deleted,
      failed: result.failed,
    });
  } catch (error) {
    console.error('[API] File delete error:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete path';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
