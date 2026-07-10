import { NextRequest, NextResponse } from 'next/server';
import { getCachedFileReferenceEntries } from '@/app/lib/filesystem/file-reference-cache';
import { searchFileReferenceEntries } from '@/app/lib/filesystem/file-reference-search';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicShareAnnotations } from '@/app/lib/public-sharing/public-file-shares';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const MAX_SEARCH_LIMIT = 500;

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'files-list' });
  if (!limited.ok) return limited.response;

  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim().toLowerCase().slice(0, 256);
    const rawLimit = searchParams.get('limit') || '50';
    if (!/^\d+$/.test(rawLimit)) {
      return NextResponse.json({ success: false, error: 'limit must be a positive integer' }, { status: 400 });
    }
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      return NextResponse.json(
        { success: false, error: `limit must be between 1 and ${MAX_SEARCH_LIMIT}` },
        { status: 400 },
      );
    }
    
    const allFiles = await getCachedFileReferenceEntries(false, fileOptions);

    const filteredFiles = searchFileReferenceEntries(allFiles, query);
    
    // Apply limit
    const limitedFiles = filteredFiles.slice(0, limit);
    const annotations = await getPublicShareAnnotations(
      limitedFiles.filter((file) => file.type === 'file').map((file) => file.path),
      null,
      workspaceResult.workspace,
    );
    const filesWithShareState = limitedFiles.map((file) => ({
      ...file,
      publicShare: annotations.get(file.path),
    }));

    return NextResponse.json({
      success: true,
      files: filesWithShareState,
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
