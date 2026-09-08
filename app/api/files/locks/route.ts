import { NextRequest } from 'next/server';
import { WorkspacePathAliasError } from '@/app/lib/workspaces/path-guard';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  FileCollaborationPolicyError,
  acquireFileLock,
  getFileCollaborationState,
  releaseFileLock,
  renewFileLock,
  type FileLockType,
} from '@/app/lib/files/collaboration-policy';
import {
  applyRateLimit,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

function isFileLockType(value: unknown): value is FileLockType {
  return value === 'edit' || value === 'upload' || value === 'agent_write';
}

function collaborationPolicyError(error: FileCollaborationPolicyError) {
  return jsonError(error.message, error.status, {
    code: error.code,
    path: error.path,
    currentRevisionId: error.currentRevisionId,
    baseRevisionId: error.baseRevisionId,
    activeLock: error.activeLock,
  });
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: 'files-locks-read',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const path = request.nextUrl.searchParams.get('path')?.trim();
    if (!path) return jsonError('Path parameter is required', 400);

    return jsonSuccess({
      data: await getFileCollaborationState({
        workspace: workspaceResult.workspace,
        path,
      }),
    });
  } catch (error) {
    if (error instanceof WorkspacePathAliasError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] File lock state error:', error, 'Failed to read file lock state');
  }
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'files-locks-acquire',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{
      path?: string;
      lockType?: string;
      ttlMs?: number;
      baseRevisionId?: string | null;
      sessionId?: string;
    }>(request);
    if (!body.path) return jsonError('Path is required', 400);
    if (body.sessionId !== undefined && !validSessionId(body.sessionId)) return jsonError('Invalid editor session', 400);
    const lockType = isFileLockType(body.lockType) ? body.lockType : 'edit';

    const result = await acquireFileLock({
      workspace: workspaceResult.workspace,
      path: body.path,
      lockedByUserId: workspaceResult.session.user.id,
      lockedBySessionId: body.sessionId ?? null,
      lockType,
      ttlMs: body.ttlMs,
      baseRevisionId: body.baseRevisionId ?? null,
    });

    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      customerId: workspaceResult.workspace.customerId,
      projectId: workspaceResult.workspace.projectId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: body.path,
      action: 'file.lock.acquire',
      status: 'success',
      summary: `File lock acquired for ${body.path}.`,
      metadata: {
        path: body.path,
        lockId: result.lock.id,
        lockType,
        expiresAt: result.lock.expiresAt,
      },
    });

    return jsonSuccess({ data: result });
  } catch (error) {
    if (error instanceof WorkspacePathAliasError) return jsonError(error.message, error.status, { code: error.code });
    if (error instanceof FileCollaborationPolicyError) return collaborationPolicyError(error);
    return jsonServerError('[API] File lock acquire error:', error, 'Failed to acquire file lock');
  }
}

export async function DELETE(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'files-locks-release',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{
      path?: string;
      lockId?: string;
      force?: boolean;
      sessionId?: string;
    }>(request);
    if (!body.path && !body.lockId) return jsonError('Path or lockId is required', 400);
    if (body.sessionId !== undefined && !validSessionId(body.sessionId)) return jsonError('Invalid editor session', 400);

    if (body.force && !workspaceResult.workspace.permissions.canManageWorkspace) {
      return jsonError('Only workspace managers can force release file locks', 403);
    }

    const lock = await releaseFileLock({
      workspace: workspaceResult.workspace,
      path: body.path,
      lockId: body.lockId,
      actorUserId: workspaceResult.session.user.id,
      actorSessionId: body.sessionId ?? null,
      force: Boolean(body.force),
    });

    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      customerId: workspaceResult.workspace.customerId,
      projectId: workspaceResult.workspace.projectId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: lock.path,
      action: body.force ? 'file.lock.force_release' : 'file.lock.release',
      status: 'success',
      summary: `File lock released for ${lock.path}.`,
      metadata: {
        path: lock.path,
        lockId: lock.id,
        lockType: lock.lockType,
        finalStatus: lock.status,
      },
    });

    return jsonSuccess({ data: { lock } });
  } catch (error) {
    if (error instanceof WorkspacePathAliasError) return jsonError(error.message, error.status, { code: error.code });
    if (error instanceof FileCollaborationPolicyError) return collaborationPolicyError(error);
    return jsonServerError('[API] File lock release error:', error, 'Failed to release file lock');
  }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}

export async function PATCH(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  try {
    const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'files-locks-renew' });
    if (limited) return limited;
    const body = await readJsonBody<{ path?: string; sessionId?: string; lockId?: string; ttlMs?: number }>(request);
    if (!body.path || !body.lockId || !validSessionId(body.sessionId)) return jsonError('Path, lease and editor session are required', 400);
    return jsonSuccess({ data: await renewFileLock({
      workspace: workspaceResult.workspace, path: body.path,
      actorUserId: workspaceResult.session.user.id, actorSessionId: body.sessionId,
      lockId: body.lockId, ttlMs: body.ttlMs,
    }) });
  } catch (error) {
    if (error instanceof WorkspacePathAliasError) return jsonError(error.message, error.status, { code: error.code });
    if (error instanceof FileCollaborationPolicyError) return collaborationPolicyError(error);
    return jsonServerError('[API] File lock renewal error:', error, 'Failed to renew document lease');
  }
}
