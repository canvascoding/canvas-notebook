import { NextRequest } from 'next/server';
import { createDirectory, writeFile } from '@/app/lib/filesystem/workspace-files';
import { createEmptyExcalidrawFileContent, isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
  requireApiSession,
} from '@/app/lib/api/route-helpers';

export async function POST(request: NextRequest) {
  const unauthorized = await requireApiSession(request);
  if (unauthorized) return unauthorized;

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-create',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{
      path?: string;
      type?: 'file' | 'directory';
      template?: 'excalidraw';
    }>(request);
    const { path, type, template } = body;

    if (!path || !type) {
      return jsonError('Path and type are required', 400);
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
      return jsonError('Invalid type', 400);
    }

    invalidateWorkspaceFileViews({ fullTree: true });

    return jsonSuccess();
  } catch (error) {
    return jsonServerError('[API] File create error:', error, 'Failed to create path');
  }
}
