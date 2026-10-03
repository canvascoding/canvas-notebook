import type { EmailReviewTarget } from '@/app/lib/email/review-client';
import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import {
  buildFileChangeReviewCenterHref,
} from '@/app/lib/file-version-center/notification-contract';
import { mcpConnectionSettingsHref } from '@/app/lib/mcp/connection-health-types';
import { beginExternalWorkspaceNavigation } from '@/app/lib/workspaces/navigation-sync';
import { openVersionCenterFromNotification } from '@/app/store/file-version-center-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { decideMemoryReviewClient, loadMemoryReview } from '@/app/lib/memory/review-client';
import type { MemoryReviewDecision, MemoryReviewTarget } from '@/app/lib/memory/contract';
import type { NotificationItem, NotificationSummary } from './notification-summary';
import { WORKSPACE_OPERATION_NOTIFICATION_PREFIX, workspaceOperationReviewHref,
  WORKSPACE_PATH_OPERATION_NOTIFICATION_PREFIX, WORKSPACE_PATH_PROBLEM_NOTIFICATION_PREFIX, workspacePathOperationHref,
  type WorkspaceOperationNotificationTarget, type WorkspacePathOperationNotificationTarget } from '@/app/lib/files/workspace-operation-notification-contract';
import { openWorkspaceOperationReview } from '@/app/store/workspace-operation-review-store';
import { openWorkspacePathOperationStatus } from '@/app/store/workspace-path-operation-store';
import { buildTodoPopupHref } from '@/app/lib/todos/navigation';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

export type NotificationMutation = {
  action: 'mark_all_read' | 'mark_item_read' | 'set_item_read_state' | 'dismiss_item';
  itemId?: string;
  workspaceId?: string;
  read?: boolean;
  expectedRevision?: string;
};

let fileChangeOpenGeneration = 0;

export function emailReviewTargetFromNotification(item: NotificationItem): EmailReviewTarget | null {
  if (item.target.kind !== 'email' || !item.target.draftId) return null;
  return { scope: item.target.scope, draftId: item.target.draftId,
    workspaceId: item.target.scope === 'workspace' ? item.workspaceId : undefined };
}

export function shouldMarkNotificationReadOnOpen(item: NotificationItem): boolean {
  return item.target.kind !== 'file_change' && item.target.kind !== 'todo';
}

export function memoryReviewTargetFromNotification(item: NotificationItem): MemoryReviewTarget | null {
  return item.target.kind === 'memory' ? item.target : null;
}

export async function decideMemoryNotification(item: NotificationItem, decision: MemoryReviewDecision): Promise<void> {
  const target = memoryReviewTargetFromNotification(item);
  if (!target) throw new Error('This notification is not a memory review.');
  const entry = await loadMemoryReview(target);
  await decideMemoryReviewClient(entry, decision);
  window.dispatchEvent(new CustomEvent('memory_review_updated'));
  window.dispatchEvent(new CustomEvent('notification_summary_updated'));
}

export function notificationHref(item: NotificationItem): string {
  switch (item.target.kind) {
    case 'chat':
      return buildChatSessionHref('/notebook', item.target.sessionId, item.workspaceId);
    case 'todo':
      return buildTodoPopupHref(item.target.todoId);
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
    case 'license':
      return '/settings?tab=license';
    case 'file_change':
      return item.workspaceId === item.target.workspaceId
        ? buildFileChangeReviewCenterHref(item.target)
        : `/notebook?workspaceId=${encodeURIComponent(item.workspaceId)}`;
    case 'file_operation':
      return workspaceOperationReviewHref({ workspaceId: item.workspaceId, reviewId: item.target.reviewId });
    case 'file_path_operation':
      return item.workspaceId === item.target.workspaceId ? workspacePathOperationHref(item.target)
        : `/notebook?workspaceId=${encodeURIComponent(item.workspaceId)}`;
  }
  return '/notebook';
}

export async function openFileChangeReviewNotification(item: NotificationItem, options: {reviewCenterEnabled?: boolean} = {}): Promise<boolean> {
  if (item.target.kind !== 'file_change' || item.workspaceId !== item.target.workspaceId) return false;
  const generation = ++fileChangeOpenGeneration;
  if (options.reviewCenterEnabled === false) return openWorkspacePathOperationStatus({ workspaceId: item.workspaceId, documentReviewPaused: true });
  const authScope = openedDocumentAuthScope();
  const current = () => generation === fileChangeOpenGeneration && openedDocumentAuthScope() === authScope;
  const releaseNavigation = beginExternalWorkspaceNavigation();
  const baselineHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  let preparedHref: string | null = null;
  try {
    await useWorkspaceStore.getState().hydrateWorkspaces();
    if (!current()) return true;
    if (useWorkspaceStore.getState().activeWorkspaceId !== item.target.workspaceId) {
      await useWorkspaceStore.getState().setActiveWorkspace(item.target.workspaceId, 'system');
    }
    if (!current()) return true;
    if (useWorkspaceStore.getState().activeWorkspaceId !== item.target.workspaceId) {
      throw new Error('The notification workspace is unavailable.');
    }
    preparedHref = buildFileChangeReviewCenterHref(item.target, baselineHref);
    window.history.replaceState(window.history.state, '', preparedHref);
    openVersionCenterFromNotification(item.target, { syncLocation: false });
    return true;
  } catch {
    const activeHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current() && preparedHref && activeHref === preparedHref) {
      window.history.replaceState(window.history.state, '', baselineHref);
    }
    return false;
  } finally {
    releaseNavigation();
  }
}

export async function openWorkspaceOperationNotificationTarget(
  target: Pick<WorkspaceOperationNotificationTarget, 'workspaceId' | 'reviewId'> & {batchId?: string; operationKind?: WorkspaceOperationNotificationTarget['operationKind']},
  options: {reviewCenterEnabled?: boolean} = {},
): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(target.workspaceId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(target.reviewId)) return false;
  const generation = ++fileChangeOpenGeneration;
  if (options.reviewCenterEnabled === false) return openWorkspacePathOperationStatus(target.batchId && target.operationKind !== 'copy'
    ? { workspaceId: target.workspaceId, batchId: target.batchId } : { workspaceId: target.workspaceId, reviewId: target.reviewId });
  const authScope = openedDocumentAuthScope();
  const current = () => generation === fileChangeOpenGeneration && openedDocumentAuthScope() === authScope;
  const releaseNavigation = beginExternalWorkspaceNavigation();
  try {
    await useWorkspaceStore.getState().hydrateWorkspaces();
    if (!current()) return true;
    if (useWorkspaceStore.getState().activeWorkspaceId !== target.workspaceId) {
      await useWorkspaceStore.getState().setActiveWorkspace(target.workspaceId, 'system');
    }
    if (!current()) return true;
    if (useWorkspaceStore.getState().activeWorkspaceId !== target.workspaceId) return false;
    openWorkspaceOperationReview(target.reviewId, target.workspaceId);
    void updateNotification({ action: 'mark_item_read', workspaceId: target.workspaceId,
      itemId: `${WORKSPACE_OPERATION_NOTIFICATION_PREFIX}${target.reviewId}` }).catch(() => undefined);
    return true;
  } catch {
    return false;
  } finally {
    releaseNavigation();
  }
}

export async function updateNotification(payload: NotificationMutation): Promise<void> {
  const response = await fetch('/api/notifications/summary?todoMode=lifecycle', {
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

export async function openWorkspacePathOperationNotificationTarget(target: WorkspacePathOperationNotificationTarget): Promise<boolean> {
  if (!await openWorkspacePathOperationStatus(target)) return false;
  const itemId = target.batchId ? `${WORKSPACE_PATH_OPERATION_NOTIFICATION_PREFIX}${target.batchId}`
    : `${WORKSPACE_PATH_PROBLEM_NOTIFICATION_PREFIX}${target.problemId}`;
  void updateNotification({ action: 'mark_item_read', workspaceId: target.workspaceId, itemId }).catch(() => undefined);
  return true;
}

export function homeNotificationItems(summary: NotificationSummary | null): NotificationItem[] {
  if (!summary) return [];
  const unique = new Map<string, NotificationItem>();
  for (const item of [...summary.items, ...summary.sections.notifications, ...summary.sections.todoAttention, ...summary.sections.emailAttention]) {
    unique.set(`${item.workspaceId}:${item.id}`, item);
  }
  return [...unique.values()].filter((item) => item.unread || item.priority === 'high' || item.target.kind === 'todo' || item.target.kind === 'memory' || item.target.kind === 'email' || item.target.kind === 'file_operation' || item.target.kind === 'file_path_operation')
    .sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}
