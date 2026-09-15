import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import {
  buildFileChangeReviewCenterHref,
} from '@/app/lib/file-version-center/notification-contract';
import { mcpConnectionSettingsHref } from '@/app/lib/mcp/connection-health-types';
import { openVersionCenterFromNotification } from '@/app/store/file-version-center-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { NotificationItem, NotificationSummary } from './notification-summary';

export type NotificationMutation = {
  action: 'mark_all_read' | 'mark_item_read' | 'set_item_read_state' | 'dismiss_item';
  itemId?: string;
  workspaceId?: string;
  read?: boolean;
};

let fileChangeOpenGeneration = 0;

export function shouldMarkNotificationReadOnOpen(item: NotificationItem): boolean {
  return item.target.kind !== 'file_change';
}

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
    case 'memory': {
      const params = new URLSearchParams({
        tab: 'memory',
        scope: item.target.scope,
        status: 'pending',
        collectionId: item.target.collectionId,
        entryId: item.target.entryId,
      });
      if (item.target.scope === 'workspace' && item.target.workspaceId) {
        params.set('workspaceId', item.target.workspaceId);
      }
      return `/settings?${params.toString()}`;
    }
    case 'mcp':
      return mcpConnectionSettingsHref(item.target.connectionId);
    case 'file_change':
      return item.workspaceId === item.target.workspaceId
        ? buildFileChangeReviewCenterHref(item.target)
        : `/notebook?workspaceId=${encodeURIComponent(item.workspaceId)}`;
  }
  return '/notebook';
}

export async function openFileChangeReviewNotification(item: NotificationItem): Promise<boolean> {
  if (item.target.kind !== 'file_change' || item.workspaceId !== item.target.workspaceId) return false;
  const generation = ++fileChangeOpenGeneration;
  const baselineHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  let preparedHref: string | null = null;
  try {
    await useWorkspaceStore.getState().hydrateWorkspaces();
    if (generation !== fileChangeOpenGeneration) return true;
    if (useWorkspaceStore.getState().activeWorkspaceId !== item.target.workspaceId) {
      await useWorkspaceStore.getState().setActiveWorkspace(item.target.workspaceId, 'system');
    }
    if (generation !== fileChangeOpenGeneration) return true;
    if (useWorkspaceStore.getState().activeWorkspaceId !== item.target.workspaceId) {
      throw new Error('The notification workspace is unavailable.');
    }
    preparedHref = buildFileChangeReviewCenterHref(item.target, baselineHref);
    window.history.replaceState(window.history.state, '', preparedHref);
    openVersionCenterFromNotification(item.target, { syncLocation: false });
    return true;
  } catch {
    const activeHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (generation === fileChangeOpenGeneration && preparedHref && activeHref === preparedHref) {
      window.history.replaceState(window.history.state, '', baselineHref);
    }
    return false;
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
