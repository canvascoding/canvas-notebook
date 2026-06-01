import { NextRequest, NextResponse } from 'next/server';
import { createDirectory, writeFile } from '@/app/lib/filesystem/workspace-files';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { invalidateFileReferenceCache } from '@/app/lib/filesystem/file-reference-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { auth } from '@/app/lib/auth';
import { createEmptyExcalidrawFileContent, isExcalidrawFilePath } from '@/app/lib/excalidraw-file';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-create',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = await request.json();
    const { path, type, template } = body as {
      path?: string;
      type?: 'file' | 'directory';
      template?: 'excalidraw';
    };

    if (!path || !type) {
      return NextResponse.json(
        { success: false, error: 'Path and type are required' },
        { status: 400 }
      );
    }

    if (type === 'directory') {
      await createDirectory(path);
    } else if (type === 'file') {
      await writeFile(
        path,
        template === 'excalidraw' || isExcalidrawFilePath(path)
          ? createEmptyExcalidrawFileContent()
          : ''
      );
    } else {
      return NextResponse.json(
        { success: false, error: 'Invalid type' },
        { status: 400 }
      );
    }

    clearFileTreeCache();
    invalidateFileReferenceCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] File create error:', error);
    const message = error instanceof Error ? error.message : 'Failed to create path';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
