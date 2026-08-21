import { NextRequest, NextResponse } from 'next/server';

import { applyTodoRateLimit, parseOptionalDate, requireTodoSession, todoErrorResponse } from '@/app/lib/todos/api';
import { requireSessionWorkspace, type RequestWorkspaceSession } from '@/app/lib/workspaces/request';
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  archiveTodo,
  getTodo,
  updateTodo,
  type TodoFileLinkInput,
  type TodoWithRelations,
  type TodoPriority,
  type TodoStatus,
} from '@/app/lib/todos/store';
import { setTodoReadStateForUser } from '@/app/lib/todos/read-state-actions';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function parseStatus(value: unknown): TodoStatus | undefined {
  return typeof value === 'string' && TODO_STATUSES.includes(value as TodoStatus)
    ? value as TodoStatus
    : undefined;
}

function parsePriority(value: unknown): TodoPriority | undefined {
  return typeof value === 'string' && TODO_PRIORITIES.includes(value as TodoPriority)
    ? value as TodoPriority
    : undefined;
}

function parseFileLinks(value: unknown): TodoFileLinkInput[] | undefined {
  return Array.isArray(value) ? value as TodoFileLinkInput[] : undefined;
}

function parseRequestedReadState(payload: Record<string, unknown>): { read: boolean; readAt?: Date } | undefined {
  if (payload.read !== undefined) {
    if (typeof payload.read !== 'boolean') throw new Error('read must be a boolean.');
    return { read: payload.read };
  }
  if (payload.markSeen === true) return { read: true };
  if (payload.seenAt !== undefined) {
    const readAt = parseOptionalDate(payload.seenAt);
    return readAt ? { read: true, readAt } : { read: false };
  }
  return undefined;
}

function hasTodoUpdate(payload: Record<string, unknown>): boolean {
  return [
    'title', 'description', 'categoryId', 'priority', 'dueAt', 'status',
    'assigneeUserId', 'completionComment', 'fileLinks',
  ].some((key) => payload[key] !== undefined);
}

async function requireTodoWriteWorkspace(
  session: RequestWorkspaceSession,
  todo: TodoWithRelations,
) {
  if (todo.workspaceType !== 'team' || !todo.workspaceId) {
    return null;
  }
  const workspaceResult = await requireSessionWorkspace(session, {
    workspaceId: todo.workspaceId,
    permissions: 'canWrite',
  });
  return workspaceResult.response;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-get');
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const { id } = await context.params;
    const todo = await getTodo(session.user.id, id);
    if (!todo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: todo });
  } catch (error) {
    return todoErrorResponse(error, 'Failed to load todo.');
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-patch', 60);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json() as Record<string, unknown>;
    const { id } = await context.params;
    const existingTodo = await getTodo(session.user.id, id);
    if (!existingTodo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }
    const requestedReadState = parseRequestedReadState(payload);
    const shouldUpdateTodo = hasTodoUpdate(payload);
    if (shouldUpdateTodo) {
      const permissionResponse = await requireTodoWriteWorkspace(session, existingTodo);
      if (permissionResponse) return permissionResponse;
    }

    let todo = existingTodo;
    if (shouldUpdateTodo) {
      const updatedTodo = await updateTodo(session.user.id, id, {
        ...(payload.title !== undefined ? { title: String(payload.title) } : {}),
        ...(payload.description !== undefined ? { description: typeof payload.description === 'string' ? payload.description : null } : {}),
        ...(payload.categoryId !== undefined ? { categoryId: typeof payload.categoryId === 'string' ? payload.categoryId : null } : {}),
        ...(payload.priority !== undefined ? { priority: parsePriority(payload.priority) } : {}),
        ...(payload.dueAt !== undefined ? { dueAt: parseOptionalDate(payload.dueAt) ?? null } : {}),
        ...(payload.status !== undefined ? { status: parseStatus(payload.status) } : {}),
        ...(payload.assigneeUserId !== undefined ? {
        assigneeUserId: typeof payload.assigneeUserId === 'string' ? payload.assigneeUserId : null,
      } : {}),
        ...(payload.completionComment !== undefined ? {
        completionComment: typeof payload.completionComment === 'string' ? payload.completionComment : null,
      } : {}),
        ...(payload.fileLinks !== undefined ? { fileLinks: parseFileLinks(payload.fileLinks) ?? [] } : {}),
      });
      if (!updatedTodo) return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
      todo = updatedTodo;
    }
    if (requestedReadState) {
      todo = (await setTodoReadStateForUser({
        userId: session.user.id,
        todoId: id,
        ...requestedReadState,
      })).todo;
    }

    return NextResponse.json({ success: true, data: todo });
  } catch (error) {
    return todoErrorResponse(error, 'Failed to update todo.');
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-delete', 30);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const { id } = await context.params;
    const existingTodo = await getTodo(session.user.id, id);
    if (!existingTodo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }
    const permissionResponse = await requireTodoWriteWorkspace(session, existingTodo);
    if (permissionResponse) {
      return permissionResponse;
    }

    const todo = await archiveTodo(session.user.id, id);
    if (!todo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: todo });
  } catch (error) {
    return todoErrorResponse(error, 'Failed to delete todo.');
  }
}
