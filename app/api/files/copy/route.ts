import { NextRequest } from 'next/server';
import { batchCopy } from '@/app/lib/filesystem/workspace-files';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-copy',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{
      sources?: string[];
      destDir?: string;
      overwrite?: boolean;
      renameOnCollision?: boolean;
    }>(request);
    const { sources, destDir, overwrite = false, renameOnCollision = false } = body;

    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return jsonError('Sources array is required and must not be empty', 400);
    }

    if (!destDir || typeof destDir !== 'string') {
      return jsonError('destDir is required', 400);
    }

    const protectedPaths = sources.filter((p) => isProtectedAppOutputFolder(p));
    if (protectedPaths.length > 0) {
      return jsonError(`Protected app output folder(s) cannot be copied: ${protectedPaths.join(', ')}`, 403);
    }

    const result = await batchCopy(sources, destDir, overwrite, renameOnCollision, fileOptions);

    invalidateWorkspaceFileViews({ subtreeDirs: [destDir] });

    return jsonSuccess({
      copied: result.copied,
      failed: result.failed,
      skipped: result.skipped,
    });
  } catch (error) {
    return jsonServerError('[API] File copy error:', error, 'Failed to copy files');
  }
}
