import { NextRequest, NextResponse } from 'next/server';

import { getMobileTodo, MobileTodoError, serializeMobileTodo } from '@/app/lib/mobile/todos';
import { mobileTodosErrorResponse, mobileTodosResponseHeaders } from '@/app/lib/mobile/todos-route';
import { setTodoReadStateForUser } from '@/app/lib/todos/read-state-actions';
import { todoLifecycleAllowsUnread } from '@/app/lib/todos/read-state-policy';
import { archiveTodo, updateTodo, type TodoFileLinkInput, type TodoPriority, type TodoStatus } from '@/app/lib/todos/store';
import { isTodoIconKey } from '@/app/lib/todos/icons';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace, requireSessionWorkspace } from '@/app/lib/workspaces/request';

type RouteContext = { params: Promise<{ todoId: string }> };

function dateValue(value: unknown): Date | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new MobileTodoError('INVALID_DATE', 'Date value must be an ISO date.', 400);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new MobileTodoError('INVALID_DATE', 'Date value must be an ISO date.', 400);
  return date;
}

function hasTodoUpdate(payload: Record<string, unknown>): boolean {
  return [
    'title', 'description', 'priority', 'iconKey', 'dueAt', 'remindAt', 'status', 'assigneeUserId',
    'completionComment', 'fileLinks',
  ].some((key) => payload[key] !== undefined);
}

function requestedReadState(payload: Record<string, unknown>): boolean | undefined {
  if (payload.read !== undefined) {
    if (typeof payload.read !== 'boolean') throw new MobileTodoError('INVALID_READ_STATE', 'read must be a boolean.', 400);
    return payload.read;
  }
  return payload.markSeen === true ? true : undefined;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 90, windowMs: 60_000, keyPrefix: 'mobile-todo-get' });
  if (!limited.ok) return limited.response;
  try {
    const { todoId } = await context.params;
    const todo = await getMobileTodo({ userId: workspaceResult.session.user.id, workspace: workspaceResult.workspace, todoId });
    return NextResponse.json({ success: true, todo: serializeMobileTodo(todo) }, { headers: mobileTodosResponseHeaders });
  } catch (error) {
    return mobileTodosErrorResponse(error, '[API] Mobile To-do GET failed:');
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-todo-patch' });
  if (!limited.ok) return limited.response;
  try {
    const { todoId } = await context.params;
    const existingTodo = await getMobileTodo({ userId: workspaceResult.session.user.id, workspace: workspaceResult.workspace, todoId });
    const payload = await request.json() as Record<string, unknown>;
    const shouldUpdateTodo = hasTodoUpdate(payload);
    const read = requestedReadState(payload);
    const requestedStatus = payload.status === undefined ? undefined : payload.status as TodoStatus;
    if (payload.status !== undefined && !['open', 'done', 'archived'].includes(requestedStatus)) {
      throw new MobileTodoError('INVALID_STATUS', 'The To-do status is invalid.', 400);
    }
    if (shouldUpdateTodo) {
      const writeWorkspace = await requireSessionWorkspace(workspaceResult.session, {
        workspaceId: workspaceResult.workspace.workspaceId,
        permissions: 'canWrite',
      });
      if (writeWorkspace.response) return writeWorkspace.response;
    }
    const resultingStatus = requestedStatus ?? existingTodo.status;
    if (read === false && !todoLifecycleAllowsUnread(resultingStatus)) {
      throw new MobileTodoError('TODO_READ_STATE_CONFLICT', 'Completed or archived to-dos cannot be marked unread.', 409);
    }
    let todo = existingTodo;
    if (shouldUpdateTodo) {
      const updatedTodo = await updateTodo(workspaceResult.session.user.id, todoId, {
        ...(payload.title !== undefined ? { title: String(payload.title) } : {}),
        ...(payload.description !== undefined ? { description: typeof payload.description === 'string' ? payload.description : null } : {}),
        ...(payload.priority !== undefined ? { priority: payload.priority as TodoPriority } : {}),
        ...(payload.iconKey !== undefined ? { iconKey: isTodoIconKey(payload.iconKey) ? payload.iconKey : null } : {}),
        ...(payload.dueAt !== undefined ? { dueAt: dateValue(payload.dueAt) } : {}),
        ...(payload.remindAt !== undefined ? { remindAt: dateValue(payload.remindAt) } : {}),
        ...(requestedStatus !== undefined ? { status: requestedStatus } : {}),
        ...(payload.assigneeUserId !== undefined ? { assigneeUserId: typeof payload.assigneeUserId === 'string' ? payload.assigneeUserId : null } : {}),
        ...(payload.completionComment !== undefined ? { completionComment: typeof payload.completionComment === 'string' ? payload.completionComment : null } : {}),
        ...(payload.fileLinks !== undefined ? { fileLinks: Array.isArray(payload.fileLinks) ? payload.fileLinks as TodoFileLinkInput[] : [] } : {}),
      });
      if (!updatedTodo) throw new Error('To-do disappeared during update.');
      todo = updatedTodo;
    }
    if (read !== undefined) {
      todo = (await setTodoReadStateForUser({
        userId: workspaceResult.session.user.id,
        todoId,
        read,
      })).todo;
    }
    return NextResponse.json({ success: true, todo: serializeMobileTodo(todo) }, { headers: mobileTodosResponseHeaders });
  } catch (error) {
    return mobileTodosErrorResponse(error, '[API] Mobile To-do PATCH failed:');
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-todo-delete' });
  if (!limited.ok) return limited.response;
  try {
    const { todoId } = await context.params;
    await getMobileTodo({ userId: workspaceResult.session.user.id, workspace: workspaceResult.workspace, todoId });
    const todo = await archiveTodo(workspaceResult.session.user.id, todoId);
    if (!todo) throw new Error('To-do disappeared during archive.');
    return NextResponse.json({ success: true, todo: serializeMobileTodo(todo) }, { headers: mobileTodosResponseHeaders });
  } catch (error) {
    return mobileTodosErrorResponse(error, '[API] Mobile To-do DELETE failed:');
  }
}
