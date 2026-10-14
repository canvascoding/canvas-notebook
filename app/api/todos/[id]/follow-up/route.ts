import { requestedTodoApiMode, assertTodoReadActionSupported, todoForApi } from '@/app/lib/todos/api-mode';
import { NextRequest, NextResponse } from 'next/server';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { getErrorStatusCode, sendFollowUpMessage } from '@/app/lib/pi/runtime-service';
import { readOwnedAcceptedChatMessage } from '@/app/lib/pi/durable-message-admission';
import { captureChatTransportJson, resolveChatClientMessageId } from '@/app/lib/chat/message-submission';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-public-contracts';
import { MessageDeliveryError } from '@/app/lib/pi/message-delivery-receipt';
import {
  assertUnambiguousOwnedPiSessionForRuntime,
  PiSessionRuntimeAccessError,
} from '@/app/lib/pi/session-runtime-access';
import { applyTodoRateLimit, requireTodoSession, todoErrorResponse } from '@/app/lib/todos/api';
import { getTodo, updateTodo } from '@/app/lib/todos/store';
import { setTodoReadStateForUser } from '@/app/lib/todos/read-state-actions';
import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import { getUserPreferredLocale } from '@/app/lib/user-preferences';

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
  const todoMode = requestedTodoApiMode(request.nextUrl.searchParams);
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
    const payload = captureChatTransportJson(await request.json().catch(() => ({})));
    const clientMessageId = resolveChatClientMessageId(payload?.clientMessageId, undefined);
    if (typeof payload.expectedSessionId !== 'string' || !payload.expectedSessionId || payload.expectedSessionId.length > 256
      || payload.expectedSessionId !== payload.expectedSessionId.trim() || /[\p{Cc}\p{Cf}]/u.test(payload.expectedSessionId)) {
      return NextResponse.json({ success: false, code: 'AGENT_MESSAGE_ADMISSION_INVALID', error: 'The original linked chat session is required.' }, { status: 400 });
    }
    assertTodoReadActionSupported(todoMode, payload);
    const comment = normalizeComment(payload?.comment);
    const requestLocale = typeof payload?.locale === 'string'
      ? payload.locale
      : request.headers.get('accept-language') ?? 'en';
    const locale = await getUserPreferredLocale(session.user.id).catch(() => requestLocale);
    const todo = await getTodo(session.user.id, id);

    if (!todo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }

    if (!todo.sourceSessionId || !todo.sourceAgentId) {
      return NextResponse.json({ success: false, error: 'Todo has no linked agent session.' }, { status: 400 });
    }
    if (payload.expectedSessionId !== todo.sourceSessionId) {
      return NextResponse.json({ success: false, code: 'AGENT_EXTENSION_CONTEXT_DENIED', error: 'The to-do is now linked to a different chat session.' }, { status: 409 });
    }

    try {
      await assertUnambiguousOwnedPiSessionForRuntime({
        userId: session.user.id,
        sessionId: todo.sourceSessionId,
        agentId: todo.sourceAgentId,
      });
    } catch (error) {
      if (error instanceof PiSessionRuntimeAccessError) {
        return NextResponse.json({ success: false, error: error.message }, {
          status: error.code === 'SESSION_NOT_FOUND' ? 404 : 409,
        });
      }
      throw error;
    }

    const previous = await readOwnedAcceptedChatMessage({ userId: session.user.id, sessionId: todo.sourceSessionId,
      clientMessageId, expectedAgentId: todo.sourceAgentId });
    const preparedTodo = previous ? todo : await updateTodo(session.user.id, todo.id, {
      status: 'done',
      completionComment: comment,
      followUpError: null,
    });

    if (!preparedTodo) {
      return NextResponse.json({ success: false, error: 'Todo not found.' }, { status: 404 });
    }
    if (!previous && todoMode === 'legacy') {
      await setTodoReadStateForUser({ userId: session.user.id, todoId: todo.id, read: true });
    }

    const timestamp = Date.now();
    const message: Extract<AgentMessage, { role: 'user' }> & { clientMessageId: string } = {
      role: 'user',
      clientMessageId,
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
      }, {
        expectedAgentId: todo.sourceAgentId,
      }, {
        ...(payload.body === undefined ? {} : { body: payload.body }),
        ...(payload.selection === undefined ? {} : { selection: payload.selection }),
      });

      const updated = previous ? todo : await updateTodo(session.user.id, todo.id, {
        followUpSentAt: new Date(timestamp),
        followUpError: null,
      });

      return NextResponse.json({
        success: true,
        data: {
          todo: todoForApi(updated ?? preparedTodo, todoMode),
          sessionId: todo.sourceSessionId,
          chatHref: buildChatSessionHref(
            `/todos?todo=${encodeURIComponent(todo.id)}`,
            todo.sourceSessionId,
            todo.workspaceId,
          ),
          runtimeStatus: status,
        },
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Failed to send follow-up to linked session.';
      const updated = previous ? todo : await updateTodo(session.user.id, todo.id, {
        followUpError: messageText,
      });

      return NextResponse.json({
        success: false,
        error: messageText,
        ...(error instanceof Error && 'code' in error ? { code: String(error.code) } : {}),
        data: {
          todo: todoForApi(updated ?? preparedTodo, todoMode),
          sessionId: todo.sourceSessionId,
        },
      }, { status: getErrorStatusCode(error) });
    }
  } catch (error) {
    if (error instanceof AgentWorkflowError || error instanceof MessageDeliveryError
      || error instanceof Error && 'code' in error && error.code === 'INVALID_CLIENT_MESSAGE_ID') {
      return NextResponse.json({ success: false, error: error.message, code: error.code },
        { status: error.code === 'INVALID_CLIENT_MESSAGE_ID' ? 400 : getErrorStatusCode(error) });
    }
    return todoErrorResponse(error, 'Failed to send todo follow-up.');
  }
}
