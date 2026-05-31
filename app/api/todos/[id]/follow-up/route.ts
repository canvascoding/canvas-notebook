import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { sendFollowUpMessage } from '@/app/lib/pi/runtime-service';
import { applyTodoRateLimit, requireTodoSession, todoErrorResponse } from '@/app/lib/todos/api';
import { getTodo, updateTodo } from '@/app/lib/todos/store';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function normalizeComment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 5000) : null;
}

function buildFollowUpMessage(params: {
  todoTitle: string;
  todoDescription: string | null;
  comment: string | null;
  locale: string;
}): string {
  if (params.locale.startsWith('de')) {
    return [
      'Das folgende To-do wurde vom Nutzer erledigt.',
      '',
      `To-do: ${params.todoTitle}`,
      params.todoDescription ? `Kontext: ${params.todoDescription}` : null,
      params.comment ? `Kommentar des Nutzers: ${params.comment}` : null,
      '',
      'Bitte fahre in dieser Session mit dem nächsten sinnvollen Schritt fort.',
    ].filter(Boolean).join('\n');
  }

  return [
    'The following to-do was completed by the user.',
    '',
    `To-do: ${params.todoTitle}`,
    params.todoDescription ? `Context: ${params.todoDescription}` : null,
    params.comment ? `User comment: ${params.comment}` : null,
    '',
    'Please continue this session with the next appropriate step.',
  ].filter(Boolean).join('\n');
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireTodoSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyTodoRateLimit(request, 'todo-follow-up', 20);
  if (!limited.ok) {
    return limited.response;
  }

  const { id } = await context.params;

  try {
    const payload = await request.json().catch(() => ({}));
    const comment = normalizeComment(payload?.comment);
    const locale = typeof payload?.locale === 'string' ? payload.locale : request.headers.get('accept-language') ?? 'en';
    const todo = await getTodo(session.user.id, id);

    if (!todo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }

    if (!todo.sourceSessionId) {
      return NextResponse.json({ success: false, error: 'Todo has no linked session.' }, { status: 400 });
    }

    const linkedSession = await db.query.piSessions.findFirst({
      where: and(
        eq(piSessions.userId, session.user.id),
        eq(piSessions.sessionId, todo.sourceSessionId),
      ),
    });

    if (!linkedSession) {
      return NextResponse.json({ success: false, error: 'Linked session not found.' }, { status: 404 });
    }

    const preparedTodo = await updateTodo(session.user.id, todo.id, {
      status: 'done',
      seenAt: new Date(),
      completionComment: comment,
      followUpError: null,
    });

    if (!preparedTodo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }

    const timestamp = Date.now();
    const message: Extract<AgentMessage, { role: 'user' }> = {
      role: 'user',
      content: buildFollowUpMessage({
        todoTitle: preparedTodo.title,
        todoDescription: preparedTodo.description,
        comment,
        locale,
      }),
      timestamp,
    };

    try {
      const status = await sendFollowUpMessage(todo.sourceSessionId, session.user.id, message, {
        channelId: 'web',
        currentPage: '/todos',
        currentTime: new Date(timestamp).toISOString(),
      });

      const updated = await updateTodo(session.user.id, todo.id, {
        followUpSentAt: new Date(timestamp),
        followUpError: null,
      });

      return NextResponse.json({
        success: true,
        data: {
          todo: updated ?? preparedTodo,
          sessionId: todo.sourceSessionId,
          chatHref: `/todos?todo=${encodeURIComponent(todo.id)}&session=${encodeURIComponent(todo.sourceSessionId)}&chat=open`,
          runtimeStatus: status,
        },
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Failed to send follow-up to linked session.';
      const updated = await updateTodo(session.user.id, todo.id, {
        followUpError: messageText,
      });

      return NextResponse.json({
        success: false,
        error: messageText,
        data: {
          todo: updated ?? preparedTodo,
          sessionId: todo.sourceSessionId,
        },
      }, { status: 500 });
    }
  } catch (error) {
    return todoErrorResponse(error, 'Failed to send todo follow-up.');
  }
}
