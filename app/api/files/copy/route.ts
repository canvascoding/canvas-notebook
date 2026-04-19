import { NextRequest, NextResponse } from 'next/server';
import { batchCopy } from '@/app/lib/filesystem/workspace-files';
import { clearSubtreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { auth } from '@/app/lib/auth';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-copy',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = await request.json();
    const { sources, destDir, overwrite = false } = body as {
      sources?: string[];
      destDir?: string;
      overwrite?: boolean;
    };

    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Sources array is required and must not be empty' },
        { status: 400 }
      );
    }

    if (!destDir || typeof destDir !== 'string') {
      return NextResponse.json(
        { success: false, error: 'destDir is required' },
        { status: 400 }
      );
    }

    const protectedPaths = sources.filter((p) => isProtectedAppOutputFolder(p));
    if (protectedPaths.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Protected app output folder(s) cannot be copied: ${protectedPaths.join(', ')}`,
        },
        { status: 403 }
      );
    }

    const result = await batchCopy(sources, destDir, overwrite);

    clearSubtreeCache(destDir);

    return NextResponse.json({
      success: true,
      copied: result.copied,
      failed: result.failed,
      skipped: result.skipped,
    });
  } catch (error) {
    console.error('[API] File copy error:', error);
    const message = error instanceof Error ? error.message : 'Failed to copy files';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}