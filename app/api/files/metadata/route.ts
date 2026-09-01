import { NextRequest } from 'next/server';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import {
  setWorkspaceFileTitle,
  setWorkspaceFileUserState,
} from '@/app/lib/files/workspace-file-metadata';
import {
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

type MetadataRequest = {
  path?: string;
  title?: string | null;
  isFavorite?: boolean;
  pinned?: boolean;
};

export async function PATCH(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const body = await readJsonBody<MetadataRequest>(request);
    if (!body.path) return jsonError('Path is required', 400);
    if (body.title !== undefined && !workspaceResult.workspace.permissions.canWrite) {
      return jsonError('Workspace write permission is required to update a file title', 403);
    }
    if (body.title === undefined && body.isFavorite === undefined && body.pinned === undefined) {
      return jsonError('At least one metadata field is required', 400);
    }

    await getFileStats(body.path, fileOptions);
    if (body.title !== undefined) {
      await setWorkspaceFileTitle({ workspace: workspaceResult.workspace, path: body.path, title: body.title });
    }
    if (body.isFavorite !== undefined || body.pinned !== undefined) {
      await setWorkspaceFileUserState({
        workspace: workspaceResult.workspace,
        userId: workspaceResult.session.user.id,
        path: body.path,
        update: { isFavorite: body.isFavorite, pinned: body.pinned },
      });
    }
    invalidateWorkspaceFileViews({ fileOptions, fullTree: true, references: false });
    return jsonSuccess();
  } catch (error) {
    return jsonServerError('[API] File metadata update error:', error, 'Failed to update file metadata');
  }
}
