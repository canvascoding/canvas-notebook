import 'server-only';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  type CollaborationLockRecord,
  type FileCollaborationTransaction,
  getRow,
} from './types';

type LockRow = {
  id: string;
  lineage_id: string | null;
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  path: string;
  revision_id: string | null;
  locked_by_user_id: string | null;
  locked_by_session_id: string | null;
  lock_type: CollaborationLockRecord['lockType'];
  status: CollaborationLockRecord['status'];
  expires_at: number;
  created_at: number;
  updated_at: number;
};

function mapLock(row: LockRow): CollaborationLockRecord {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    path: row.path,
    revisionId: row.revision_id,
    lockedByUserId: row.locked_by_user_id,
    lockedBySessionId: row.locked_by_session_id,
    lockType: row.lock_type,
    status: row.status,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function expireFileLocksForPath(
  transaction: FileCollaborationTransaction,
  workspaceId: string,
  filePath: string,
  nowMs: number,
): Promise<void> {
  await transaction.run(`
    UPDATE file_locks
    SET status = 'expired', updated_at = $1
    WHERE workspace_id = $2 AND path = $3 AND status = 'active' AND expires_at <= $1
  `, [nowMs, workspaceId, filePath]);
}

export async function getActiveFileLock(
  transaction: FileCollaborationTransaction,
  workspaceId: string,
  filePath: string,
  nowMs: number,
): Promise<CollaborationLockRecord | null> {
  const row = await getRow<LockRow>(transaction, `
    SELECT *
    FROM file_locks
    WHERE workspace_id = $1 AND path = $2 AND status = 'active' AND expires_at > $3
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `, [workspaceId, filePath, nowMs]);
  return row ? mapLock(row) : null;
}

export async function getFileLockById(
  transaction: FileCollaborationTransaction,
  workspaceId: string,
  lockId: string,
): Promise<CollaborationLockRecord | null> {
  const row = await getRow<LockRow>(transaction, `
    SELECT * FROM file_locks WHERE workspace_id = $1 AND id = $2 LIMIT 1
  `, [workspaceId, lockId]);
  return row ? mapLock(row) : null;
}

export async function insertFileLock(
  transaction: FileCollaborationTransaction,
  params: Omit<CollaborationLockRecord, 'status' | 'createdAt' | 'updatedAt'> & { nowMs: number },
): Promise<CollaborationLockRecord> {
  const row = await getRow<LockRow>(transaction, `
    INSERT INTO file_locks (
      id, organization_id, customer_id, project_id, workspace_id, workspace_type,
      path, lineage_id, revision_id, locked_by_user_id, locked_by_session_id,
      lock_type, status, expires_at, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13, $14, $14)
    RETURNING *
  `, [
    params.id,
    params.organizationId,
    params.customerId,
    params.projectId,
    params.workspaceId,
    params.workspaceType,
    params.path,
    params.lineageId,
    params.revisionId,
    params.lockedByUserId,
    params.lockedBySessionId,
    params.lockType,
    params.expiresAt,
    params.nowMs,
  ]);
  if (!row) throw new Error(`Failed to create active lock for ${params.path}.`);
  return mapLock(row);
}

export async function refreshFileLock(
  transaction: FileCollaborationTransaction,
  lockId: string,
  expiresAt: number,
  nowMs: number,
): Promise<CollaborationLockRecord | null> {
  const row = await getRow<LockRow>(transaction, `
    UPDATE file_locks
    SET expires_at = $1, updated_at = $2
    WHERE id = $3 AND status = 'active'
    RETURNING *
  `, [expiresAt, nowMs, lockId]);
  return row ? mapLock(row) : null;
}

export async function updateFileLockStatus(
  transaction: FileCollaborationTransaction,
  lockId: string,
  status: Exclude<CollaborationLockRecord['status'], 'active'>,
  nowMs: number,
): Promise<CollaborationLockRecord | null> {
  const row = await getRow<LockRow>(transaction, `
    UPDATE file_locks
    SET status = $1, updated_at = $2
    WHERE id = $3 AND status = 'active'
    RETURNING *
  `, [status, nowMs, lockId]);
  return row ? mapLock(row) : null;
}
