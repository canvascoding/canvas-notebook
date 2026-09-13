import { NextRequest, NextResponse } from 'next/server';

import { requireTodoSession, applyTodoRateLimit, todoErrorResponse } from '@/app/lib/todos/api';
import { parseTodoBulkInput, TodoBulkError } from '@/app/lib/todos/bulk-policy';
import { mutateTodosBulk } from '@/app/lib/todos/store';
import { createTodoWritePolicy } from '@/app/lib/todos/write-policy';

export async function POST(request: NextRequest) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) return response;
  const limited = applyTodoRateLimit(request, 'todos-bulk', 10);
  if (!limited.ok) return limited.response;
  try {
    const body = await request.text();
    if (body.length > 200_000) return NextResponse.json({ success: false, code: 'INVALID_BULK_INPUT' }, { status: 413 });
    const input = parseTodoBulkInput(JSON.parse(body));
    const policy = createTodoWritePolicy(session);
    const data = await mutateTodosBulk({ ...input, userId: session.user.id, authorize: policy.authorize });
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof TodoBulkError) {
      return NextResponse.json({ success: false, code: error.code, error: error.message, ids: error.ids }, {
        status: error.code === 'TODO_BULK_CONFLICT' || error.code === 'TODO_BULK_STATUS' ? 409 : 400,
      });
    }
    return todoErrorResponse(error, 'Could not update the selected to-dos.');
  }
}
