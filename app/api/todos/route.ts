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
import { isTodoIconKey, type TodoIconKey } from '@/app/lib/todos/icons';
import {
  USER_TODO_SCOPE,
  parseTodoScopeKind,
  todoScopeForWorkspace,
} from '@/app/lib/todos/scope';
import { listReadableTodoWorkspaceIds } from '@/app/lib/todos/list-policy';

const TODO_LIST_SCOPES = ['personal', 'workspace', 'global'] as const;
type TodoListScope = typeof TODO_LIST_SCOPES[number];

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
  return value === 'overdue' || value === 'today' || value === 'upcoming' || value === 'none' ? value : undefined;
}

function parseListScope(value: string | null): TodoListScope | undefined {
  return value && TODO_LIST_SCOPES.includes(value as TodoListScope)
    ? value as TodoListScope
    : undefined;
}

function parseFileLinks(value: unknown): TodoFileLinkInput[] | undefined {
  return Array.isArray(value) ? value as TodoFileLinkInput[] : undefined;
}

function parseIconKey(value: unknown): TodoIconKey | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isTodoIconKey(value)) throw new Error('Invalid to-do icon.');
  return value;
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
  const requestedWorkspaceId = searchParams.get('workspaceId')?.trim() || null;
  const rawScope = searchParams.get('scope');
  const requestedScope = parseListScope(rawScope);
  if (rawScope && !requestedScope) {
    return NextResponse.json({ success: false, error: 'Invalid todo list scope.', code: 'INVALID_TODO_FILTER' }, { status: 400 });
  }
  const rawScopeKind = searchParams.get('scopeKind');
  const parsedScopeKind = parseTodoScopeKind(rawScopeKind);
  if (rawScopeKind && !parsedScopeKind) {
    return NextResponse.json({ success: false, error: 'Invalid todo scope.' }, { status: 400 });
  }
  if (requestedScope && rawScopeKind) {
    return NextResponse.json({ success: false, error: 'Use either scope or scopeKind.', code: 'INVALID_TODO_FILTER' }, { status: 400 });
  }
  const scope = requestedScope ?? (parsedScopeKind === 'workspace' || requestedWorkspaceId ? 'workspace' : 'personal');
  if (scope !== 'workspace' && requestedWorkspaceId) {
    return NextResponse.json({ success: false, error: 'workspaceId is only valid for workspace scope.', code: 'INVALID_TODO_FILTER' }, { status: 400 });
  }
  const workspaceResult = await resolveRequestedWorkspace(
    session,
    scope === 'workspace' ? requestedWorkspaceId : null,
    'canRead',
  );
  if (workspaceResult.response) {
    return workspaceResult.response;
  }
  if (scope === 'workspace' && !workspaceResult.workspace) {
    return NextResponse.json({ success: false, error: 'workspaceId is required for workspace-scoped to-dos.' }, { status: 400 });
  }
  const rawPriority = searchParams.get('priority');
  const priority = parsePriority(rawPriority);
  if (rawPriority && !priority) {
    return NextResponse.json({ success: false, error: 'Invalid todo priority.', code: 'INVALID_TODO_FILTER' }, { status: 400 });
  }
  const rawDue = searchParams.get('due');
  const due = parseDue(rawDue);
  if (rawDue && !due) {
    return NextResponse.json({ success: false, error: 'Invalid due filter.', code: 'INVALID_TODO_FILTER' }, { status: 400 });
  }
  const limit = Number(searchParams.get('limit') || 100);
  try {
    const globalWorkspaceIds = scope === 'global'
      ? await listReadableTodoWorkspaceIds(session.user)
      : undefined;
    const todos = await listTodos(session.user.id, {
      ...(scope === 'global'
        ? { workspaceType: 'all' as const, workspaceIds: globalWorkspaceIds }
        : workspaceResult.workspace ? todoScopeForWorkspace(workspaceResult.workspace) : USER_TODO_SCOPE),
      status: parseStatus(searchParams.get('status')),
      categoryId: searchParams.get('categoryId') || undefined,
      sourceType: parseSourceType(searchParams.get('sourceType')),
      priority,
      assigneeUserId: searchParams.get('assigneeUserId') || undefined,
      createdByUserId: searchParams.get('createdByUserId') || undefined,
      due,
      query: searchParams.get('query') || undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return NextResponse.json({ success: true, data: todos, scope: { kind: scope, workspaceId: workspaceResult.workspace?.workspaceId ?? null } });
  } catch (error) {
    return todoErrorResponse(error, 'Failed to list todos.');
  }
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
    const requestedWorkspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId : null;
    const parsedScopeKind = parseTodoScopeKind(payload?.scopeKind);
    if (payload?.scopeKind !== undefined && !parsedScopeKind) {
      return NextResponse.json({ success: false, error: 'Invalid todo scope.' }, { status: 400 });
    }
    const scopeKind = parsedScopeKind ?? (requestedWorkspaceId ? 'workspace' : 'user');
    const workspaceResult = await resolveRequestedWorkspace(
      session,
      scopeKind === 'workspace' ? requestedWorkspaceId : null,
      'canWrite',
    );
    if (workspaceResult.response) {
      return workspaceResult.response;
    }
    if (scopeKind === 'workspace' && !workspaceResult.workspace) {
      return NextResponse.json({ success: false, error: 'workspaceId is required for workspace-scoped to-dos.' }, { status: 400 });
    }
    const todo = await createTodo(session.user.id, {
      ...(workspaceResult.workspace ? todoScopeForWorkspace(workspaceResult.workspace) : USER_TODO_SCOPE),
      title: String(payload?.title ?? ''),
      description: typeof payload?.description === 'string' ? payload.description : null,
      categoryId: typeof payload?.categoryId === 'string' ? payload.categoryId : null,
      categoryName: typeof payload?.categoryName === 'string' ? payload.categoryName : null,
      priority: parsePriority(payload?.priority),
      iconKey: parseIconKey(payload?.iconKey),
      dueAt: parseOptionalDate(payload?.dueAt) ?? null,
      remindAt: parseOptionalDate(payload?.remindAt) ?? null,
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
