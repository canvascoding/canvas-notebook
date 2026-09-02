import { NextRequest } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { restoreWorkspaceTrashEntry } from '@/app/lib/filesystem/workspace-trash';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { restoreFileCollaborationPath } from '@/app/lib/files/collaboration-policy';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ entryId: string }> },
) {
  const workspaceResult = await requireRequestWorkspace(request, {
    permissions: ['canWrite', 'canDelete'],
  });
  if (workspaceResult.response) return workspaceResult.response;

  const rateLimitResponse = applyRateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'files-trash-restore',
  });
  if (rateLimitResponse) return rateLimitResponse;

  const { entryId } = await context.params;
  if (!entryId.trim()) return jsonError('Trash entry ID is required', 400);

  try {
    const restored = await restoreWorkspaceTrashEntry({
      workspace: workspaceResult.workspace,
      entryId,
      restoredByUserId: workspaceResult.session.user.id,
    });
    await restoreFileCollaborationPath({
      workspace: workspaceResult.workspace,
      path: restored.originalPath,
      trashEntryId: restored.id,
    });
    const fileOptions = workspaceFileOptions(workspaceResult.workspace);
    invalidateWorkspaceFileViews({
      fileOptions,
      subtreeDirs: [getParentDirectory(restored.originalPath)],
      mutations: [{ path: restored.originalPath, type: 'add' }],
    });

    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: restored.originalPath,
      action: 'file.restore',
      status: 'success',
      summary: `Path restored from trash: ${restored.originalPath}.`,
      metadata: {
        trashEntryId: restored.id,
        workspaceType: workspaceResult.workspace.workspaceType,
      },
    });

    return jsonSuccess({
      restored: {
        id: restored.id,
        originalPath: restored.originalPath,
        itemType: restored.itemType,
        sizeBytes: restored.sizeBytes,
        expiresAt: restored.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restore trashed item';
    if (/not found/i.test(message)) return jsonError(message, 404);
    if (/already exists/i.test(message)) return jsonError(message, 409);
    return jsonServerError('[API] File trash restore error:', error, 'Failed to restore trashed item');
  }
}
