'use client';

import { openedDocumentAuthScope, type OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { assertSessionRequestCurrent, assertSessionResponseCurrent } from '@/app/lib/auth/session-expiry';
import type { FileChangeReviewNotificationReason, FileChangeReviewNotificationTarget } from '@/app/lib/file-version-center/notification-contract';
import type { WorkspaceOperationNotificationTarget, WorkspacePathOperationNotificationTarget } from '@/app/lib/files/workspace-operation-notification-contract';

export type NotificationItem = {
  id: string;
  type: 'chat.response' | 'email.attention' | 'todo.attention' | 'studio.completed' | 'studio.failed' | 'automation.failed' | 'memory.approval_required' | 'mcp.connection_attention' | 'file.change_review_required' | 'file.operation_review_required' | 'file.operation_attention' | 'license.team_access_changed' | 'license.team_grant_expiring';
  title: string;
  detail: string | null;
  occurredAt: string;
  unread: boolean;
  priority: 'normal' | 'high';
  deepLink?: string;
  fileChangeReason?: FileChangeReviewNotificationReason;
  todoStatus?: 'open' | 'done' | 'archived';
  todoAttentionReason?: 'overdue' | 'due_today' | 'high_priority' | 'due_soon' | 'open';
  workspaceId: string;
  workspaceName: string | null;
  target:
    | { kind: 'chat'; sessionId: string }
    | { kind: 'email'; scope: 'personal' | 'workspace'; caseId?: string; draftId?: string }
    | { kind: 'todo'; todoId: string }
    | { kind: 'studio'; generationId: string }
    | { kind: 'automation'; runId: string }
    | { kind: 'mcp'; connectionId: string }
    | { kind: 'license' }
    | FileChangeReviewNotificationTarget
    | WorkspaceOperationNotificationTarget
    | WorkspacePathOperationNotificationTarget
    | { kind: 'memory'; scope: 'workspace' | 'organization'; entryId: string; collectionId: string; workspaceId?: string; organizationId?: string };
};

export type NotificationSummary = {
  unreadCount: number;
  counts: {
    unread: number;
    chat: number;
    todos: number;
    todoAttention: number;
    emailAttention: number;
    studio: number;
    automation: number;
    memoryApprovals: number;
    mcpConnections?: number;
  };
  items: NotificationItem[];
  sections: {
    notifications: NotificationItem[];
    todos: NotificationItem[];
    todoAttention: NotificationItem[];
    emailAttention: NotificationItem[];
  };
};

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

export async function readNotificationSummary(options: {
  activeChatSessionId?: string | null;
  signal?: AbortSignal;
  authScope?: OpenedDocumentAuthScope | null;
} = {}): Promise<NotificationSummary> {
  const scope = options.authScope === undefined ? openedDocumentAuthScope() : options.authScope;
  assertSessionRequestCurrent(scope, options.signal);
  const params = new URLSearchParams({ todoMode: 'lifecycle' });
  if (options.activeChatSessionId) params.set('activeChatSessionId', options.activeChatSessionId);
  const response = await fetch(`/api/notifications/summary${params.size ? `?${params}` : ''}`, {
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
  });
  assertSessionResponseCurrent(response, scope, options.signal);
  const payload = await response.json().catch(() => null) as ApiResponse<NotificationSummary> | null;
  assertSessionRequestCurrent(scope, options.signal);
  if (!response.ok || !payload?.success || !payload.data) {
    throw new Error(payload?.error || 'Failed to load notifications.');
  }
  return payload.data;
}
