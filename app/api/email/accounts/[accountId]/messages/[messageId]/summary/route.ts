import { NextRequest, NextResponse } from 'next/server';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import { auth } from '@/app/lib/auth';
import { streamEmailMessageSummary, summarizeEmailMessage } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function encodeSummaryStreamEvent(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ accountId: string; messageId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'email-message-summary-post' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId, messageId } = await params;
    const body = await request.json().catch(() => ({}));
    const folder = stringValue((body as { folder?: unknown }).folder);
    const shouldStream = request.nextUrl.searchParams.get('stream') === '1'
      || request.headers.get('accept')?.includes('text/event-stream');

    if (shouldStream) {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      request.signal.addEventListener('abort', abort, { once: true });

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let summary = '';

          try {
            controller.enqueue(encodeSummaryStreamEvent({
              type: 'status',
              stage: 'reading_context',
              label: 'Reading email context',
            }));
            const data = await streamEmailMessageSummary(
              session.user.id,
              accountId,
              messageId,
              folder,
              { enforceReadPolicy: false, signal: abortController.signal },
            );

            controller.enqueue(encodeSummaryStreamEvent({ type: 'start', messageId: data.messageId }));
            controller.enqueue(encodeSummaryStreamEvent({
              type: 'status',
              stage: 'writing',
              label: 'Summarizing email',
            }));

            for await (const event of data.events) {
              if (abortController.signal.aborted) return;

              if (event.type === 'text_delta' && event.delta) {
                summary += event.delta;
                controller.enqueue(encodeSummaryStreamEvent({ type: 'delta', delta: event.delta }));
              }

              if (event.type === 'done') {
                const finalSummary = assistantText(event.message);
                if (!summary && finalSummary) {
                  summary = finalSummary;
                  controller.enqueue(encodeSummaryStreamEvent({ type: 'delta', delta: finalSummary }));
                }
                if (!summary.trim()) throw new Error('Email AI returned no content.');
                controller.enqueue(encodeSummaryStreamEvent({
                  type: 'status',
                  stage: 'ready',
                  label: 'Summary ready',
                }));
                controller.enqueue(encodeSummaryStreamEvent({ type: 'done', summary }));
                return;
              }

              if (event.type === 'error') {
                throw new Error(event.error.errorMessage || 'Email AI request failed.');
              }
            }
          } catch (error) {
            if (!abortController.signal.aborted) {
              const message = error instanceof Error ? error.message : 'Failed to summarize email message';
              controller.enqueue(encodeSummaryStreamEvent({ type: 'error', error: message }));
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

    const data = await summarizeEmailMessage(session.user.id, accountId, messageId, folder, { enforceReadPolicy: false });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to summarize email message';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
