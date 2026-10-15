import { NextRequest } from 'next/server';
import {
  metadataFileWriteFailure,
  updateWorkspaceFileMetadata,
} from '@/app/lib/files/workspace-file-metadata';
import {
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function PATCH(request: NextRequest) {
  // Preserve the local constructor identity before crossing an async route boundary.
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  try {
    const body = await readJsonBody<unknown>(request);
    const workspace = await updateWorkspaceFileMetadata(original, body);
    invalidateWorkspaceFileViews({ fileOptions: workspaceFileOptions(workspace), fullTree: true, references: false });
    return jsonSuccess();
  } catch (error) {
    const failure = metadataFileWriteFailure(error);
    if (failure) return jsonError(failure.message, failure.status, { code: failure.code });
    return jsonServerError('[API] File metadata update error:', error, 'Failed to update file metadata');
  }
}
