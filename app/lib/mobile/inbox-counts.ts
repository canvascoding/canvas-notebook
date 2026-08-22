import 'server-only';

import { and, count, eq, or, type SQL } from 'drizzle-orm';

import { countEmailAttention } from '@/app/lib/email/inbox-attention';
import { db } from '@/app/lib/db';
import { todoItems } from '@/app/lib/db/schema';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import { countMobileUnreadNotifications } from './inbox';

export type MobileInboxCategoryCounts = {
  notifications: { badge: number };
  emails: { badge: number };
  todos: { badge: number };
};

function uniqueWorkspaces(workspaces: WorkspaceContext[]): WorkspaceContext[] {
  return [...new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace])).values()];
}

function openTodoCondition(userId: string, workspace: WorkspaceContext): SQL {
  if (workspace.workspaceType === 'personal') {
    if (workspace.legacy) {
      return and(
        eq(todoItems.userId, userId),
        eq(todoItems.workspaceType, 'personal'),
        eq(todoItems.scopeKind, 'user'),
        eq(todoItems.status, 'open'),
      )!;
    }
    return and(
      eq(todoItems.userId, userId),
      eq(todoItems.workspaceType, 'personal'),
      eq(todoItems.status, 'open'),
      or(
        eq(todoItems.scopeKind, 'user'),
        and(eq(todoItems.scopeKind, 'workspace'), eq(todoItems.workspaceId, workspace.workspaceId)),
      )!,
    )!;
  }
  if (!workspace.organizationId) {
    throw new Error('Shared Inbox workspace is missing its organization scope.');
  }
  return and(
    eq(todoItems.organizationId, workspace.organizationId),
    eq(todoItems.workspaceType, workspace.workspaceType),
    eq(todoItems.scopeKind, 'workspace'),
    eq(todoItems.workspaceId, workspace.workspaceId),
    eq(todoItems.status, 'open'),
  )!;
}

export async function countMobileOpenTodos(input: {
  userId: string;
  workspaces: WorkspaceContext[];
}): Promise<number> {
  const workspaces = uniqueWorkspaces(input.workspaces);
  const counts = await Promise.all(workspaces.map(async (workspace) => {
    const [result] = await db.select({ total: count() })
      .from(todoItems)
      .where(openTodoCondition(input.userId, workspace));
    return Number(result?.total ?? 0);
  }));
  return counts.reduce((total, count) => total + count, 0);
}

/**
 * The only source of truth for the three visible Inbox badges. Callers pass
 * already authorized workspace contexts; the email read model revalidates its
 * own scope before reading records.
 */
export async function getMobileInboxCategoryCounts(input: {
  userId: string;
  workspaces: WorkspaceContext[];
}): Promise<MobileInboxCategoryCounts> {
  const workspaces = uniqueWorkspaces(input.workspaces);
  const [notificationBadge, todoBadge, emailBadges] = await Promise.all([
    countMobileUnreadNotifications({ userId: input.userId, workspaces }),
    countMobileOpenTodos({ userId: input.userId, workspaces }),
    Promise.all(workspaces.map((workspace) => countEmailAttention({ userId: input.userId, workspace }))),
  ]);
  return {
    notifications: { badge: notificationBadge },
    emails: { badge: emailBadges.reduce((total, count) => total + count, 0) },
    todos: { badge: todoBadge },
  };
}
