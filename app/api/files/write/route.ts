import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from '@/app/lib/filesystem/workspace-files';
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

    // Check if content is base64 encoded (prefix with base64: to distinguish from plain text)
    let finalContent: Buffer | string = content;
    if (typeof content === 'string' && content.startsWith('base64:')) {
      finalContent = Buffer.from(content.substring(7), 'base64');
    }

    await writeFile(path, finalContent);
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
