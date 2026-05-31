import { NextRequest, NextResponse } from 'next/server';

import { applyTodoRateLimit, parseOptionalDate, requireTodoSession, todoErrorResponse } from '@/app/lib/todos/api';
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  archiveTodo,
  getTodo,
  updateTodo,
  type TodoFileLinkInput,
  type TodoPriority,
  type TodoStatus,
} from '@/app/lib/todos/store';

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

export async function GET(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-get');
  if (!limited.ok) {
    return limited.response;
  }

  const { id } = await context.params;
  const todo = await getTodo(session.user.id, id);
  if (!todo) {
    return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: todo });
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
    const payload = await request.json();
    const { id } = await context.params;
    const todo = await updateTodo(session.user.id, id, {
      ...(payload?.title !== undefined ? { title: String(payload.title) } : {}),
      ...(payload?.description !== undefined ? { description: typeof payload.description === 'string' ? payload.description : null } : {}),
      ...(payload?.categoryId !== undefined ? { categoryId: typeof payload.categoryId === 'string' ? payload.categoryId : null } : {}),
      ...(payload?.priority !== undefined ? { priority: parsePriority(payload.priority) } : {}),
      ...(payload?.dueAt !== undefined ? { dueAt: parseOptionalDate(payload.dueAt) ?? null } : {}),
      ...(payload?.status !== undefined ? { status: parseStatus(payload.status) } : {}),
      ...(payload?.markSeen === true ? { seenAt: new Date() } : {}),
      ...(payload?.seenAt !== undefined ? { seenAt: parseOptionalDate(payload.seenAt) ?? null } : {}),
      ...(payload?.fileLinks !== undefined ? { fileLinks: parseFileLinks(payload.fileLinks) ?? [] } : {}),
    });

    if (!todo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
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

  const { id } = await context.params;
  const todo = await archiveTodo(session.user.id, id);
  if (!todo) {
    return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: todo });
}
