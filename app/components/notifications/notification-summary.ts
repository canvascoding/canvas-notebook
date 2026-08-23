'use client';

export type NotificationItem = {
  id: string;
  type: 'chat.response' | 'todo.attention' | 'studio.completed' | 'studio.failed' | 'automation.failed';
  title: string;
  detail: string | null;
  occurredAt: string;
  unread: boolean;
  priority: 'normal' | 'high';
  todoStatus?: 'open' | 'done' | 'archived';
  workspaceId: string;
  workspaceName: string | null;
  target:
    | { kind: 'chat'; sessionId: string }
    | { kind: 'todo'; todoId: string }
    | { kind: 'studio'; generationId: string }
    | { kind: 'automation'; runId: string };
};

export type NotificationSummary = {
  unreadCount: number;
  counts: {
    unread: number;
    chat: number;
    todos: number;
    todoUnread: number;
    studio: number;
    automation: number;
  };
  items: NotificationItem[];
  sections: {
    notifications: NotificationItem[];
    todos: NotificationItem[];
    todoUnread: NotificationItem[];
  };
};

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

export async function readNotificationSummary(): Promise<NotificationSummary> {
  const response = await fetch('/api/notifications/summary', {
    credentials: 'include',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null) as ApiResponse<NotificationSummary> | null;
  if (!response.ok || !payload?.success || !payload.data) {
    throw new Error(payload?.error || 'Failed to load notifications.');
  }
  return payload.data;
}
