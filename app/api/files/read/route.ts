import { NextRequest, NextResponse } from 'next/server';
import { readFile, getFileStats } from '@/app/lib/ssh/sftp-client';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getSession } from '@/app/lib/auth/session';

export async function GET(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'files-read',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const session = await getSession();
    if (!session.isLoggedIn) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const path = searchParams.get('path');

    if (!path) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const metaOnly = searchParams.get('meta') === '1';
    const stats = await getFileStats(path);
    const contentString = metaOnly ? '' : (await readFile(path)).toString('utf-8');

    return NextResponse.json({
      success: true,
      data: {
        content: contentString,
        stats: {
          size: stats.size,
          modified: stats.modified,
          permissions: stats.permissions,
        },
      },
    });
  } catch (error) {
    console.error('[API] File read error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
