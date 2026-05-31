import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';

import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { piSessions, todoItems } from '@/app/lib/db/schema';
import { hasUnreadAssistantResponse } from '@/app/lib/chat/unread';
import { DEFAULT_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { listTodos, markTodoSeen } from '@/app/lib/todos/store';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type PatchPayload = {
  action?: 'mark_all_todos_seen' | 'mark_todo_seen';
  todoId?: string;
};

function endOfToday() {
  const date = new Date();
  date.setHours(23, 59, 59, 999);
  return date;
}

function isDueAttention(dueAt: Date | string | null, cutoff: Date) {
  if (!dueAt) return false;
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return false;
  return date <= cutoff;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'notifications-summary-get',
  });
  if (!limited.ok) return limited.response;

  const [sessionRows, todos] = await Promise.all([
    db
      .select({
        sessionId: piSessions.sessionId,
        title: piSessions.title,
        agentId: piSessions.agentId,
        lastMessageAt: piSessions.lastMessageAt,
        lastViewedAt: piSessions.lastViewedAt,
      })
      .from(piSessions)
      .where(eq(piSessions.userId, session.user.id))
      .orderBy(desc(piSessions.lastMessageAt), desc(piSessions.createdAt))
      .limit(100),
    listTodos(session.user.id, { status: 'active', limit: 200 }),
  ]);

  const unreadSessions = sessionRows.filter((row) => hasUnreadAssistantResponse(row.lastMessageAt, row.lastViewedAt));
  const todayCutoff = endOfToday();
  const unreadTodos = todos.filter((todo) => todo.status === 'open' && !todo.seenAt);
  const dueTodos = todos.filter((todo) => todo.status === 'open' && isDueAttention(todo.dueAt, todayCutoff));
  const todoAttentionMap = new Map([...unreadTodos, ...dueTodos].map((todo) => [todo.id, todo]));
  const todoAttentionItems = Array.from(todoAttentionMap.values())
    .sort((a, b) => {
      const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      return aDue - bDue || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 8);

  return NextResponse.json({
    success: true,
    data: {
      unreadCount: unreadSessions.length + unreadTodos.length,
      sessions: {
        unreadCount: unreadSessions.length,
        items: unreadSessions.slice(0, 5).map((item) => ({
          sessionId: item.sessionId,
          title: item.title || DEFAULT_SESSION_TITLE,
          agentId: item.agentId,
          lastMessageAt: item.lastMessageAt,
        })),
      },
      todos: {
        unreadCount: unreadTodos.length,
        dueCount: dueTodos.length,
        items: todoAttentionItems.map((todo) => ({
          id: todo.id,
          title: todo.title,
          priority: todo.priority,
          dueAt: todo.dueAt,
          seenAt: todo.seenAt,
          categoryName: todo.category?.name ?? null,
          isDue: dueTodos.some((dueTodo) => dueTodo.id === todo.id),
        })),
      },
    },
  });
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'notifications-summary-patch',
  });
  if (!limited.ok) return limited.response;

  const payload = (await request.json().catch(() => ({}))) as PatchPayload;
  const now = new Date();

  if (payload.action === 'mark_all_todos_seen') {
    await db
      .update(todoItems)
      .set({ seenAt: now, updatedAt: now })
      .where(and(
        eq(todoItems.userId, session.user.id),
        ne(todoItems.status, 'archived'),
        isNull(todoItems.seenAt),
      ));

    return NextResponse.json({ success: true, data: { seenAt: now.toISOString() } });
  }

  if (payload.action === 'mark_todo_seen' && payload.todoId) {
    const todo = await markTodoSeen(session.user.id, payload.todoId, now);
    if (!todo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: todo });
  }

  return NextResponse.json({ success: false, error: 'Invalid action.' }, { status: 400 });
}
