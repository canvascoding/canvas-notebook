import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { applyRateLimit, invalidateWorkspaceFileViews, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { initializeCopiedFileCollaborationPaths } from '@/app/lib/files/collaboration-policy';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { withWorkspaceFileLifecycleGuard } from '@/app/lib/files/workspace-file-lifecycle-guard';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import { getWorkspaceOperationBackup, restoreWorkspaceOperationBackup } from '@/app/lib/files/workspace-operation-backup';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

type RouteContext = { params: Promise<{ backupId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'files-operation-backup-get' });
  if (limited) return limited;
  try {
    const { backupId } = await context.params;
    const backup = await getWorkspaceOperationBackup({ workspace: workspaceResult.workspace, backupId });
    return jsonSuccess({ backup: {
      backupId: backup.backupId, operationId: backup.operationId,
      originalPath: backup.originalPath, itemType: backup.itemType,
      capturedAt: backup.capturedAt, retention: backup.retention,
      sizeBytes: backup.sizeBytes, fileCount: backup.fileCount,
      directoryCount: backup.directoryCount, contentSha256: backup.contentSha256,
    } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return jsonError('Backup not found', 404);
    if (error && typeof error === 'object' && 'status' in error) {
      return jsonError(error instanceof Error ? error.message : 'Backup unavailable', 409,
        { code: 'code' in error ? error.code : 'BACKUP_UNAVAILABLE' });
    }
    return jsonServerError('[API] File operation backup read error:', error, 'Could not read backup');
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'files-operation-backup-restore' });
  if (limited) return limited;
  const { backupId } = await context.params;
  const restoreOperationId = randomUUID();
  let targetPath: string | undefined;
  try {
    const rawBody = await request.text();
    let body: { targetPath?: unknown };
    try { body = rawBody.trim() ? JSON.parse(rawBody) as { targetPath?: unknown } : {}; }
    catch { return jsonError('Invalid JSON body', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('Invalid JSON body', 400);
    if (body.targetPath !== undefined && (typeof body.targetPath !== 'string' || !body.targetPath.trim())) {
      return jsonError('targetPath must be a nonempty path', 400);
    }
    targetPath = body.targetPath as string | undefined;
    const backup = await getWorkspaceOperationBackup({ workspace: workspaceResult.workspace, backupId });
    const restoredPath = normalizeWorkspaceRelativePath(targetPath ?? backup.originalPath);
    const restored = await withWorkspaceFileLifecycleGuard({
      workspaceId: workspaceResult.workspace.workspaceId, paths: [restoredPath === '.' ? '' : restoredPath],
    }, () => withWorkspaceMutationLock(workspaceResult.workspace.workspaceId, async () => {
      if (backup.entries.some((entry) => entry.type === 'file'
        && (entry.path === '.' ? backup.originalPath : entry.path).toLowerCase().endsWith('.docx'))) {
        throw Object.assign(new Error('Word documents require the Office restore workflow.'),
          { status: 422, code: 'OFFICE_RESTORE_UNSUPPORTED' });
      }
      const result = await restoreWorkspaceOperationBackup({
        workspace: workspaceResult.workspace, backupId, targetPath,
      });
      await initializeCopiedFileCollaborationPaths({
        workspace: workspaceResult.workspace, paths: [result.restoredPath],
      });
      return result;
    }));
    invalidateWorkspaceFileViews({ fileOptions: workspaceFileOptions(workspaceResult.workspace),
      subtreeDirs: [getParentDirectory(restored.restoredPath)],
      mutations: [{ path: restored.restoredPath, type: 'add' }] });
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id, source: 'files', eventType: 'file',
      entityType: 'workspace_path', entityId: restored.restoredPath,
      action: 'file.restore', status: 'success',
      summary: `Operation backup restored to ${restored.restoredPath}.`,
      metadata: { backupId, restoreOperationId, originalPath: restored.backup.originalPath,
        restoredPath: restored.restoredPath, contentSha256: restored.backup.contentSha256 },
    });
    return jsonSuccess({ restored: {
      backupId, restoreOperationId, originalPath: restored.backup.originalPath,
      restoredPath: restored.restoredPath, contentSha256: restored.backup.contentSha256,
      sizeBytes: restored.backup.sizeBytes,
    } });
  } catch (error) {
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id, source: 'files', eventType: 'file',
      entityType: 'workspace_path', entityId: targetPath ?? backupId,
      action: 'file.restore', status: 'failure',
      summary: `Operation backup restore failed: ${backupId}.`,
      metadata: { backupId, restoreOperationId, targetPath,
        error: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return jsonError('Backup or restore destination not found', 404);
    if (error && typeof error === 'object' && 'status' in error) {
      const status = typeof error.status === 'number' ? error.status : 409;
      return jsonError(error instanceof Error ? error.message : 'Backup restore failed', status,
        { code: 'code' in error ? error.code : 'BACKUP_RESTORE_FAILED', restoreOperationId });
    }
    return jsonServerError('[API] File operation backup restore error:', error, 'Could not restore backup');
  }
}
