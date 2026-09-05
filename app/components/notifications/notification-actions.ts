import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import type { NotificationItem, NotificationSummary } from './notification-summary';

export type NotificationMutation = {
  action: 'mark_all_read' | 'mark_item_read' | 'set_item_read_state' | 'dismiss_item';
  itemId?: string;
  workspaceId?: string;
  read?: boolean;
};

export function notificationHref(item: NotificationItem): string {
  switch (item.target.kind) {
    case 'chat':
      return buildChatSessionHref('/notebook', item.target.sessionId, item.workspaceId);
    case 'todo':
      return `/todos?todo=${encodeURIComponent(item.target.todoId)}&workspaceId=${encodeURIComponent(item.workspaceId)}`;
    case 'email':
      return item.target.draftId
        ? `/emails?outboxDraft=${encodeURIComponent(item.target.draftId)}${item.target.scope === 'workspace' ? `&workspaceId=${encodeURIComponent(item.workspaceId)}` : ''}`
        : '/emails';
    case 'studio':
      return `/studio?${new URLSearchParams({ generation: item.target.generationId, workspaceId: item.workspaceId })}`;
    case 'automation':
      return '/automations';
  }
}

export async function updateNotification(payload: NotificationMutation): Promise<void> {
  const response = await fetch('/api/notifications/summary', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
  if (!response.ok || !body?.success) {
    throw new Error(body?.error || 'Failed to update notifications.');
  }
  window.dispatchEvent(new CustomEvent('notification_summary_updated'));
}

export function homeNotificationItems(summary: NotificationSummary | null): NotificationItem[] {
  if (!summary) return [];
  const unique = new Map<string, NotificationItem>();
  for (const item of [...summary.items, ...summary.sections.notifications, ...summary.sections.todoAttention, ...summary.sections.emailAttention]) {
    unique.set(`${item.workspaceId}:${item.id}`, item);
  }
  return [...unique.values()].filter((item) => item.unread || item.priority === 'high' || item.target.kind === 'todo')
    .sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}
