import 'server-only';

import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase } from '@/app/lib/file-version-center/database';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceOperationReviewKind } from './workspace-operation-review-contract';
import { WORKSPACE_OPERATION_NOTIFICATION_PREFIX, workspaceOperationReviewHref,
  type WorkspaceOperationAttentionStatus, type WorkspaceOperationNotificationTarget } from './workspace-operation-notification-contract';

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
  AND review.status IN ('pending', 'blocked', 'stale', 'failed', 'needs_recovery')`;

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
          type: 'file.operation_review_required', title: 'File action needs attention', detail: row.source_path ?? '',
          previewUrl: null, deepLink: workspaceOperationReviewHref(target), occurredAt: new Date(timestamp).toISOString(),
          unread: row.unread, priority: row.status === 'pending' ? 'normal' : 'high', target,
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
