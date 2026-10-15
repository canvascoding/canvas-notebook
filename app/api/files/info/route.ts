import path from 'node:path';
import { NextRequest } from 'next/server';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import { enrichWorkspaceFileNodes } from '@/app/lib/files/workspace-file-metadata';
import { jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { withNativeWorkspaceFileRead, type NativeWorkspaceFileRead } from '@/app/lib/collaboration/workspace-native-file-read';
import { collaborationCheckpointValidationFailure } from '@/app/lib/collaboration/checkpoint-errors';
import { assertWorkspacePathHasNoAliases, normalizeWorkspaceRelativePath, WorkspacePathAliasError } from '@/app/lib/workspaces/path-guard';
import { isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import type { FileNode } from '@/app/lib/files/types';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const requestedPath = request.nextUrl.searchParams.get('path');
  if (!requestedPath) return jsonError('Path parameter is required', 400);

  try {
    // Already canonical registry paths may contain meaningful filename spaces.
    const filePath = isCanonicalAdmissionPath(requestedPath) ? requestedPath : normalizeWorkspaceRelativePath(requestedPath);
    const respond = async (native: NativeWorkspaceFileRead | null) => {
      let node: FileNode;
      if (native) {
        const modified = native.modifiedAt !== null && Number.isFinite(new Date(native.modifiedAt).getTime())
          ? Math.floor(native.modifiedAt / 1000) : undefined;
        node = { name: path.posix.basename(filePath), path: filePath, type: 'file',
          ...(modified === undefined ? {} : { modified }),
          metadataTarget: { version: 1, kind: 'native_file', workspaceId: workspaceResult.workspace.workspaceId,
            path: filePath, documentId: native.documentId, lifecycleGeneration: native.lifecycleGeneration } };
      } else {
        // An alias must not expose an initialized document's old projection
        // through a different catalogue path. Native-only files need no disk.
        if (filePath !== filePath.trim()) throw new WorkspacePathAliasError();
        await assertWorkspacePathHasNoAliases(workspaceResult.workspace, filePath, { readOnly: true });
        const stats = await getFileStats(filePath, workspaceFileOptions(workspaceResult.workspace));
        if (filePath === '.' && !stats.isDirectory) throw new Error('The workspace root is not a directory.');
        node = { name: path.posix.basename(filePath), path: filePath,
          type: stats.isDirectory ? 'directory' : 'file', size: stats.size, modified: stats.modified,
          created: stats.created, permissions: stats.permissions,
          ...(filePath !== '.' && (stats.isFile || stats.isDirectory) ? {
            metadataTarget: { version: 1 as const, kind: 'filesystem' as const,
              workspaceId: workspaceResult.workspace.workspaceId, path: filePath, fileVersion: stats.fileVersion,
              entryType: stats.isDirectory ? 'directory' as const : 'file' as const },
          } : {}) };
      }
      // Root has no file-title database identity. Directory sizes here retain
      // the physical contract; native namespace aggregates require a separate reader.
      const [file] = filePath === '.' ? [node] : await enrichWorkspaceFileNodes({
        nodes: [node], workspace: workspaceResult.workspace, userId: workspaceResult.session.user.id,
      });
      return jsonSuccess({ data: file }, { headers: { 'Cache-Control': 'no-store' } });
    };
    if (filePath === '.') return await respond(null);
    // Registry authority precedes suffix dispatch, including a native document
    // renamed to .docx. Unregistered Office files retain their physical metadata.
    return await withNativeWorkspaceFileRead({ workspace: workspaceResult.workspace, path: filePath, mode: 'metadata' }, respond);
  } catch (error) {
    const validation = collaborationCheckpointValidationFailure(error);
    if (validation) return jsonError(validation.message, validation.status, { code: validation.code, validationCode: validation.validationCode });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return jsonError('File not found', 404);
    if (error instanceof Error && 'status' in error && typeof error.status === 'number' && [400, 403, 409].includes(error.status)) {
      return jsonError(error.message, error.status);
    }
    return jsonServerError('[API] File info error:', error, 'Failed to load file information');
  }
}
