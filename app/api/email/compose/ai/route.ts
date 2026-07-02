import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import { auth } from '@/app/lib/auth';
import { logEmailClientEvent } from '@/app/lib/email/logging';
import { generateEmailComposeBody, streamEmailComposeBody } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

type EmailAiDraftStreamEvent =
  | { type: 'status'; stage: 'reading_context' | 'writing' | 'ready'; label: string }
  | { type: 'delta'; delta: string }
  | { type: 'done'; body: string }
  | { type: 'error'; message: string };

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function encodeEvent(event: EmailAiDraftStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'email-compose-ai-post' });
  if (!limited.ok) return limited.response;

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let accountId = '';
  let messageId = '';
  let mode = '';

  try {
    const body = await request.json().catch(() => ({}));
    accountId = typeof body.accountId === 'string' ? body.accountId : '';
    messageId = typeof body.messageId === 'string' ? body.messageId : '';
    mode = typeof body.mode === 'string' ? body.mode : '';
    logEmailClientEvent('info', 'compose_ai_requested', {
      accountId,
      messageId,
      mode,
      operation: 'compose-ai',
      requestId,
      status: 'requested',
      userId: session.user.id,
    });

    const shouldStream = request.nextUrl.searchParams.get('stream') === '1'
      || request.headers.get('accept')?.includes('text/event-stream');

    if (shouldStream) {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      request.signal.addEventListener('abort', abort, { once: true });

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (event: EmailAiDraftStreamEvent) => {
            controller.enqueue(encodeEvent(event));
          };
          let draftBody = '';

          try {
            emit({ type: 'status', stage: 'reading_context', label: 'Preparing email context' });
            const data = await streamEmailComposeBody(
              session.user.id,
              body,
              { enforceReadPolicy: false, signal: abortController.signal },
            );

            emit({ type: 'status', stage: 'writing', label: 'Drafting email text' });
            for await (const event of data.events) {
              if (abortController.signal.aborted) return;

              if (event.type === 'text_delta' && event.delta) {
                draftBody += event.delta;
                emit({ type: 'delta', delta: event.delta });
              }

              if (event.type === 'done') {
                const finalBody = assistantText(event.message);
                if (!draftBody && finalBody) {
                  draftBody = finalBody;
                  emit({ type: 'delta', delta: finalBody });
                }
                if (!draftBody.trim()) throw new Error('Email AI returned no content.');
                emit({ type: 'status', stage: 'ready', label: 'Draft ready' });
                emit({ type: 'done', body: draftBody });
                logEmailClientEvent('info', 'compose_ai_succeeded', {
                  accountId,
                  durationMs: Date.now() - startedAt,
                  messageId,
                  mode,
                  operation: 'compose-ai',
                  requestId,
                  status: 'succeeded',
                  userId: session.user.id,
                });
                return;
              }

              if (event.type === 'error') {
                throw new Error(event.error.errorMessage || 'Email AI request failed.');
              }
            }

            throw new Error('Email AI returned no content.');
          } catch (error) {
            if (!abortController.signal.aborted) {
              const message = error instanceof Error ? error.message : 'Failed to generate email text';
              emit({ type: 'error', message });
              logEmailClientEvent('error', 'compose_ai_failed', {
                accountId,
                durationMs: Date.now() - startedAt,
                error,
                messageId,
                mode,
                operation: 'compose-ai',
                requestId,
                status: 'failed',
                userId: session.user.id,
              });
            }
          } finally {
            request.signal.removeEventListener('abort', abort);
            controller.close();
          }
        },
        cancel() {
          abortController.abort();
        },
      });

      return new Response(stream, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/event-stream; charset=utf-8',
        },
      });
    }

    const data = await generateEmailComposeBody(session.user.id, body, { enforceReadPolicy: false });
    logEmailClientEvent('info', 'compose_ai_succeeded', {
      accountId,
      durationMs: Date.now() - startedAt,
      messageId,
      mode,
      operation: 'compose-ai',
      requestId,
      status: 'succeeded',
      userId: session.user.id,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logEmailClientEvent('error', 'compose_ai_failed', {
      accountId,
      durationMs: Date.now() - startedAt,
      error,
      messageId,
      mode,
      operation: 'compose-ai',
      requestId,
      status: 'failed',
      userId: session.user.id,
    });
    const message = error instanceof Error ? error.message : 'Failed to generate email text';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
