import { NextRequest, NextResponse } from 'next/server';

import { applyTodoRateLimit, parseOptionalDate, requireTodoSession, todoErrorResponse } from '@/app/lib/todos/api';
import {
  requireSessionWorkspace,
  type RequestWorkspacePermission,
  type RequestWorkspaceSession,
} from '@/app/lib/workspaces/request';
import {
  TODO_PRIORITIES,
  TODO_SOURCE_TYPES,
  TODO_STATUSES,
  createTodo,
  listTodos,
  type ListTodosOptions,
  type TodoFileLinkInput,
  type TodoPriority,
  type TodoSourceType,
  type TodoStatus,
} from '@/app/lib/todos/store';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

function parseStatus(value: string | null): ListTodosOptions['status'] {
  if (!value) return undefined;
  if (value === 'active' || value === 'all' || TODO_STATUSES.includes(value as TodoStatus)) {
    return value as ListTodosOptions['status'];
  }
  return undefined;
}

function parsePriority(value: unknown): TodoPriority | undefined {
  return typeof value === 'string' && TODO_PRIORITIES.includes(value as TodoPriority)
    ? value as TodoPriority
    : undefined;
}

function parseSourceType(value: string | null): TodoSourceType | undefined {
  return value && TODO_SOURCE_TYPES.includes(value as TodoSourceType)
    ? value as TodoSourceType
    : undefined;
}

function parseDue(value: string | null): ListTodosOptions['due'] {
  return value === 'overdue' || value === 'today' || value === 'upcoming' ? value : undefined;
}

function parseFileLinks(value: unknown): TodoFileLinkInput[] | undefined {
  return Array.isArray(value) ? value as TodoFileLinkInput[] : undefined;
}

function todoWorkspaceScope(workspace: WorkspaceContext | null) {
  if (!workspace || workspace.workspaceType !== 'team') {
    return { workspaceType: 'personal' as const };
  }
  return {
    workspaceType: 'team' as const,
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
  };
}

async function resolveRequestedWorkspace(
  session: RequestWorkspaceSession,
  workspaceId: string | null | undefined,
  permissions?: RequestWorkspacePermission | RequestWorkspacePermission[],
) {
  if (!workspaceId) return { workspace: null, response: null };
  return requireSessionWorkspace(session, { workspaceId, permissions });
}

export async function GET(request: NextRequest) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todos-get');
  if (!limited.ok) {
    return limited.response;
  }

  const { searchParams } = new URL(request.url);
  const workspaceResult = await resolveRequestedWorkspace(session, searchParams.get('workspaceId'), 'canRead');
  if (workspaceResult.response) {
    return workspaceResult.response;
  }
  const limit = Number(searchParams.get('limit') || 100);
  const todos = await listTodos(session.user.id, {
    ...todoWorkspaceScope(workspaceResult.workspace),
    status: parseStatus(searchParams.get('status')),
    categoryId: searchParams.get('categoryId') || undefined,
    sourceType: parseSourceType(searchParams.get('sourceType')),
    assigneeUserId: searchParams.get('assigneeUserId') || undefined,
    due: parseDue(searchParams.get('due')),
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return NextResponse.json({ success: true, data: todos });
}

export async function POST(request: NextRequest) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todos-post', 30);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const workspaceResult = await resolveRequestedWorkspace(
      session,
      typeof payload?.workspaceId === 'string' ? payload.workspaceId : null,
      'canWrite',
    );
    if (workspaceResult.response) {
      return workspaceResult.response;
    }
    const todo = await createTodo(session.user.id, {
      ...todoWorkspaceScope(workspaceResult.workspace),
      title: String(payload?.title ?? ''),
      description: typeof payload?.description === 'string' ? payload.description : null,
      categoryId: typeof payload?.categoryId === 'string' ? payload.categoryId : null,
      categoryName: typeof payload?.categoryName === 'string' ? payload.categoryName : null,
      priority: parsePriority(payload?.priority),
      dueAt: parseOptionalDate(payload?.dueAt) ?? null,
      assigneeUserId: typeof payload?.assigneeUserId === 'string' ? payload.assigneeUserId : null,
      sourceType: 'user',
      seenAt: new Date(),
      fileLinks: parseFileLinks(payload?.fileLinks),
    });

    return NextResponse.json({ success: true, data: todo }, { status: 201 });
  } catch (error) {
    return todoErrorResponse(error, 'Failed to create todo.');
  }
}
