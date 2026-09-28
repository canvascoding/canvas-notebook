import { NextRequest } from 'next/server';

import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { listWorkspaceOperationBackups } from '@/app/lib/files/workspace-operation-backup';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000,
    keyPrefix: 'files-operation-backup-list' });
  if (limited) return limited;

  const rawLimit = request.nextUrl.searchParams.get('limit');
  const rawCursor = request.nextUrl.searchParams.get('cursor');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return jsonError('limit must be an integer between 1 and 100', 400);
  }
  try {
    const result = await listWorkspaceOperationBackups({
      workspace: workspaceResult.workspace, limit, cursor: rawCursor ?? undefined,
    });
    return jsonSuccess(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      return jsonError(error instanceof Error ? error.message : 'Backup list unavailable', 400,
        { code: 'code' in error ? error.code : 'BACKUP_LIST_INVALID' });
    }
    return jsonServerError('[API] File operation backup list error:', error, 'Could not list backups');
  }
}
