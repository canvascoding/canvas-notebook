import { NextRequest, NextResponse } from 'next/server';
import { readFile, getFileStats } from '@/app/lib/filesystem/workspace-files';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { auth } from '@/app/lib/auth';

const READ_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: 'files-read',
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
    const metaOnly = searchParams.get('meta') === '1';

    if (metaOnly) {
      return NextResponse.json({
        success: true,
        data: {
          path: path,
          content: '',
          stats: {
            size: stats.size,
            modified: stats.modified,
            permissions: stats.permissions,
          },
        },
      });
    }
    
    if (stats.size > READ_SIZE_LIMIT) {
        return NextResponse.json(
            { success: false, error: 'File is too large to read' },
            { status: 413 }
        );
    }

    const content = await readFile(path);
    
    return NextResponse.json({
      success: true,
      data: {
        path: path,
        content: content.toString('utf-8'),
        stats: {
          size: stats.size,
          modified: stats.modified,
          permissions: stats.permissions,
        },
      },
    });
  } catch (error) {
    console.error('[API] File read error:', error);
    
    // If the error is ENOENT (file not found), return a 404 status
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }
    
    const message = error instanceof Error ? error.message : 'Failed to read file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
