import { NextRequest } from 'next/server';

import { POST as sendWebTodoFollowUp } from '@/app/api/todos/[id]/follow-up/route';
import { getMobileTodo } from '@/app/lib/mobile/todos';
import { mobileTodosErrorResponse } from '@/app/lib/mobile/todos-route';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

type RouteContext = { params: Promise<{ todoId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'mobile-todo-follow-up' });
  if (!limited.ok) return limited.response;
  try {
    const { todoId } = await context.params;
    await getMobileTodo({ userId: workspaceResult.session.user.id, workspace: workspaceResult.workspace, todoId });
    return sendWebTodoFollowUp(request, { params: Promise.resolve({ id: todoId }) });
  } catch (error) {
    return mobileTodosErrorResponse(error, '[API] Mobile To-do follow-up failed:');
  }
}
