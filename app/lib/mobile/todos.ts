import 'server-only';

import {
  getTodo,
  listTodos,
  type ListTodosOptions,
  type TodoWorkspaceType,
  type TodoWithRelations,
} from '@/app/lib/todos/store';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const MOBILE_TODO_STATUSES = ['active', 'open', 'done', 'archived', 'all'] as const;
export const MOBILE_TODO_DUE_FILTERS = ['overdue', 'today', 'upcoming'] as const;

type MobileTodoCursor = {
  workspaceId: string;
  signature: string;
  status: MobileTodo['status'];
  priority: MobileTodo['priority'];
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  sortAsOf: string;
  id: string;
};

export type MobileTodo = {
  id: string;
  title: string;
  description: string | null;
  status: 'open' | 'done' | 'archived';
  priority: 'low' | 'normal' | 'high';
  iconKey: string | null;
  dueAt: string | null;
  remindAt: string | null;
  seenAt: string | null;
  readAt: string | null;
  readState: 'read' | 'unread';
  completedAt: string | null;
  completionComment: string | null;
  followUpSentAt: string | null;
  followUpError: string | null;
  source: {
    type: 'user' | 'agent';
    agentId: string | null;
    sessionId: string | null;
  };
  category: { id: string; name: string } | null;
  createdBy: { id: string; name: string | null; email: string | null } | null;
  assignee: { id: string; name: string | null; email: string | null } | null;
  fileLinks: {
    id: string;
    workspaceId: string | null;
    workspaceType: TodoWorkspaceType;
    workspacePath: string;
    label: string | null;
  }[];
  scopeKind: 'user' | 'workspace';
  workspace: { id: string; name: string; type: TodoWorkspaceType } | null;
  workspaceId: string | null;
  workspaceType: string;
  createdAt: string;
  updatedAt: string;
};

export class MobileTodoError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'MobileTodoError';
  }
}

function workspaceOptions(workspace: WorkspaceContext): Pick<
  ListTodosOptions,
  'workspaceType' | 'organizationId' | 'workspaceId' | 'scopeKind'
> {
  if (workspace.legacy) {
    return { workspaceType: 'personal', scopeKind: 'user' };
  }
  if (workspace.workspaceType === 'organization' || workspace.workspaceType === 'team' || workspace.workspaceType === 'project') {
    return {
      workspaceType: workspace.workspaceType,
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      scopeKind: 'workspace',
    };
  }
  return { workspaceType: 'personal', workspaceId: workspace.workspaceId, scopeKind: 'workspace' };
}

export function mobileTodoBelongsToWorkspace(todo: TodoWithRelations, workspace: WorkspaceContext): boolean {
  if (workspace.workspaceType === 'personal') {
    return todo.workspaceType === 'personal'
      && (todo.scopeKind === 'user' || todo.workspaceId === workspace.workspaceId);
  }
  return todo.workspaceType === workspace.workspaceType && todo.workspaceId === workspace.workspaceId;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() || null;
}

export function serializeMobileTodo(todo: TodoWithRelations): MobileTodo {
  return {
    id: todo.id,
    title: todo.title,
    description: todo.description,
    status: todo.status as MobileTodo['status'],
    priority: todo.priority as MobileTodo['priority'],
    iconKey: todo.iconKey,
    dueAt: iso(todo.dueAt),
    remindAt: iso(todo.remindAt),
    seenAt: iso(todo.seenAt),
    readAt: iso(todo.readAt),
    readState: todo.readState,
    completedAt: iso(todo.completedAt),
    completionComment: todo.completionComment,
    followUpSentAt: iso(todo.followUpSentAt),
    followUpError: todo.followUpError,
    source: {
      type: todo.sourceType as MobileTodo['source']['type'],
      agentId: todo.sourceAgentId,
      sessionId: todo.sourceSessionId,
    },
    category: todo.category ? { id: todo.category.id, name: todo.category.name } : null,
    createdBy: todo.createdBy,
    assignee: todo.assignee,
    fileLinks: todo.fileLinks.map((link) => ({
      id: link.id,
      workspaceId: link.workspaceId,
      workspaceType: link.workspaceType as TodoWorkspaceType,
      workspacePath: link.workspacePath,
      label: link.label,
    })),
    scopeKind: todo.scopeKind as MobileTodo['scopeKind'],
    workspace: todo.workspace,
    workspaceId: todo.workspaceId,
    workspaceType: todo.workspaceType,
    createdAt: todo.createdAt.toISOString(),
    updatedAt: todo.updatedAt.toISOString(),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 30;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MobileTodoError('INVALID_LIMIT', 'The To-do page size is invalid.', 400);
  }
  return Math.min(value, 50);
}

function signature(input: {
  status: string;
  due: string;
  assigneeUserId: string;
  query: string;
}): string {
  return JSON.stringify(input);
}

function decodeCursor(value: string | null | undefined, workspaceId: string, expectedSignature: string): MobileTodoCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<MobileTodoCursor>;
    if (
      parsed.workspaceId !== workspaceId
      || parsed.signature !== expectedSignature
      || !['open', 'done', 'archived'].includes(parsed.status as MobileTodo['status'])
      || !['low', 'normal', 'high'].includes(parsed.priority as MobileTodo['priority'])
      || (parsed.dueAt !== null && (typeof parsed.dueAt !== 'string' || Number.isNaN(new Date(parsed.dueAt).getTime())))
      || typeof parsed.createdAt !== 'string'
      || Number.isNaN(new Date(parsed.createdAt).getTime())
      || typeof parsed.updatedAt !== 'string'
      || Number.isNaN(new Date(parsed.updatedAt).getTime())
      || typeof parsed.sortAsOf !== 'string'
      || Number.isNaN(new Date(parsed.sortAsOf).getTime())
      || typeof parsed.id !== 'string'
      || !parsed.id
    ) throw new Error('Invalid cursor');
    return parsed as MobileTodoCursor;
  } catch {
    throw new MobileTodoError('INVALID_CURSOR', 'The To-do cursor is invalid for this view.', 400);
  }
}

export async function listMobileTodos(input: {
  userId: string;
  workspace: WorkspaceContext;
  status?: string | null;
  due?: string | null;
  assigneeUserId?: string | null;
  query?: string | null;
  cursor?: string | null;
  limit?: number;
}) {
  const status = MOBILE_TODO_STATUSES.includes(input.status as typeof MOBILE_TODO_STATUSES[number])
    ? input.status as ListTodosOptions['status']
    : 'active';
  const due = MOBILE_TODO_DUE_FILTERS.includes(input.due as typeof MOBILE_TODO_DUE_FILTERS[number])
    ? input.due as ListTodosOptions['due']
    : undefined;
  const assigneeUserId = input.assigneeUserId?.trim().slice(0, 160) || '';
  const query = input.query?.trim().toLocaleLowerCase().slice(0, 120) || '';
  const cursorSignature = signature({ status: status || 'active', due: due || '', assigneeUserId, query });
  const cursor = decodeCursor(input.cursor, input.workspace.workspaceId, cursorSignature);
  const limit = normalizeLimit(input.limit);
  const sortAsOf = cursor ? new Date(cursor.sortAsOf) : new Date();
  if (cursor) {
    const anchor = await getTodo(input.userId, cursor.id);
    if (
      !anchor
      || !mobileTodoBelongsToWorkspace(anchor, input.workspace)
      || anchor.status !== cursor.status
      || anchor.priority !== cursor.priority
      || (anchor.dueAt?.toISOString() || null) !== cursor.dueAt
      || anchor.createdAt.toISOString() !== cursor.createdAt
      || anchor.updatedAt.toISOString() !== cursor.updatedAt
    ) {
      throw new MobileTodoError('STALE_CURSOR', 'The To-do list changed. Refresh and retry.', 409);
    }
  }
  const todos = await listTodos(input.userId, {
    ...workspaceOptions(input.workspace),
    status,
    due,
    assigneeUserId: assigneeUserId || undefined,
    query: query || undefined,
    sortAsOf,
    beforeCursor: cursor ? {
      status: cursor.status,
      priority: cursor.priority,
      dueAt: cursor.dueAt ? new Date(cursor.dueAt) : null,
      createdAt: new Date(cursor.createdAt),
      id: cursor.id,
    } : undefined,
    limit: limit + 1,
  });
  const page = todos.slice(0, limit);
  const last = page.at(-1);
  return {
    todos: page.map(serializeMobileTodo),
    nextCursor: todos.length > limit && last
      ? Buffer.from(JSON.stringify({
          workspaceId: input.workspace.workspaceId,
          signature: cursorSignature,
          status: last.status as MobileTodo['status'],
          priority: last.priority as MobileTodo['priority'],
          dueAt: last.dueAt?.toISOString() || null,
          createdAt: last.createdAt.toISOString(),
          updatedAt: last.updatedAt.toISOString(),
          sortAsOf: sortAsOf.toISOString(),
          id: last.id,
        } satisfies MobileTodoCursor), 'utf8').toString('base64url')
      : null,
  };
}

export async function getMobileTodo(input: { userId: string; workspace: WorkspaceContext; todoId: string }) {
  const todo = await getTodo(input.userId, input.todoId);
  if (!todo || !mobileTodoBelongsToWorkspace(todo, input.workspace)) {
    throw new MobileTodoError('TODO_NOT_FOUND', 'The To-do was not found in this workspace.', 404);
  }
  return todo;
}
