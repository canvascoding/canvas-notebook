import 'server-only';

import { listEmailAttention, type EmailAttentionItem } from '@/app/lib/email/inbox-attention';
import { countMobileUnreadNotifications, listMobileAggregateInbox, type MobileAggregateInboxItem } from '@/app/lib/mobile/inbox';
import { listTodos } from '@/app/lib/todos/store';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { listMemoryApprovalAttention, type MemoryApprovalAttentionItem } from '@/app/lib/memory/approval-attention';

import { selectTodoAttention, type TodoAttentionReason } from './attention-policy';
import { settleNotificationSource } from './source-resilience';

export type NotificationAttentionItem = (MobileAggregateInboxItem & {
  workspaceName: string | null;
  todoAttentionReason?: TodoAttentionReason;
}) | MemoryApprovalAttentionItem;

function workspaceNameById(workspaces: WorkspaceContext[]) {
  return new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.displayName || workspace.workspaceType]));
}

function itemWorkspaceId(item: EmailAttentionItem, fallbackWorkspaceId: string): string {
  return item.target.scope === 'workspace' ? fallbackWorkspaceId : fallbackWorkspaceId;
}

export async function readNotificationAttention(input: {
  userId: string;
  workspaces: WorkspaceContext[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const workspaceIds = input.workspaces.map((workspace) => workspace.workspaceId);
  const names = workspaceNameById(input.workspaces);
  const defaultPersonalWorkspace = input.workspaces.find((workspace) => workspace.workspaceType === 'personal' && workspace.isDefault)
    ?? input.workspaces.find((workspace) => workspace.workspaceType === 'personal')
    ?? null;
  const [eventsResult, todosResult, emailResult, unreadResult, memoryResult] = await Promise.all([
    settleNotificationSource(listMobileAggregateInbox({
      userId: input.userId,
      workspaces: input.workspaces,
      filter: 'notifications',
      limit: 12,
    }), { items: [], counts: { chat: 0, todos: 0, studio: 0, automation: 0 } }),
    settleNotificationSource(listTodos(input.userId, {
      workspaceType: 'all',
      workspaceIds,
      status: 'open',
      limit: 200,
      sortAsOf: now,
    }), []),
    settleNotificationSource(Promise.all(input.workspaces.map(async (workspace) => ({
      workspace,
      items: await listEmailAttention({ userId: input.userId, workspace }),
    }))), []),
    settleNotificationSource(countMobileUnreadNotifications({ userId: input.userId, workspaces: input.workspaces }), 0),
    settleNotificationSource(listMemoryApprovalAttention({ userId: input.userId, workspaces: input.workspaces }), []),
  ]);
  const events = eventsResult.value;
  const todos = todosResult.value;
  const emailLists = emailResult.value;
  const mobileUnreadCount = unreadResult.value;
  const memoryApprovals = memoryResult.value;
  const sources = {
    events: eventsResult.status,
    todos: todosResult.status,
    email: emailResult.status,
    unreadCount: unreadResult.status,
    memoryApprovals: memoryResult.status,
  };
  for (const [source, status] of Object.entries(sources)) {
    if (!status.available) console.warn('[Notifications] Source unavailable.', { source, userId: input.userId });
  }

  const todoAttention = selectTodoAttention({ todos, viewerUserId: input.userId, now }).map((todo) => {
    const workspaceId = todo.workspaceId || defaultPersonalWorkspace?.workspaceId || '';
    return {
      id: `todo:${todo.id}`,
      type: 'todo.attention' as const,
      title: todo.title,
      detail: todo.category?.name || 'To-do',
      previewUrl: null,
      occurredAt: todo.updatedAt.toISOString(),
      unread: todo.readState === 'unread',
      priority: todo.priority === 'high' ? 'high' as const : 'normal' as const,
      todoStatus: 'open' as const,
      workspaceId,
      workspaceName: names.get(workspaceId) ?? null,
      target: { kind: 'todo' as const, todoId: todo.id },
      todoAttentionReason: todo.attentionReason,
    } satisfies NotificationAttentionItem;
  });

  const seenEmails = new Set<string>();
  const emailAttention = emailLists.flatMap(({ workspace, items }) => items.flatMap((item) => {
    const identity = item.target.draftId ? `draft:${item.target.draftId}` : item.target.caseId ? `case:${item.target.caseId}` : item.id;
    if (seenEmails.has(identity)) return [];
    seenEmails.add(identity);
    const workspaceId = itemWorkspaceId(item, workspace.workspaceId);
    return [{
      ...item,
      previewUrl: null,
      unread: false,
      workspaceId,
      workspaceName: names.get(workspaceId) ?? null,
    }];
  })).sort((left, right) => (
    (left.priority === 'high' ? 0 : 1) - (right.priority === 'high' ? 0 : 1)
    || right.occurredAt.localeCompare(left.occurredAt)
    || right.id.localeCompare(left.id)
  )).slice(0, 6);

  const eventItems = events.items.map((item) => ({
    ...item,
    workspaceName: names.get(item.workspaceId) ?? null,
  }));
  const notificationItems: NotificationAttentionItem[] = [...memoryApprovals, ...eventItems]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
  const memoryApprovalUnread = memoryApprovals.filter((item) => item.unread).length;
  const unreadCount = mobileUnreadCount + memoryApprovalUnread;
  return {
    sources,
    unreadCount,
    counts: {
      unread: unreadCount,
      todoAttention: todoAttention.length,
      emailAttention: emailAttention.length,
      chat: events.counts.chat,
      todos: todoAttention.length,
      todoUnread: todoAttention.filter((item) => item.unread).length,
      studio: events.counts.studio,
      automation: events.counts.automation,
      memoryApprovals: memoryApprovals.length,
    },
    sections: {
      notifications: notificationItems,
      todoAttention,
      emailAttention,
    },
  };
}
