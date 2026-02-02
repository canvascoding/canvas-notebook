import { NextRequest, NextResponse } from 'next/server';
import { deleteFile } from '@/app/lib/ssh/sftp-client';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function DELETE(request: NextRequest) {
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

    // Run deletions in parallel for performance
    await Promise.all(pathsToDelete.map(p => deleteFile(p)));
    
    clearFileTreeCache();

    return NextResponse.json({ success: true, deleted: pathsToDelete });
  } catch (error) {
    console.error('[API] File delete error:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete path';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
