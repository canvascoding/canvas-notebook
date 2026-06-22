import { NextRequest, NextResponse } from 'next/server';
import { readFile, getFileStats } from '@/app/lib/filesystem/workspace-files';
import { sha256Buffer } from '@/app/lib/files/revision-guard';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const READ_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB
const EXCALIDRAW_READ_SIZE_LIMIT = 25 * 1024 * 1024; // embedded image data can make scenes larger

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

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
    
    const stats = await getFileStats(path, fileOptions);
    const sizeLimit = isExcalidrawFilePath(path) ? EXCALIDRAW_READ_SIZE_LIMIT : READ_SIZE_LIMIT;
    const metaOnly = searchParams.get('meta') === '1';

    if (metaOnly) {
      const revisionContent = stats.size <= sizeLimit ? await readFile(path, fileOptions) : null;
      const sha256 = revisionContent ? sha256Buffer(revisionContent) : undefined;
      return NextResponse.json({
        success: true,
        data: {
          path: path,
          content: '',
          stats: {
            size: stats.size,
            modified: stats.modified,
            permissions: stats.permissions,
            sha256,
          },
        },
      });
    }
    
    if (stats.size > sizeLimit) {
        return NextResponse.json(
            { success: false, error: 'File is too large to read' },
            { status: 413 }
        );
    }

    const content = await readFile(path, fileOptions);
    const sha256 = sha256Buffer(content);
    
    return NextResponse.json({
      success: true,
      data: {
        path: path,
        content: content.toString('utf-8'),
        stats: {
          size: stats.size,
          modified: stats.modified,
          permissions: stats.permissions,
          sha256,
        },
      },
    });
  } catch (error) {
    // If the error is ENOENT (file not found), return a 404 status
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    console.error('[API] File read error:', error);
    
    const message = error instanceof Error ? error.message : 'Failed to read file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
