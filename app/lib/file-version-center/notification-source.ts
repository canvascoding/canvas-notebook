import 'server-only';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  createRuntimeFileVersionCenterDatabase,
  type FileVersionCenterDatabase,
} from './database';
import {
  FILE_VERSION_CENTER_ROLLOUT_ENV_V1,
  resolveFileVersionRolloutV1,
} from './policy-v1';
import {
  buildFileChangeReviewCenterHref,
  fileChangeReviewNotificationItemId,
  FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX,
  type FileChangeReviewNotificationReason,
} from './notification-contract';

const MAX_NOTIFICATION_ITEMS = 200;

export type FileChangeReviewNotificationItem = {
  id: string;
  type: 'file.change_review_required';
  title: string;
  detail: string;
  previewUrl: null;
  deepLink: string;
  fileChangeReason: FileChangeReviewNotificationReason;
  occurredAt: string;
  unread: boolean;
  priority: 'normal' | 'high';
  target: {
    kind: 'file_change';
    workspaceId: string;
    lineageId: string;
    operationId: string;
  };
};

type NotificationRow = {
  operation_id: string;
  workspace_id: string;
  lineage_id: string;
  status: string;
  requested_mode: string;
  updated_at: number | string;
  unread: boolean | number | string;
};

const OPERATION_SOURCE_SQL = `
  FROM collaboration_agent_operations operation
  INNER JOIN collaboration_documents document
    ON document.id = operation.document_id
    AND document.workspace_id = operation.workspace_id
    AND document.status = 'active'
  INNER JOIN file_collaboration_lineages lineage
    ON lineage.id = document.lineage_id
    AND lineage.workspace_id = operation.workspace_id
    AND lineage.status = 'active'
`;

const ACTIONABLE_OPERATION_PREDICATE_SQL = `
  operation.workspace_id = $1
  AND operation.operation_type = 'apply'
  AND (operation.initiated_by_user_id = $2 OR $3::boolean)
  AND (
    operation.status IN ('needs_review', 'semantic_conflict')
    OR (
      operation.status = 'partially_applied'
      AND COALESCE(operation.error_code, '') <> 'persistence_degraded'
    )
    OR (operation.status = 'failed' AND operation.requested_mode = 'direct_apply')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM collaboration_agent_operations superseder
    WHERE superseder.workspace_id = operation.workspace_id
      AND superseder.document_id = operation.document_id
      AND superseder.supersedes_operation_id = operation.operation_id
      AND superseder.operation_type = 'revert'
      AND superseder.status IN ('persisted_yjs', 'checkpointed_file')
  )
`;

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function canReadNotifications(userId: string, workspace: WorkspaceContext): boolean {
  return validId(userId)
    && validId(workspace.workspaceId)
    && workspace.permissions.canRead
    && workspace.permissions.canWrite
    && (workspace.status ?? 'active') === 'active';
}

function operationIdFromItemId(itemId: string): string | null {
  if (!itemId.startsWith(FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX)) return null;
  const operationId = itemId.slice(FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX.length);
  return validId(operationId) ? operationId : null;
}

function checkedTimestamp(value: number | string): number | null {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function readBoolean(value: NotificationRow['unread']): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function reasonFor(row: NotificationRow): FileChangeReviewNotificationReason {
  if (row.status === 'semantic_conflict') return 'semantic_conflict';
  if (row.status === 'partially_applied') return 'partially_applied';
  if (row.status === 'failed' && row.requested_mode === 'direct_apply') return 'direct_apply_failed';
  return 'needs_review';
}

function presentation(reason: FileChangeReviewNotificationReason): Pick<
  FileChangeReviewNotificationItem,
  'title' | 'detail' | 'priority'
> {
  if (reason === 'semantic_conflict') {
    return {
      title: 'File change has a conflict',
      detail: 'An agent change conflicts with the current document and needs review.',
      priority: 'high',
    };
  }
  if (reason === 'partially_applied') {
    return {
      title: 'File change needs review',
      detail: 'Part of an agent change was applied and the remaining change needs review.',
      priority: 'high',
    };
  }
  if (reason === 'direct_apply_failed') {
    return {
      title: 'File change could not be applied',
      detail: 'A direct agent change failed safely and needs review.',
      priority: 'high',
    };
  }
  return {
    title: 'File change needs review',
    detail: 'An agent change is waiting for review.',
    priority: 'normal',
  };
}

function notificationFromRow(row: NotificationRow): FileChangeReviewNotificationItem | null {
  const updatedAt = checkedTimestamp(row.updated_at);
  if (
    updatedAt === null
    || !validId(row.operation_id)
    || !validId(row.workspace_id)
    || !validId(row.lineage_id)
  ) return null;
  const reason = reasonFor(row);
  return {
    id: fileChangeReviewNotificationItemId(row.operation_id),
    type: 'file.change_review_required',
    ...presentation(reason),
    previewUrl: null,
    deepLink: buildFileChangeReviewCenterHref({
      kind: 'file_change',
      workspaceId: row.workspace_id,
      lineageId: row.lineage_id,
      operationId: row.operation_id,
    }),
    fileChangeReason: reason,
    occurredAt: new Date(updatedAt).toISOString(),
    unread: readBoolean(row.unread),
    target: {
      kind: 'file_change',
      workspaceId: row.workspace_id,
      lineageId: row.lineage_id,
      operationId: row.operation_id,
    },
  };
}

function sourceParameters(userId: string, workspace: WorkspaceContext): [string, string, boolean] {
  return [workspace.workspaceId, userId, workspace.permissions.canManageWorkspace];
}

export function createFileChangeReviewNotificationSource(options: {
  database?: FileVersionCenterDatabase;
  now?: () => Date;
  notificationsEnabled?: () => boolean;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const now = options.now ?? (() => new Date());
  const notificationsEnabled = options.notificationsEnabled ?? (() => resolveFileVersionRolloutV1(
    process.env[FILE_VERSION_CENTER_ROLLOUT_ENV_V1.mode],
  ).notifications);

  const list = async (input: {
    userId: string;
    workspace: WorkspaceContext;
  }): Promise<FileChangeReviewNotificationItem[]> => {
    if (!notificationsEnabled() || !canReadNotifications(input.userId, input.workspace)) return [];
    return database.transaction(async (transaction) => {
      const result = await transaction.query<NotificationRow>(`
        SELECT operation.operation_id, operation.workspace_id, document.lineage_id,
          operation.status, operation.requested_mode, operation.updated_at,
          CASE
            WHEN item_state.item_key IS NULL THEN TRUE
            ELSE item_state.read_at < operation.updated_at
          END AS unread
        ${OPERATION_SOURCE_SQL}
        LEFT JOIN mobile_inbox_read_states item_state
          ON item_state.user_id = $2
          AND item_state.workspace_id = operation.workspace_id
          AND item_state.item_key = '${FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX}' || operation.operation_id
        WHERE ${ACTIONABLE_OPERATION_PREDICATE_SQL}
          AND (
            item_state.dismissed_at IS NULL
            OR item_state.dismissed_at < operation.updated_at
          )
        ORDER BY operation.updated_at DESC, operation.operation_id DESC
        LIMIT ${MAX_NOTIFICATION_ITEMS}
      `, sourceParameters(input.userId, input.workspace));
      const seen = new Set<string>();
      return result.rows.flatMap((row) => {
        if (seen.has(row.operation_id)) return [];
        seen.add(row.operation_id);
        const notification = notificationFromRow(row);
        return notification ? [notification] : [];
      });
    });
  };

  const countUnread = async (input: {
    userId: string;
    workspace: WorkspaceContext;
  }): Promise<number> => {
    if (!notificationsEnabled() || !canReadNotifications(input.userId, input.workspace)) return 0;
    return database.transaction(async (transaction) => {
      const result = await transaction.query<{ total: number | string }>(`
        SELECT COUNT(*) AS total
        FROM (
          SELECT operation.operation_id
          ${OPERATION_SOURCE_SQL}
          LEFT JOIN mobile_inbox_read_states item_state
            ON item_state.user_id = $2
            AND item_state.workspace_id = operation.workspace_id
            AND item_state.item_key = '${FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX}' || operation.operation_id
          WHERE ${ACTIONABLE_OPERATION_PREDICATE_SQL}
            AND (
              item_state.dismissed_at IS NULL
              OR item_state.dismissed_at < operation.updated_at
            )
            AND CASE
              WHEN item_state.item_key IS NULL THEN TRUE
              ELSE item_state.read_at < operation.updated_at
            END
        ) actionable_unread
      `, sourceParameters(input.userId, input.workspace));
      const total = Number(result.rows[0]?.total ?? 0);
      return Number.isSafeInteger(total) && total >= 0 ? total : 0;
    });
  };

  const setItemState = async (input: {
    userId: string;
    workspace: WorkspaceContext;
    itemId: string;
    read: boolean;
    dismiss?: boolean;
  }): Promise<{ found: boolean; readAt: string | null; dismissedAt: string | null }> => {
    if (!notificationsEnabled() || !canReadNotifications(input.userId, input.workspace)) {
      return { found: false, readAt: null, dismissedAt: null };
    }
    const operationId = operationIdFromItemId(input.itemId);
    if (!operationId) return { found: false, readAt: null, dismissedAt: null };
    return database.transaction(async (transaction) => {
      const available = await transaction.query<{ operation_id: string }>(`
        SELECT operation.operation_id
        ${OPERATION_SOURCE_SQL}
        WHERE ${ACTIONABLE_OPERATION_PREDICATE_SQL}
          AND operation.operation_id = $4
        LIMIT 1
      `, [...sourceParameters(input.userId, input.workspace), operationId]);
      if (!available.rows.length) return { found: false, readAt: null, dismissedAt: null };
      const changedAt = now();
      const readAt = input.read || input.dismiss ? changedAt : new Date(0);
      const dismissedAt = input.dismiss ? changedAt : null;
      await transaction.query(`
        INSERT INTO mobile_inbox_read_states (
          user_id, workspace_id, item_key, read_at, dismissed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (user_id, workspace_id, item_key) DO UPDATE SET
          read_at = EXCLUDED.read_at,
          dismissed_at = EXCLUDED.dismissed_at,
          updated_at = EXCLUDED.updated_at
      `, [input.userId, input.workspace.workspaceId, input.itemId, readAt.getTime(),
        dismissedAt?.getTime() ?? null, changedAt.getTime()]);
      return {
        found: true,
        readAt: input.read || input.dismiss ? changedAt.toISOString() : null,
        dismissedAt: dismissedAt?.toISOString() ?? null,
      };
    });
  };

  const markAllRead = async (input: {
    userId: string;
    workspace: WorkspaceContext;
  }): Promise<{ readAt: string; updated: number }> => {
    const changedAt = now();
    if (!notificationsEnabled() || !canReadNotifications(input.userId, input.workspace)) {
      return { readAt: changedAt.toISOString(), updated: 0 };
    }
    return database.transaction(async (transaction) => {
      const result = await transaction.query<{ item_key: string }>(`
        INSERT INTO mobile_inbox_read_states (
          user_id, workspace_id, item_key, read_at, dismissed_at, created_at, updated_at
        )
        SELECT $2, operation.workspace_id,
          '${FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX}' || operation.operation_id,
          $4, NULL, $4, $4
        ${OPERATION_SOURCE_SQL}
        LEFT JOIN mobile_inbox_read_states item_state
          ON item_state.user_id = $2
          AND item_state.workspace_id = operation.workspace_id
          AND item_state.item_key = '${FILE_CHANGE_REVIEW_NOTIFICATION_PREFIX}' || operation.operation_id
        WHERE ${ACTIONABLE_OPERATION_PREDICATE_SQL}
          AND (
            item_state.dismissed_at IS NULL
            OR item_state.dismissed_at < operation.updated_at
          )
        ON CONFLICT (user_id, workspace_id, item_key) DO UPDATE SET
          read_at = EXCLUDED.read_at,
          updated_at = EXCLUDED.updated_at
        RETURNING item_key
      `, [input.workspace.workspaceId, input.userId, input.workspace.permissions.canManageWorkspace,
        changedAt.getTime()]);
      return { readAt: changedAt.toISOString(), updated: result.rows.length };
    });
  };

  return { list, countUnread, setItemState, markAllRead };
}

export const fileChangeReviewNotificationSource = createFileChangeReviewNotificationSource();
