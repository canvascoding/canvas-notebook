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

    const cacheKey = `${path}:${depth}`;
    const cached = fileTreeCache.get(cacheKey);
    if (cached) {
      return NextResponse.json({ success: true, data: cached, cached: true });
    }

    const tree = await buildFileTree(path, depth);
    fileTreeCache.set(cacheKey, tree);

    return NextResponse.json({ success: true, data: tree });
  } catch (error) {
    console.error('[API] File tree error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load file tree';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
