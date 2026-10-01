import 'server-only';

import { and, count, eq, or, type SQL } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { todoItems } from '@/app/lib/db/schema';
import type { TodoApiMode } from '@/app/lib/todos/api-mode';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export function uniqueWorkspaces(workspaces: WorkspaceContext[]): WorkspaceContext[] {
  return [...new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace])).values()];
}

function openTodoCondition(userId: string, workspace: WorkspaceContext, todoMode: TodoApiMode = 'legacy'): SQL {
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
        todoMode === 'legacy' || workspace.isDefault ? eq(todoItems.scopeKind, 'user') : undefined,
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
  todoMode?: TodoApiMode;
}): Promise<number> {
  const workspaces = uniqueWorkspaces(input.workspaces);
  if (input.todoMode === 'lifecycle') {
    if (!workspaces.length) return 0;
    // One scoped predicate counts a user-scoped Todo once across personal sources.
    const [result] = await db.select({ total: count() }).from(todoItems)
      .where(or(...workspaces.map((workspace) => openTodoCondition(input.userId, workspace, 'lifecycle'))));
    return Number(result?.total ?? 0);
  }
  const counts = await Promise.all(workspaces.map(async (workspace) => {
    const [result] = await db.select({ total: count() })
      .from(todoItems)
      .where(openTodoCondition(input.userId, workspace));
    return Number(result?.total ?? 0);
  }));
  return counts.reduce((total, count) => total + count, 0);
}
