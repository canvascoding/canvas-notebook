import { NextRequest, NextResponse } from 'next/server';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

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

    const stats = await getFileStats(path, fileOptions);

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
