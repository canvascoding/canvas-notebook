import { NextRequest, NextResponse } from 'next/server';

import { listMobileTodos, MobileTodoError, serializeMobileTodo } from '@/app/lib/mobile/todos';
import { mobileTodosErrorResponse, mobileTodosResponseHeaders } from '@/app/lib/mobile/todos-route';
import { createTodo, type TodoFileLinkInput, type TodoPriority } from '@/app/lib/todos/store';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const dynamic = 'force-dynamic';

function workspaceInput(workspace: WorkspaceContext) {
  if (workspace.workspaceType === 'organization' || workspace.workspaceType === 'team' || workspace.workspaceType === 'project') {
    return { workspaceType: workspace.workspaceType, organizationId: workspace.organizationId, workspaceId: workspace.workspaceId } as const;
  }
  return { workspaceType: 'personal' as const };
}

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
    const todo = await createTodo(workspaceResult.session.user.id, {
      ...workspaceInput(workspaceResult.workspace),
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
