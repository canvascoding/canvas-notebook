import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from '@/app/lib/ssh/sftp-client';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-write',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = await request.json();
    const { path, content } = body;

    if (!path || content === undefined) {
      return NextResponse.json(
        { success: false, error: 'Path and content are required' },
        { status: 400 }
      );
    }

    await writeFile(path, content);
    clearFileTreeCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] File write error:', error);
    const message = error instanceof Error ? error.message : 'Failed to write file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
