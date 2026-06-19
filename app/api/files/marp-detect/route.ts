import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { getFileStats, readFile } from '@/app/lib/filesystem/workspace-files';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const READ_SIZE_LIMIT = 512 * 1024;

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');

    if (!filePath) {
      return NextResponse.json({ success: false, error: 'Path parameter is required' }, { status: 400 });
    }

    const extension = path.extname(filePath).toLowerCase();
    if (!['.md', '.markdown'].includes(extension)) {
      return NextResponse.json({ success: true, isMarp: false });
    }

    const stats = await getFileStats(filePath, fileOptions);
    if (stats.size > READ_SIZE_LIMIT) {
      return NextResponse.json({ success: true, isMarp: isMarpMarkdown(filePath) });
    }

    const content = (await readFile(filePath, fileOptions)).toString('utf-8');
    return NextResponse.json({ success: true, isMarp: isMarpMarkdown(filePath, content) });
  } catch (error) {
    console.error('[API] Marp detect error:', error);

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : 'Failed to inspect Marp file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
