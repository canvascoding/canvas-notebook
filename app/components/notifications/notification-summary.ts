'use client';

import type { DefaultTodoCategoryKey } from '@/app/lib/todos/default-categories';

export type NotificationSummary = {
  unreadCount: number;
  sessions: {
    unreadCount: number;
    items: Array<{
      sessionId: string;
      title: string;
      agentId: string;
      workspaceId: string | null;
      workspaceName: string | null;
      lastMessageAt: string | null;
    }>;
  };
  todos: {
    unreadCount: number;
    dueCount: number;
    items: Array<{
      id: string;
      title: string;
      priority: 'low' | 'normal' | 'high';
      dueAt: string | null;
      seenAt: string | null;
      categoryName: string | null;
      categoryKey: DefaultTodoCategoryKey | null;
      workspaceId: string | null;
      isDue: boolean;
    }>;
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
