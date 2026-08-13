import { NextRequest, NextResponse } from 'next/server';

import { listMobileTodos, MobileTodoError, serializeMobileTodo } from '@/app/lib/mobile/todos';
import { mobileTodosErrorResponse, mobileTodosResponseHeaders } from '@/app/lib/mobile/todos-route';
import { createTodo, type TodoFileLinkInput, type TodoPriority } from '@/app/lib/todos/store';
import { USER_TODO_SCOPE, parseTodoScopeKind, todoScopeForWorkspace } from '@/app/lib/todos/scope';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

function dateValue(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new MobileTodoError('INVALID_DATE', 'dueAt must be an ISO date.', 400);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new MobileTodoError('INVALID_DATE', 'dueAt must be an ISO date.', 400);
  return date;
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-todos-get' });
  if (!limited.ok) return limited.response;
  try {
    const limitValue = request.nextUrl.searchParams.get('limit');
    const data = await listMobileTodos({
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      status: request.nextUrl.searchParams.get('status'),
      due: request.nextUrl.searchParams.get('due'),
      assigneeUserId: request.nextUrl.searchParams.get('assigneeUserId'),
      query: request.nextUrl.searchParams.get('query'),
      cursor: request.nextUrl.searchParams.get('cursor'),
      limit: limitValue === null ? undefined : Number(limitValue),
    });
    return NextResponse.json({ success: true, ...data }, { headers: mobileTodosResponseHeaders });
  } catch (error) {
    return mobileTodosErrorResponse(error, '[API] Mobile To-dos GET failed:');
  }
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-todos-post' });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json() as Record<string, unknown>;
    const parsedScopeKind = parseTodoScopeKind(payload.scopeKind);
    if (payload.scopeKind !== undefined && !parsedScopeKind) {
      throw new MobileTodoError('INVALID_SCOPE', 'The To-do scope is invalid.', 400);
    }
    const scopeKind = parsedScopeKind ?? (workspaceResult.workspace.legacy ? 'user' : 'workspace');
    if (scopeKind === 'workspace' && workspaceResult.workspace.legacy) {
      throw new MobileTodoError('INVALID_SCOPE', 'This legacy personal workspace only supports user-scoped To-dos.', 400);
    }
    if (scopeKind === 'user' && workspaceResult.workspace.workspaceType !== 'personal') {
      throw new MobileTodoError('INVALID_SCOPE', 'Shared workspace To-dos must stay in their workspace.', 400);
    }
    const todo = await createTodo(workspaceResult.session.user.id, {
      ...(scopeKind === 'user' ? USER_TODO_SCOPE : todoScopeForWorkspace(workspaceResult.workspace)),
      title: typeof payload.title === 'string' ? payload.title : '',
      description: typeof payload.description === 'string' ? payload.description : null,
      categoryName: typeof payload.categoryName === 'string' ? payload.categoryName : null,
      priority: typeof payload.priority === 'string' ? payload.priority as TodoPriority : undefined,
      dueAt: dateValue(payload.dueAt),
      assigneeUserId: typeof payload.assigneeUserId === 'string' ? payload.assigneeUserId : null,
      sourceType: 'user',
      seenAt: new Date(),
      fileLinks: Array.isArray(payload.fileLinks) ? payload.fileLinks as TodoFileLinkInput[] : undefined,
    });
    return NextResponse.json({ success: true, todo: serializeMobileTodo(todo) }, { status: 201, headers: mobileTodosResponseHeaders });
  } catch (error) {
    return mobileTodosErrorResponse(error, '[API] Mobile To-dos POST failed:');
  }
}
