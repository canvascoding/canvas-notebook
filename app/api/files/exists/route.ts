import { NextRequest, NextResponse } from 'next/server';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { auth } from '@/app/lib/auth';

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 240,
      windowMs: 60_000,
      keyPrefix: 'files-exists',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const { searchParams } = new URL(request.url);
    const path = searchParams.get('path');

    if (!path) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const stats = await getFileStats(path);

    return NextResponse.json({
      success: true,
      data: {
        exists: true,
        path,
        stats: {
          size: stats.size,
          modified: stats.modified,
          permissions: stats.permissions,
        },
      },
    });
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return NextResponse.json({
        success: true,
        data: {
          exists: false,
        },
      });
    }

    console.error('[API] File exists check error:', error);

    const message = error instanceof Error ? error.message : 'Failed to check file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
