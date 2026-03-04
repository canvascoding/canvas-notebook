import { NextRequest, NextResponse } from 'next/server';
import { renameFile } from '@/app/lib/filesystem/workspace-files';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-rename',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = await request.json();
    const { oldPath, newPath } = body as { oldPath?: string; newPath?: string };

    if (!oldPath || !newPath) {
      return NextResponse.json(
        { success: false, error: 'oldPath and newPath are required' },
        { status: 400 }
      );
    }

    await renameFile(oldPath, newPath);
    clearFileTreeCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] File rename error:', error);
    const message = error instanceof Error ? error.message : 'Failed to rename path';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
