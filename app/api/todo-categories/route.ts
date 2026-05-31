import { NextRequest, NextResponse } from 'next/server';

import { applyTodoRateLimit, requireTodoSession, todoErrorResponse } from '@/app/lib/todos/api';
import { createTodoCategory, ensureTodoCategories, listTodoCategories } from '@/app/lib/todos/store';

export async function GET(request: NextRequest) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-categories-get');
  if (!limited.ok) {
    return limited.response;
  }

  const { searchParams } = new URL(request.url);
  const includeArchived = searchParams.get('includeArchived') === 'true';
  const categories = includeArchived
    ? await listTodoCategories(session.user.id, { includeArchived: true })
    : await ensureTodoCategories(session.user.id);

  return NextResponse.json({ success: true, data: categories });
}

export async function POST(request: NextRequest) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-categories-post', 30);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const category = await createTodoCategory(session.user.id, {
      name: String(payload?.name ?? ''),
      color: typeof payload?.color === 'string' ? payload.color : null,
      icon: typeof payload?.icon === 'string' ? payload.icon : null,
      sortOrder: typeof payload?.sortOrder === 'number' ? payload.sortOrder : undefined,
    });

    return NextResponse.json({ success: true, data: category }, { status: 201 });
  } catch (error) {
    return todoErrorResponse(error, 'Failed to create category.');
  }
}
