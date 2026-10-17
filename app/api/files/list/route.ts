import { NextRequest, NextResponse } from 'next/server';
import { getCachedWorkspaceReferenceEntries } from '@/app/lib/filesystem/file-reference-cache';
import { parseWorkspaceReferenceQuery, selectWorkspaceReferencePage,
  WorkspaceReferenceQueryError } from '@/app/lib/filesystem/workspace-reference-query';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicShareAnnotations } from '@/app/lib/public-sharing/public-file-shares';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'files-list' });
  if (!limited.ok) return limited.response;

  try {
    const { searchParams } = new URL(request.url);
    const query = parseWorkspaceReferenceQuery(searchParams);
    const entries = await getCachedWorkspaceReferenceEntries(searchParams.has('noCache'), fileOptions);
    const page = selectWorkspaceReferencePage(entries, query, workspaceResult.workspace.workspaceId);
    const limitedFiles = page.files;
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
      total: page.total,
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    if (error instanceof WorkspaceReferenceQueryError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    console.error('[Files List] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to list files' },
      { status: 500 }
    );
  }
}
