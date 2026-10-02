import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import type { WorkspaceOperationCheckPublic, WorkspaceOperationCheckStatus } from './workspace-operation-check-contract';

export type WorkspaceOperationCheckRecord = WorkspaceOperationCheckPublic & { requesterUserId: string; leaseOwner: string | null };
const record = (row: Record<string, unknown>): WorkspaceOperationCheckRecord => ({
  checkId: String(row.check_id), workspaceId: String(row.workspace_id), requesterUserId: String(row.requester_user_id),
  reviewIds: JSON.parse(String(row.review_ids_json)), status: row.status as WorkspaceOperationCheckStatus,
  batchId: row.batch_id == null ? null : String(row.batch_id), errorCode: row.error_code == null ? null : String(row.error_code),
  leaseOwner: row.lease_owner == null ? null : String(row.lease_owner), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
});

export class WorkspaceOperationCheckStore {
  constructor(private readonly connect: () => Promise<SqlConnection> = openDb, private readonly now = Date.now) {}
  private async query(sql: string, params: unknown[]): Promise<WorkspaceOperationCheckRecord | null> {
    const db = await this.connect();
    try { const row = await db.get(sql, params); return row ? record(row as Record<string, unknown>) : null; }
    finally { await db.close(); }
  }
  async get(checkId: string): Promise<WorkspaceOperationCheckRecord | null> {
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(checkId)) return null;
    return this.query('SELECT * FROM workspace_file_operation_checks WHERE check_id=$1', [checkId]);
  }
  async enqueue(input: { workspaceId: string; requesterUserId: string; reviewIds: string[] }): Promise<WorkspaceOperationCheckRecord> {
    const reviewIds = [...input.reviewIds].sort();
    const selectionKey = createHash('sha256').update(JSON.stringify(reviewIds)).digest('hex');
    const created = await this.query(`INSERT INTO workspace_file_operation_checks
      (check_id,workspace_id,requester_user_id,review_ids_json,selection_key,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'queued',$6,$6) ON CONFLICT (workspace_id,requester_user_id,selection_key)
      WHERE status IN ('queued','checking') DO UPDATE SET selection_key=EXCLUDED.selection_key RETURNING *`,
    [randomUUID(), input.workspaceId, input.requesterUserId, JSON.stringify(reviewIds), selectionKey, this.now()]);
    return created!;
  }
  async claim(owner: string): Promise<WorkspaceOperationCheckRecord | null> {
    const now = this.now();
    return this.query(`UPDATE workspace_file_operation_checks AS job SET status='checking',lease_owner=$1,
      lease_expires_at=$2,updated_at=$3 FROM (
        SELECT candidate.check_id FROM workspace_file_operation_checks candidate
        WHERE (candidate.status='queued' OR candidate.status='checking' AND candidate.lease_expires_at <= $3)
        AND NOT EXISTS (SELECT 1 FROM workspace_file_operation_checks active
          WHERE active.workspace_id=candidate.workspace_id AND active.check_id<>candidate.check_id
          AND active.status='checking' AND active.lease_expires_at > $3)
        ORDER BY candidate.created_at,candidate.check_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) AS candidate WHERE job.check_id=candidate.check_id RETURNING job.*`, [owner, now + 90_000, now]);
  }
  async heartbeat(checkId: string, owner: string): Promise<boolean> {
    const now = this.now();
    return Boolean(await this.query(`UPDATE workspace_file_operation_checks SET lease_expires_at=$3
      WHERE check_id=$1 AND lease_owner=$2 AND status='checking' AND lease_expires_at > $4 RETURNING *`,
    [checkId, owner, now + 90_000, now]));
  }
  async finish(checkId: string, owner: string, input: { status: 'ready' | 'blocked' | 'failed'; batchId?: string; errorCode?: string }): Promise<boolean> {
    return Boolean(await this.query(`UPDATE workspace_file_operation_checks SET status=$3,batch_id=$4,error_code=$5,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=$6
      WHERE check_id=$1 AND lease_owner=$2 AND status='checking' AND lease_expires_at > $6 RETURNING *`,
    [checkId, owner, input.status, input.batchId ?? null, input.errorCode ?? null, this.now()]));
  }
}
