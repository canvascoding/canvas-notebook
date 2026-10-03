import 'server-only';

import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase } from '@/app/lib/file-version-center/database';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceOperationReviewKind } from './workspace-operation-review-contract';
import { WORKSPACE_OPERATION_NOTIFICATION_PREFIX, workspaceOperationReviewHref,
  WORKSPACE_PATH_OPERATION_NOTIFICATION_PREFIX, WORKSPACE_PATH_PROBLEM_NOTIFICATION_PREFIX, workspacePathOperationHref,
  type WorkspaceOperationAttentionStatus, type WorkspaceOperationNotificationTarget,
  type WorkspacePathOperationAttentionStatus, type WorkspacePathOperationNotificationTarget } from './workspace-operation-notification-contract';
import { sanitizeWorkspacePathOperationSelections, workspacePathOperationProblemErrorCode } from './workspace-path-operation-problems';

export type WorkspaceOperationNotificationItem = {
  id: string;
  type: 'file.operation_review_required';
  title: string;
  detail: string;
  previewUrl: null;
  deepLink: string;
  occurredAt: string;
  unread: boolean;
  priority: 'normal' | 'high';
  workspaceId: string;
  workspaceName: string | null;
  target: WorkspaceOperationNotificationTarget;
};

type Scope = { userId: string; workspace: WorkspaceContext };
type Row = { review_id: string; operation_kind: WorkspaceOperationReviewKind;
  status: WorkspaceOperationAttentionStatus; source_path: string; updated_at: string | number; unread: boolean };
const ACTIONABLE = `review.source_workspace_id = $1 AND review.destination_workspace_id = $1
  AND review.successor_review_id IS NULL
  AND review.status IN ('pending', 'queued', 'applying', 'blocked', 'stale', 'failed', 'needs_recovery')`;

function canRead(input: Scope): boolean {
  return Boolean(input.userId && input.workspace.workspaceId && input.workspace.permissions.canRead
    && (input.workspace.status ?? 'active') === 'active');
}

export function createWorkspaceOperationNotificationSource(options: {
  database?: FileVersionCenterDatabase; now?: () => number;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const now = options.now ?? Date.now;

  const list = async (input: Scope): Promise<{ items: WorkspaceOperationNotificationItem[]; unreadCount: number }> => {
    if (!canRead(input)) return { items: [], unreadCount: 0 };
    return database.transaction(async (transaction) => {
      const from = `FROM workspace_file_operation_reviews review
        LEFT JOIN mobile_inbox_read_states state ON state.user_id = $2 AND state.workspace_id = $1
          AND state.item_key = '${WORKSPACE_OPERATION_NOTIFICATION_PREFIX}' || review.review_id
        WHERE ${ACTIONABLE}`;
      const params = [input.workspace.workspaceId, input.userId];
      const counts = await transaction.query<{ total: string | number }>(
        `SELECT COUNT(*) FILTER (WHERE COALESCE(state.read_at, 0) < review.updated_at) AS total ${from}`, params);
      const rows = await transaction.query<Row>(`SELECT review.review_id, review.status, review.updated_at,
        review.request_json::jsonb ->> 'kind' AS operation_kind,
        review.request_json::jsonb #>> '{selections,0,sourcePath}' AS source_path,
        COALESCE(state.read_at, 0) < review.updated_at AS unread ${from}
        ORDER BY review.updated_at DESC, review.review_id DESC LIMIT 200`, params);
      const items = rows.rows.flatMap((row): WorkspaceOperationNotificationItem[] => {
        const timestamp = Number(row.updated_at);
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8.64e15
          || !['rename', 'move', 'copy', 'delete'].includes(row.operation_kind)) return [];
        const target: WorkspaceOperationNotificationTarget = { kind: 'file_operation',
          workspaceId: input.workspace.workspaceId, reviewId: row.review_id,
          operationKind: row.operation_kind, status: row.status };
        return [{ id: `${WORKSPACE_OPERATION_NOTIFICATION_PREFIX}${row.review_id}`,
          type: 'file.operation_review_required', title: row.status === 'queued' ? 'File action queued'
            : row.status === 'applying' ? 'File action running' : 'File action needs attention', detail: row.source_path ?? '',
          previewUrl: null, deepLink: workspaceOperationReviewHref(target), occurredAt: new Date(timestamp).toISOString(),
          unread: row.unread, priority: ['pending', 'queued', 'applying'].includes(row.status) ? 'normal' : 'high', target,
          workspaceId: input.workspace.workspaceId, workspaceName: input.workspace.displayName ?? null }];
      });
      return { items, unreadCount: Number(counts.rows[0]?.total ?? 0) };
    });
  };

  // Reading a notification never resolves or hides the underlying review.
  const markRead = async (input: Scope & { itemId?: string }): Promise<{ updated: number }> => {
    if (!canRead(input) || input.itemId !== undefined && !input.itemId.startsWith(WORKSPACE_OPERATION_NOTIFICATION_PREFIX)) {
      return { updated: 0 };
    }
    const reviewId = input.itemId?.slice(WORKSPACE_OPERATION_NOTIFICATION_PREFIX.length);
    return database.transaction(async (transaction) => {
      const result = await transaction.query<{ item_key: string }>(`INSERT INTO mobile_inbox_read_states
        (user_id, workspace_id, item_key, read_at, dismissed_at, created_at, updated_at)
        SELECT $2, $1, '${WORKSPACE_OPERATION_NOTIFICATION_PREFIX}' || review.review_id, $3, NULL, $3, $3
        FROM workspace_file_operation_reviews review WHERE ${ACTIONABLE}
          ${reviewId === undefined ? '' : 'AND review.review_id = $4'}
        ON CONFLICT (user_id, workspace_id, item_key) DO UPDATE SET
          read_at = EXCLUDED.read_at, updated_at = EXCLUDED.updated_at
        RETURNING item_key`, [input.workspace.workspaceId, input.userId, now(),
        ...(reviewId === undefined ? [] : [reviewId])]);
      return { updated: result.rows.length };
    });
  };

  return { list, markRead };
}

export const workspaceOperationNotificationSource = createWorkspaceOperationNotificationSource();

export type WorkspacePathOperationNotificationItem = Omit<WorkspaceOperationNotificationItem, 'type' | 'target'> & {
  type: 'file.operation_attention';
  target: WorkspacePathOperationNotificationTarget;
};

type PathOperationRow = { batch_id: string | null; problem_id: string | null;
  operation_kind: 'move' | 'rename' | 'delete'; status: WorkspacePathOperationAttentionStatus;
  selections_json: string; error_code: string | null; updated_at: string | number; unread: boolean };

// Select only public path metadata. Private plans, document content and actor authority never leave this query.
const PATH_OPERATION_ATTENTION = `WITH actions AS (
  SELECT batch.batch_id, NULL::text AS problem_id,
    (batch.plan_json::jsonb -> 'actions' -> -1) ->> 'kind' AS operation_kind,
    CASE WHEN batch.status = 'needs_review' THEN 'stale'
      WHEN batch.status = 'applied' THEN 'failed' ELSE batch.status END AS status,
    COALESCE((batch.plan_json::jsonb -> 'actions' -> -1) -> 'selections', '[]'::jsonb)::text AS selections_json,
    batch.error_code, batch.updated_at, '${WORKSPACE_PATH_OPERATION_NOTIFICATION_PREFIX}' || batch.batch_id AS item_key
  FROM workspace_file_operation_batches batch
  WHERE batch.workspace_id = $1 AND batch.authorization_json::jsonb ->> 'mode' = 'direct'
    AND (batch.status IN ('queued','applying','blocked','needs_review','needs_recovery','failed')
      OR (batch.status = 'applied' AND batch.error_code IS NOT NULL))
  UNION ALL
  SELECT NULL::text, problem.problem_id, problem.operation_kind, 'failed', problem.selections_json,
    problem.error_code, problem.updated_at, '${WORKSPACE_PATH_PROBLEM_NOTIFICATION_PREFIX}' || problem.problem_id
  FROM workspace_path_operation_problems problem WHERE problem.workspace_id = $1
), attention AS (
  SELECT actions.*, COALESCE(state.read_at, 0) < actions.updated_at AS unread FROM actions
  LEFT JOIN mobile_inbox_read_states state ON state.user_id = $2 AND state.workspace_id = $1
    AND state.item_key = actions.item_key
)`;

export function createWorkspacePathOperationNotificationSource(options: {
  database?: FileVersionCenterDatabase; now?: () => number;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const now = options.now ?? Date.now;

  const list = async (input: Scope): Promise<{ items: WorkspacePathOperationNotificationItem[]; unreadCount: number }> => {
    if (!canRead(input)) return { items: [], unreadCount: 0 };
    return database.transaction(async (transaction) => {
      const params = [input.workspace.workspaceId, input.userId];
      const counts = await transaction.query<{ total: string | number }>(
        `${PATH_OPERATION_ATTENTION} SELECT COUNT(*) FILTER (WHERE unread) AS total FROM attention`, params);
      const rows = await transaction.query<PathOperationRow>(`${PATH_OPERATION_ATTENTION}
        SELECT batch_id,problem_id,operation_kind,status,selections_json,error_code,updated_at,unread FROM attention
        ORDER BY updated_at DESC,item_key DESC LIMIT 200`, params);
      const items = rows.rows.flatMap((row): WorkspacePathOperationNotificationItem[] => {
        const timestamp = Number(row.updated_at);
        const id = row.batch_id ?? row.problem_id;
        if (!id || !/^[A-Za-z0-9_-]{16,128}$/u.test(id) || !Number.isSafeInteger(timestamp)
          || timestamp < 0 || timestamp > 8.64e15 || !['move', 'rename', 'delete'].includes(row.operation_kind)
          || !['queued', 'applying', 'blocked', 'stale', 'failed', 'needs_recovery'].includes(row.status)) return [];
        const target: WorkspacePathOperationNotificationTarget = { kind: 'file_path_operation',
          workspaceId: input.workspace.workspaceId, operationKind: row.operation_kind, status: row.status,
          ...(row.batch_id ? { batchId: row.batch_id } : { problemId: row.problem_id! }) };
        const selections = sanitizeWorkspacePathOperationSelections(JSON.parse(row.selections_json));
        const sourcePath = selections[0]?.sourcePath ?? '';
        const errorCode = row.error_code ? workspacePathOperationProblemErrorCode({ code: row.error_code }) : '';
        return [{ id: `${row.batch_id ? WORKSPACE_PATH_OPERATION_NOTIFICATION_PREFIX : WORKSPACE_PATH_PROBLEM_NOTIFICATION_PREFIX}${id}`,
          type: 'file.operation_attention', title: row.status === 'queued' ? 'File action queued'
            : row.status === 'applying' ? 'File action running' : 'File action needs attention',
          detail: [sourcePath, errorCode].filter(Boolean).join(' · '),
          previewUrl: null, deepLink: workspacePathOperationHref(target), occurredAt: new Date(timestamp).toISOString(),
          unread: row.unread, priority: ['queued', 'applying'].includes(row.status) ? 'normal' : 'high', target,
          workspaceId: input.workspace.workspaceId, workspaceName: input.workspace.displayName ?? null }];
      });
      return { items, unreadCount: Number(counts.rows[0]?.total ?? 0) };
    });
  };

  const markRead = async (input: Scope & { itemId?: string }): Promise<{ updated: number }> => {
    if (!canRead(input)) return { updated: 0 };
    if (input.itemId !== undefined) {
      const prefix = [WORKSPACE_PATH_OPERATION_NOTIFICATION_PREFIX, WORKSPACE_PATH_PROBLEM_NOTIFICATION_PREFIX]
        .find((candidate) => input.itemId!.startsWith(candidate));
      if (!prefix || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.itemId.slice(prefix.length))) return { updated: 0 };
    }
    return database.transaction(async (transaction) => {
      const result = await transaction.query<{ item_key: string }>(`${PATH_OPERATION_ATTENTION}
        INSERT INTO mobile_inbox_read_states (user_id,workspace_id,item_key,read_at,dismissed_at,created_at,updated_at)
        SELECT $2,$1,attention.item_key,attention.updated_at,NULL,$3,$3 FROM attention
          ${input.itemId === undefined ? '' : 'WHERE attention.item_key = $4'}
        ON CONFLICT (user_id,workspace_id,item_key) DO UPDATE SET read_at = EXCLUDED.read_at,updated_at = EXCLUDED.updated_at
        RETURNING item_key`, [input.workspace.workspaceId, input.userId, now(),
        ...(input.itemId === undefined ? [] : [input.itemId])]);
      return { updated: result.rows.length };
    });
  };

  return { list, markRead };
}

export const workspacePathOperationNotificationSource = createWorkspacePathOperationNotificationSource();
