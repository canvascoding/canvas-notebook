import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getCachedFileReferenceEntries } from '@/app/lib/filesystem/file-reference-cache';
import { searchFileReferenceEntries } from '@/app/lib/filesystem/file-reference-search';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'files-list' });
  if (!limited.ok) return limited.response;

  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.toLowerCase() || '';
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    
    const allFiles = await getCachedFileReferenceEntries();

    const filteredFiles = searchFileReferenceEntries(allFiles, query);
    
    // Apply limit
    const limitedFiles = filteredFiles.slice(0, limit);

    return NextResponse.json({
      success: true,
      files: limitedFiles,
      total: filteredFiles.length,
    });
  } catch (error) {
    console.error('[Files List] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to list files' },
      { status: 500 }
    );
  }
}
