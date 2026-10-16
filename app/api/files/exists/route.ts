import { NextRequest, NextResponse } from 'next/server';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { withNativeWorkspaceFileRead, type NativeWorkspaceFileRead } from '@/app/lib/collaboration/workspace-native-file-read';
import { collaborationCheckpointValidationFailure } from '@/app/lib/collaboration/checkpoint-errors';
import { isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { assertWorkspacePathHasNoAliases, normalizeWorkspaceRelativePath, WorkspacePathAliasError } from '@/app/lib/workspaces/path-guard';

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const limited = rateLimit(request, {
      limit: 240,
      windowMs: 60_000,
      keyPrefix: 'files-exists',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const { searchParams } = new URL(request.url);
    const requestedPath = searchParams.get('path');

    if (!requestedPath) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const filePath = isCanonicalAdmissionPath(requestedPath) ? requestedPath : normalizeWorkspaceRelativePath(requestedPath);
    const respond = async (native: NativeWorkspaceFileRead | null) => {
      if (native) {
        const modified = native.modifiedAt !== null && Number.isFinite(new Date(native.modifiedAt).getTime())
          ? Math.floor(native.modifiedAt / 1000) : undefined;
        return NextResponse.json({ success: true, data: { exists: true, path: filePath, type: 'file', isDirectory: false, isFile: true,
          stats: { ...(modified === undefined ? {} : { modified }) } } });
      }
      // A missing projection never means a missing native document. Only an
      // explicitly pristine/unregistered path may use physical existence.
      if (normalizeWorkspaceRelativePath(filePath) !== filePath) throw new WorkspacePathAliasError();
      await assertWorkspacePathHasNoAliases(workspaceResult.workspace, filePath, { readOnly: true });
      const stats = await getFileStats(filePath, fileOptions);
      return NextResponse.json({
        success: true,
        data: {
          exists: true,
          path: filePath,
          type: stats.isDirectory ? 'directory' : 'file',
          isDirectory: stats.isDirectory,
          isFile: stats.isFile,
          stats: {
            size: stats.size,
            modified: stats.modified,
            permissions: stats.permissions,
          },
        },
      });
    };
    if (filePath === '.') return await respond(null);
    return await withNativeWorkspaceFileRead({ workspace: workspaceResult.workspace, path: filePath, mode: 'metadata' }, respond);
  } catch (error) {
    const validation = collaborationCheckpointValidationFailure(error);
    if (validation) return NextResponse.json({ success: false, error: validation.message, code: validation.code }, { status: validation.status });
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return NextResponse.json({
        success: true,
        data: {
          exists: false,
        },
      });
    }

    if (error instanceof Error && 'status' in error && typeof error.status === 'number' && [400, 403, 409].includes(error.status)) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }

    console.error('[API] File exists check error:', error);

    const message = error instanceof Error ? error.message : 'Failed to check file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
