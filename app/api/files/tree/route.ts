import { NextRequest, NextResponse } from 'next/server';
import { buildFileTree } from '@/app/lib/ssh/sftp-client';
import { fileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'files-tree',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const { searchParams } = new URL(request.url);
    const path = searchParams.get('path') || '.';
    const depth = parseInt(searchParams.get('depth') || '4');
    const noCache = searchParams.has('noCache');

    const cacheKey = `${path}:${depth}`;
    if (!noCache) {
      const cached = fileTreeCache.get(cacheKey);
      if (cached) {
        return NextResponse.json({ success: true, data: cached, cached: true });
      }
    }

    const tree = await buildFileTree(path, depth);
    fileTreeCache.set(cacheKey, tree);

    const headers = new Headers();
    headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate');

    return NextResponse.json({ success: true, data: tree }, { headers });
  } catch (error) {
    // If the directory doesn't exist, it's not a server error, just return an empty tree.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return NextResponse.json({ success: true, data: [] });
    }
    
    console.error('[API] File tree error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load file tree';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
