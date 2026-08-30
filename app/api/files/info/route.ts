import path from 'node:path';
import { NextRequest } from 'next/server';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import { enrichWorkspaceFileNodes } from '@/app/lib/files/workspace-file-metadata';
import { jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const filePath = request.nextUrl.searchParams.get('path');
  if (!filePath) return jsonError('Path parameter is required', 400);

  try {
    const stats = await getFileStats(filePath, workspaceFileOptions(workspaceResult.workspace));
    const [file] = await enrichWorkspaceFileNodes({
      nodes: [{
        name: path.posix.basename(filePath),
        path: filePath,
        type: stats.isDirectory ? 'directory' : 'file',
        size: stats.size,
        modified: stats.modified,
        created: stats.created,
        permissions: stats.permissions,
      }],
      workspace: workspaceResult.workspace,
      userId: workspaceResult.session.user.id,
    });
    return jsonSuccess({ data: file });
  } catch (error) {
    return jsonServerError('[API] File info error:', error, 'Failed to load file information');
  }
}
