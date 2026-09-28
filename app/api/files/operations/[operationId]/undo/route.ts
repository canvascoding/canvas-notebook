import { NextRequest } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { applyRateLimit, invalidateWorkspaceFileViews, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { getWorkspaceOperationUndoCapability, undoWorkspaceFileOperation } from '@/app/lib/files/workspace-operation-undo-service';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

type RouteContext = { params: Promise<{ operationId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const workspaceResult = await requireRequestWorkspace(request,
    { permissions: ['canRead', 'canWrite', 'canDelete'] });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'workspace-operation-undo-get' });
  if (limited) return limited;
  try {
    const { operationId } = await context.params;
    const undo = await getWorkspaceOperationUndoCapability({ operationId,
      workspace: workspaceResult.workspace, userId: workspaceResult.session.user.id });
    return jsonSuccess({ undo }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonServerError('[API] File operation undo capability error:', error, 'Could not check file operation undo');
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const workspaceResult = await requireRequestWorkspace(request,
    { permissions: ['canRead', 'canWrite', 'canDelete'] });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'workspace-operation-undo-post' });
  if (limited) return limited;
  const { operationId } = await context.params;
  try {
    const undo = await undoWorkspaceFileOperation({ operationId,
      workspace: workspaceResult.workspace, userId: workspaceResult.session.user.id,
      userName: workspaceResult.session.user.name ?? 'Workspace user' });
    if (undo.status === 'applied') {
      invalidateWorkspaceFileViews({ fileOptions: workspaceFileOptions(workspaceResult.workspace),
        subtreeDirs: [...undo.restoredPaths, ...undo.removedPaths].map(getParentDirectory),
        mutations: [...undo.restoredPaths.map((path) => ({ path, type: 'add' as const })),
          ...undo.removedPaths.map((path) => ({ path, type: 'unlink' as const }))] });
    }
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id, source: 'files', eventType: 'file',
      entityType: 'workspace_path', entityId: undo.restoredPaths[0] ?? operationId,
      action: 'file.undo', status: undo.status === 'applied' ? 'success' : 'failure',
      summary: `File operation undo ${undo.status}: ${operationId}.`,
      metadata: { originalOperationId: operationId, undoOperationId: undo.undoOperationId,
        kind: undo.kind, undoStatus: undo.status, restoredPaths: undo.restoredPaths,
        linkStatus: undo.linkStatus, alreadyKnown: undo.alreadyKnown },
    });
    return jsonSuccess({ undo }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id, source: 'files', eventType: 'file',
      entityType: 'workspace_path', entityId: operationId,
      action: 'file.undo', status: 'failure',
      summary: `File operation undo failed: ${operationId}.`,
      metadata: { originalOperationId: operationId,
        errorCode: error && typeof error === 'object' && 'code' in error ? error.code : 'UNDO_FAILED' },
    }).catch(() => undefined);
    if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
      return jsonError(error instanceof Error ? error.message : 'Could not undo file operation', error.status,
        { code: 'code' in error ? error.code : 'UNDO_FAILED' });
    }
    return jsonServerError('[API] File operation undo error:', error, 'Could not undo file operation');
  }
}
