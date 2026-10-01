import 'server-only';

import { countEmailAttention } from '@/app/lib/email/inbox-attention';
import type { TodoApiMode } from '@/app/lib/todos/api-mode';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import { countMobileUnreadNotifications } from './inbox';
import { countMobileOpenTodos, uniqueWorkspaces } from './todo-counts';

export { countMobileOpenTodos } from './todo-counts';

export type MobileInboxCategoryCounts = {
  notifications: { badge: number };
  emails: { badge: number };
  todos: { badge: number };
};

/**
 * The only source of truth for the three visible Inbox badges. Callers pass
 * already authorized workspace contexts; the email read model revalidates its
 * own scope before reading records.
 */
export async function getMobileInboxCategoryCounts(input: {
  userId: string;
  workspaces: WorkspaceContext[];
  includeFileChanges?: boolean;
  todoMode?: TodoApiMode;
}): Promise<MobileInboxCategoryCounts> {
  const workspaces = uniqueWorkspaces(input.workspaces);
  const [notificationBadge, todoBadge, emailBadges] = await Promise.all([
    countMobileUnreadNotifications({
      userId: input.userId,
      workspaces,
      includeFileChanges: input.includeFileChanges,
    }),
    countMobileOpenTodos({ userId: input.userId, workspaces, todoMode: input.todoMode }),
    Promise.all(workspaces.map((workspace) => countEmailAttention({ userId: input.userId, workspace }))),
  ]);
  return {
    notifications: { badge: notificationBadge },
    emails: { badge: emailBadges.reduce((total, count) => total + count, 0) },
    todos: { badge: todoBadge },
  };
}
