import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import type { WorkspaceOperationBatchAuthorization, WorkspaceOperationDirectAuthorization,
  WorkspaceOperationBatchPlan, WorkspaceOperationBatchProgress } from './workspace-operation-batch-contract';

export type WorkspaceOperationBatchStatus = 'preview' | 'blocked' | 'queued' | 'applying' | 'applied'
  | 'needs_review' | 'needs_recovery' | 'failed' | 'undone';
export type WorkspaceOperationBatchReviewRef = { reviewId: string; planId: string; status: string };
export type WorkspaceOperationBatchRecord = {
  batchId: string; planId: string; workspaceId: string; reviewIds: string[];
  reviewRefs: WorkspaceOperationBatchReviewRef[]; plan: WorkspaceOperationBatchPlan;
  authorization: WorkspaceOperationBatchAuthorization;
  status: WorkspaceOperationBatchStatus; actionMode: 'apply' | 'undo';
  reviewerUserId: string | null; reviewerDisplayName: string | null;
  completedActions: number; totalActions: number; phase: WorkspaceOperationBatchProgress['phase'];
  errorCode: string | null; trashEntryIds: string[]; leaseOwner: string | null;
  createdAt: number; updatedAt: number;
};

export class WorkspaceOperationBatchError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message); this.name = 'WorkspaceOperationBatchError';
  }
}

function authorization(value: unknown): WorkspaceOperationBatchAuthorization {
  if (value === undefined || value === null) return { mode: 'review' };
  const parsed = JSON.parse(String(value)) as WorkspaceOperationBatchAuthorization;
  if (parsed?.mode === 'review') return { mode: 'review' };
  if (parsed?.mode !== 'direct' || ![parsed.actorUserId, parsed.actorId, parsed.actorDisplayName]
    .every((field) => typeof field === 'string' && field.trim().length > 0)
    || !['user', 'agent'].includes(parsed.actorType) || typeof parsed.requestHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(parsed.requestHash)
    || parsed.actorType === 'agent' && (typeof parsed.actorSessionId !== 'string' || !parsed.actorSessionId.trim())) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'File action authorization is unavailable.');
  }
  return parsed;
}

export function workspaceOperationBatchAuthorityUserId(batch: WorkspaceOperationBatchRecord): string | null {
  return batch.authorization?.mode === 'direct' ? batch.authorization.actorUserId : batch.reviewerUserId;
}

function record(row: Record<string, unknown>): WorkspaceOperationBatchRecord {
  return {
    batchId: String(row.batch_id), planId: String(row.plan_id), workspaceId: String(row.workspace_id),
    reviewIds: JSON.parse(String(row.review_ids_json)), reviewRefs: JSON.parse(String(row.review_refs_json)),
    authorization: authorization(row.authorization_json),
    plan: JSON.parse(String(row.plan_json)), status: row.status as WorkspaceOperationBatchStatus,
    actionMode: row.action_mode as 'apply' | 'undo', reviewerUserId: row.reviewer_user_id == null ? null : String(row.reviewer_user_id),
    reviewerDisplayName: row.reviewer_display_name == null ? null : String(row.reviewer_display_name),
    completedActions: Number(row.completed_actions), totalActions: Number(row.total_actions),
    phase: row.phase as WorkspaceOperationBatchProgress['phase'], errorCode: row.error_code == null ? null : String(row.error_code),
    trashEntryIds: JSON.parse(String(row.trash_entry_ids_json)), leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** SQL leases select work; the executor additionally owns the kernel workspace mutation lock. */
export class WorkspaceOperationBatchStore {
  constructor(private readonly connect: () => Promise<SqlConnection> = openDb, private readonly now = Date.now) {}

  private async query(sql: string, params: unknown[]): Promise<WorkspaceOperationBatchRecord | null> {
    const db = await this.connect();
    try { const row = await db.get(sql, params); return row ? record(row as Record<string, unknown>) : null; }
    finally { await db.close(); }
  }

  async get(batchId: string): Promise<WorkspaceOperationBatchRecord | null> {
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(batchId)) return null;
    return this.query('SELECT * FROM workspace_file_operation_batches WHERE batch_id = $1', [batchId]);
  }

  async create(input: { batchId: string; plan: WorkspaceOperationBatchPlan; reviewRefs: WorkspaceOperationBatchReviewRef[] }): Promise<WorkspaceOperationBatchRecord> {
    const result = await this.query(`INSERT INTO workspace_file_operation_batches
      (batch_id,plan_id,workspace_id,review_ids_json,review_refs_json,plan_json,status,total_actions,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
    [input.batchId, input.plan.planId, input.plan.workspaceId, JSON.stringify(input.reviewRefs.map((ref) => ref.reviewId)),
      JSON.stringify(input.reviewRefs), JSON.stringify(input.plan), input.plan.readiness === 'ready' ? 'preview' : 'blocked',
      input.plan.pathSteps.length + input.plan.previewContents.length, this.now()]);
    return result!;
  }

  async createDirect(input: { batchId: string; plan: WorkspaceOperationBatchPlan;
    authorization: WorkspaceOperationDirectAuthorization }): Promise<WorkspaceOperationBatchRecord> {
    if (authorization(JSON.stringify(input.authorization)).mode !== 'direct') {
      throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'Direct file action authorization is required.');
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(input.batchId)) {
      throw new WorkspaceOperationBatchError('BATCH_INVALID_ID', 422, 'Invalid file action identity.');
    }
    const result = await this.query(`INSERT INTO workspace_file_operation_batches
      (batch_id,plan_id,workspace_id,review_ids_json,review_refs_json,plan_json,authorization_json,
       status,error_code,total_actions,created_at,updated_at)
      VALUES ($1,$2,$3,'[]','[]',$4,$5,$6,$7,$8,$9,$9)
      ON CONFLICT (batch_id) DO NOTHING RETURNING *`,
    [input.batchId, input.plan.planId, input.plan.workspaceId, JSON.stringify(input.plan), JSON.stringify(input.authorization),
      input.plan.readiness === 'ready' ? 'queued' : 'blocked', input.plan.readiness === 'ready' ? null : 'PREVIEW_BLOCKED',
      input.plan.pathSteps.length + input.plan.previewContents.length, this.now()]);
    if (result) return result;
    const existing = await this.get(input.batchId);
    if (!existing || existing.workspaceId !== input.plan.workspaceId || existing.authorization.mode !== 'direct'
      || existing.authorization.actorUserId !== input.authorization.actorUserId
      || existing.authorization.actorId !== input.authorization.actorId
      || existing.authorization.actorType !== input.authorization.actorType
      || existing.authorization.actorSessionId !== input.authorization.actorSessionId
      || existing.authorization.requestHash !== input.authorization.requestHash) {
      throw new WorkspaceOperationBatchError('BATCH_IDEMPOTENCY_CONFLICT', 409, 'This file action identity belongs to another request.');
    }
    return existing;
  }

  async enqueue(input: { batchId: string; planId: string; userId: string; displayName: string;
    action?: 'accept' | 'resume' | 'undo' }): Promise<WorkspaceOperationBatchRecord> {
    const action = input.action ?? 'accept';
    return executeLifecycleTransaction({ openConnection: this.connect, execute: async (db) => {
      const row = await db.get('SELECT * FROM workspace_file_operation_batches WHERE batch_id = $1 FOR UPDATE', [input.batchId]);
      if (!row) throw new WorkspaceOperationBatchError('BATCH_NOT_FOUND', 404, 'File action batch not found.');
      const batch = record(row as Record<string, unknown>);
      if (batch.planId !== input.planId) throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409, 'The exact batch plan is required.');
      const direct = batch.authorization.mode === 'direct';
      const authorityUserId = workspaceOperationBatchAuthorityUserId(batch);
      if (direct && (action === 'accept' || authorityUserId !== input.userId)) {
        throw new WorkspaceOperationBatchError('BATCH_DIRECT_AUTHORIZATION_REQUIRED', 403,
          'Only the initiating user can resume or undo this direct file action.');
      }
      if (action === 'resume' && authorityUserId !== input.userId) {
        throw new WorkspaceOperationBatchError('BATCH_RESUME_REVIEWER_REQUIRED', 403,
          'Only the reviewer who approved this job can resume it. Their current workspace permissions are still required.');
      }
      if (['queued', 'applying'].includes(batch.status)) {
        const expectedMode = action === 'undo' ? 'undo' : action === 'accept' ? 'apply' : batch.actionMode;
        if (authorityUserId !== input.userId || expectedMode !== batch.actionMode) {
          throw new WorkspaceOperationBatchError('BATCH_CONFLICT', 409, 'The batch is already assigned to another accepted action.');
        }
        return batch;
      }
      if (action === 'accept' && batch.status === 'applied' || action === 'undo' && batch.status === 'undone') return batch;
      if (action === 'resume' && ['applied', 'undone'].includes(batch.status)) return batch;
      const allowed = action === 'accept' ? ['preview'] : action === 'undo' ? ['applied'] : ['needs_recovery', 'failed'];
      if (!allowed.includes(batch.status)) throw new WorkspaceOperationBatchError('BATCH_CONFLICT', 409, 'This batch requires a fresh preview before approval.');
      if (action === 'accept') {
        for (const ref of batch.reviewRefs) {
          const reviewed = await db.get(`SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1 FOR UPDATE`, [ref.reviewId]) as Record<string, unknown> | undefined;
          if (!reviewed || reviewed.plan_id !== ref.planId || reviewed.source_workspace_id !== batch.workspaceId
            || reviewed.successor_review_id || reviewed.batch_id
            || !['pending', 'stale', 'blocked'].includes(String(reviewed.status))) {
            throw new WorkspaceOperationBatchError('REVIEW_CONFLICT', 409, 'A selected review changed before approval.');
          }
          await db.run(`UPDATE workspace_file_operation_reviews SET status = 'queued', batch_id = $2,
            operation_id = $2, reviewer_user_id = $3, revision = revision + 1, updated_at = $4 WHERE review_id = $1`,
          [ref.reviewId, batch.batchId, input.userId, this.now()]);
        }
      }
      const updated = await db.get(`UPDATE workspace_file_operation_batches SET status = 'queued',
        reviewer_user_id = $2, reviewer_display_name = $3, action_mode = $4,
        lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = $5,
        completed_actions = CASE WHEN $6 THEN 0 ELSE completed_actions END,
        phase = CASE WHEN $6 THEN 'preparing' ELSE phase END
        WHERE batch_id = $1 RETURNING *`,
      [input.batchId, direct ? null : input.userId,
        direct ? null : action === 'resume' ? batch.reviewerDisplayName ?? input.displayName : input.displayName,
        action === 'undo' ? 'undo' : batch.actionMode, this.now(), action === 'undo']);
      return record(updated as Record<string, unknown>);
    }, recoverCommitted: async (value, commitError) => {
      const persisted = await this.get(value.batchId);
      if (persisted?.planId === value.planId && workspaceOperationBatchAuthorityUserId(persisted) === input.userId
        && ['queued', 'applying', 'applied', 'undone'].includes(persisted.status)) return persisted;
      throw new WorkspaceOperationBatchError('BATCH_COMMIT_UNCONFIRMED', 503,
        commitError instanceof Error ? commitError.message : 'Batch approval could not be confirmed. Retry the same approval.');
    } });
  }

  async claim(owner: string, leaseMs = 90_000): Promise<WorkspaceOperationBatchRecord | null> {
    const now = this.now();
    const batch = await this.query(`UPDATE workspace_file_operation_batches AS batch SET status = 'applying',
      lease_owner = $1, lease_expires_at = $2, updated_at = $3 FROM (
        SELECT candidate.batch_id FROM workspace_file_operation_batches candidate
        WHERE (candidate.status = 'queued' OR candidate.status = 'applying' AND candidate.lease_expires_at <= $3)
          AND NOT EXISTS (SELECT 1 FROM workspace_file_operation_batches earlier
            WHERE earlier.workspace_id = candidate.workspace_id AND earlier.batch_id <> candidate.batch_id
              AND (earlier.status = 'applying' OR earlier.status = 'queued'
                AND (earlier.created_at,earlier.batch_id) < (candidate.created_at,candidate.batch_id)))
        ORDER BY candidate.created_at,candidate.batch_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) AS candidate WHERE batch.batch_id = candidate.batch_id RETURNING batch.*`, [owner, now + leaseMs, now]);
    if (batch) {
      const db = await this.connect();
      try {
        await db.run(`UPDATE workspace_file_operation_reviews SET status = 'applying',
          revision = revision + 1, updated_at = $3 WHERE batch_id = $1 AND status = 'queued'
          AND EXISTS (SELECT 1 FROM workspace_file_operation_batches WHERE batch_id = $1 AND lease_owner = $2 AND status = 'applying')`,
        [batch.batchId, owner, now]);
      } finally { await db.close(); }
    }
    return batch;
  }

  async heartbeat(batchId: string, owner: string, progress?: WorkspaceOperationBatchProgress): Promise<boolean> {
    const now = this.now();
    const batch = await this.query(`UPDATE workspace_file_operation_batches SET lease_expires_at = $3,
      updated_at = $4, completed_actions = COALESCE($5,completed_actions), phase = COALESCE($6,phase)
      WHERE batch_id = $1 AND lease_owner = $2 AND status = 'applying' RETURNING *`,
    [batchId, owner, now + 90_000, now, progress?.completedActions ?? null, progress?.phase ?? null]);
    return Boolean(batch);
  }

  async finish(batchId: string, owner: string, input: { status: WorkspaceOperationBatchStatus;
    errorCode?: string | null; trashEntryIds?: string[]; completedActions?: number; phase?: string }): Promise<WorkspaceOperationBatchRecord | null> {
    return executeLifecycleTransaction({ openConnection: this.connect, execute: async (db) => {
      const row = await db.get(`UPDATE workspace_file_operation_batches SET status = $3, error_code = $4,
        trash_entry_ids_json = COALESCE($5,trash_entry_ids_json), completed_actions = COALESCE($6,completed_actions),
        phase = COALESCE($7,phase), lease_owner = NULL, lease_expires_at = NULL, updated_at = $8
        WHERE batch_id = $1 AND lease_owner = $2 AND status = 'applying' RETURNING *`,
      [batchId, owner, input.status, input.errorCode ?? null,
        input.trashEntryIds ? JSON.stringify(input.trashEntryIds) : null, input.completedActions ?? null,
        input.phase ?? null, this.now()]);
      if (!row) return null;
      const batch = record(row as Record<string, unknown>);
      const reviewStatus = batch.status === 'needs_review' ? 'stale' : batch.status === 'undone' ? 'applied' : batch.status;
      await db.run(`UPDATE workspace_file_operation_reviews SET status = $2, error_code = $3,
        trash_entry_ids_json = $4, revision = revision + 1, updated_at = $5,
        batch_id = CASE WHEN $2 = 'stale' THEN NULL ELSE batch_id END,
        operation_id = CASE WHEN $2 = 'stale' THEN NULL ELSE operation_id END
        WHERE batch_id = $1 AND status IN ('queued','applying','applied','needs_recovery','failed')`,
      [batchId, reviewStatus, batch.status === 'undone' ? 'BATCH_UNDONE' : batch.errorCode,
        JSON.stringify(batch.trashEntryIds), this.now()]);
      return batch;
    }, recoverCommitted: async (value, error) => {
      if (!value) return null;
      const persisted = await this.get(batchId);
      if (persisted?.status === value.status && persisted.leaseOwner === null) return persisted;
      throw error;
    } });
  }
}
