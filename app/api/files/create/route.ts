import { NextRequest, NextResponse } from 'next/server';
import { createDirectory, writeFile } from '@/app/lib/ssh/sftp-client';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-create',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = await request.json();
    const { path, type } = body as { path?: string; type?: 'file' | 'directory' };

    if (!path || !type) {
      return NextResponse.json(
        { success: false, error: 'Path and type are required' },
        { status: 400 }
      );
    }

    if (type === 'directory') {
      await createDirectory(path);
    } else if (type === 'file') {
      await writeFile(path, '');
    } else {
      return NextResponse.json(
        { success: false, error: 'Invalid type' },
        { status: 400 }
      );
    }

    clearFileTreeCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] File create error:', error);
    const message = error instanceof Error ? error.message : 'Failed to create path';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
