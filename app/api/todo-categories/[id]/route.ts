import { NextRequest, NextResponse } from 'next/server';

import { applyTodoRateLimit, requireTodoSession, todoErrorResponse } from '@/app/lib/todos/api';
import { archiveTodoCategory, updateTodoCategory } from '@/app/lib/todos/store';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-category-patch', 30);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const { id } = await context.params;
    const category = await updateTodoCategory(session.user.id, id, {
      ...(payload?.name !== undefined ? { name: String(payload.name) } : {}),
      ...(payload?.color !== undefined ? { color: typeof payload.color === 'string' ? payload.color : null } : {}),
      ...(payload?.icon !== undefined ? { icon: typeof payload.icon === 'string' ? payload.icon : null } : {}),
      ...(payload?.sortOrder !== undefined ? { sortOrder: Number(payload.sortOrder) } : {}),
    });

    if (!category) {
      return NextResponse.json({ success: false, error: 'Category not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: category });
  } catch (error) {
    return todoErrorResponse(error, 'Failed to update category.');
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-category-delete', 30);
  if (!limited.ok) {
    return limited.response;
  }

  const { id } = await context.params;
  const category = await archiveTodoCategory(session.user.id, id);
  if (!category) {
    return NextResponse.json({ success: false, error: 'Category not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: category });
}
