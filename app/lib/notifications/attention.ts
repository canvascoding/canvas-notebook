import 'server-only';

import { listEmailAttention, type EmailAttentionItem } from '@/app/lib/email/inbox-attention';
import { countMobileUnreadNotifications, listMobileAggregateInbox, type MobileAggregateInboxItem } from '@/app/lib/mobile/inbox';
import { listTodos } from '@/app/lib/todos/store';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import { selectTodoAttention, type TodoAttentionReason } from './attention-policy';

export type NotificationAttentionItem = MobileAggregateInboxItem & {
  workspaceName: string | null;
  todoAttentionReason?: TodoAttentionReason;
};

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
  const [events, todos, emailLists, unreadCount] = await Promise.all([
    listMobileAggregateInbox({
      userId: input.userId,
      workspaces: input.workspaces,
      filter: 'notifications',
      limit: 12,
    }),
    listTodos(input.userId, {
      workspaceType: 'all',
      workspaceIds,
      status: 'open',
      limit: 200,
      sortAsOf: now,
    }),
    Promise.all(input.workspaces.map(async (workspace) => ({
      workspace,
      items: await listEmailAttention({ userId: input.userId, workspace }),
    }))),
    countMobileUnreadNotifications({ userId: input.userId, workspaces: input.workspaces }),
  ]);

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

  const notificationItems = events.items.map((item) => ({
    ...item,
    workspaceName: names.get(item.workspaceId) ?? null,
  }));
  return {
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
    },
    sections: {
      notifications: notificationItems,
      todoAttention,
      emailAttention,
    },
  };
}
