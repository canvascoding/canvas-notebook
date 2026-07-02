import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import { auth } from '@/app/lib/auth';
import {
  archiveEmailMessage,
  createEmailAiReplyDraft,
  createEmailDerivedDraft,
  deleteEmailMessagePermanently,
  generateEmailAiReplyBody,
  moveEmailMessage,
  sendEmailDerivedMessage,
  setEmailMessageAnswered,
  setEmailMessageRead,
  streamEmailAiReplyBody,
  summarizeEmailMessage,
  trashEmailMessage,
} from '@/app/lib/email/service';
import { normalizeEmailAttachmentInputs } from '@/app/lib/email/attachments';
import { logEmailClientEvent } from '@/app/lib/email/logging';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type DraftMode = 'forward' | 'reply' | 'reply-all';
type MessageOperation = 'action' | 'ai-reply' | 'ai-reply-preview' | 'draft' | 'send' | 'summary';
type EmailMessageAction =
  | 'archive'
  | 'clear-answered'
  | 'mark-answered'
  | 'mark-read'
  | 'mark-unread'
  | 'move'
  | 'permanent-delete'
  | 'trash';

type EmailAiReplyStreamEvent =
  | { type: 'status'; stage: 'reading_context' | 'writing' | 'ready'; label: string }
  | { type: 'delta'; delta: string }
  | { type: 'done'; body: string }
  | { type: 'error'; message: string };

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function operationValue(value: unknown): MessageOperation {
  const normalized = stringValue(value);
  if (
    normalized === 'action'
    || normalized === 'ai-reply'
    || normalized === 'ai-reply-preview'
    || normalized === 'draft'
    || normalized === 'send'
    || normalized === 'summary'
  ) {
    return normalized;
  }
  throw new Error('Unsupported email message operation.');
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function stringListValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === 'string' ? entry.trim() : '')
      .filter(Boolean);
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .split(/[,\n;]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function draftMode(value: unknown): DraftMode {
  const normalized = stringValue(value);
  if (normalized === 'forward' || normalized === 'reply' || normalized === 'reply-all') return normalized;
  throw new Error('Unsupported email draft mode.');
}

function actionValue(value: unknown): EmailMessageAction {
  const normalized = stringValue(value);
  if (
    normalized === 'archive'
    || normalized === 'clear-answered'
    || normalized === 'mark-answered'
    || normalized === 'mark-read'
    || normalized === 'mark-unread'
    || normalized === 'move'
    || normalized === 'permanent-delete'
    || normalized === 'trash'
  ) {
    return normalized;
  }
  throw new Error('Unsupported email message action.');
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function encodeStreamEvent(event: EmailAiReplyStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ accountId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'email-message-actions-body-post' });
  if (!limited.ok) return limited.response;

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let accountId = '';
  let action: EmailMessageAction | undefined;
  let destination: string | undefined;
  let folder: string | undefined;
  let messageId = '';
  let mode: DraftMode | undefined;
  let operation: MessageOperation | undefined;

  try {
    ({ accountId } = await params);
    const body = await request.json().catch(() => ({}));
    messageId = requiredString((body as { messageId?: unknown }).messageId, 'messageId');
    folder = stringValue((body as { folder?: unknown }).folder);
    operation = operationValue((body as { operation?: unknown }).operation);
    let data: unknown;

    if (operation === 'draft' || operation === 'send') {
      mode = draftMode((body as { mode?: unknown }).mode);
    }

    if (operation === 'action') {
      action = actionValue((body as { action?: unknown }).action);
      destination = stringValue((body as { destination?: unknown }).destination);
    }

    logEmailClientEvent('info', 'message_action_requested', {
      accountId,
      action,
      destination,
      folder,
      messageId,
      mode,
      operation,
      requestId,
      status: 'requested',
      userId: session.user.id,
    });

    const shouldStreamAiReply = operation === 'ai-reply-preview'
      && (
        request.nextUrl.searchParams.get('stream') === '1'
        || request.headers.get('accept')?.includes('text/event-stream')
      );

    if (shouldStreamAiReply) {
      const instruction = optionalStringValue((body as { instruction?: unknown }).instruction);
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      request.signal.addEventListener('abort', abort, { once: true });

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (event: EmailAiReplyStreamEvent) => {
            controller.enqueue(encodeStreamEvent(event));
          };
          let draftBody = '';

          try {
            emit({ type: 'status', stage: 'reading_context', label: 'Reading email context' });
            const data = await streamEmailAiReplyBody(
              session.user.id,
              accountId,
              messageId,
              folder,
              instruction,
              { enforceReadPolicy: false, signal: abortController.signal },
            );

            emit({ type: 'status', stage: 'writing', label: 'Drafting reply' });
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
                logEmailClientEvent('info', 'message_action_succeeded', {
                  accountId,
                  durationMs: Date.now() - startedAt,
                  folder,
                  messageId,
                  operation,
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
              const message = error instanceof Error ? error.message : 'Failed to create AI reply draft';
              emit({ type: 'error', message });
              logEmailClientEvent('error', 'message_action_failed', {
                accountId,
                durationMs: Date.now() - startedAt,
                error,
                folder,
                messageId,
                operation,
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

    if (operation === 'summary') {
      data = await summarizeEmailMessage(session.user.id, accountId, messageId, folder, { enforceReadPolicy: false });
    }

    if (operation === 'ai-reply') {
      data = await createEmailAiReplyDraft(
        session.user.id,
        accountId,
        messageId,
        folder,
        optionalStringValue((body as { instruction?: unknown }).instruction),
        { enforceReadPolicy: false },
      );
    }

    if (operation === 'ai-reply-preview') {
      data = await generateEmailAiReplyBody(
        session.user.id,
        accountId,
        messageId,
        folder,
        optionalStringValue((body as { instruction?: unknown }).instruction),
        { enforceReadPolicy: false },
      );
    }

    if (operation === 'draft') {
      if (!mode) throw new Error('Unsupported email draft mode.');
      data = await createEmailDerivedDraft(session.user.id, accountId, messageId, folder, mode, {
        attachments: normalizeEmailAttachmentInputs((body as { attachments?: unknown }).attachments),
        bodyOverride: optionalStringValue((body as { bodyOverride?: unknown }).bodyOverride),
        bodyOverrideHtml: optionalStringValue((body as { bodyOverrideHtml?: unknown }).bodyOverrideHtml),
        cc: stringListValue((body as { cc?: unknown }).cc),
        is_HTML: Boolean((body as { is_HTML?: unknown }).is_HTML),
        subject: optionalStringValue((body as { subject?: unknown }).subject),
        to: stringListValue((body as { to?: unknown }).to),
      }, { enforceReadPolicy: false });
    }

    if (operation === 'send') {
      if (!mode) throw new Error('Unsupported email send mode.');
      data = await sendEmailDerivedMessage(session.user.id, accountId, messageId, folder, mode, {
        attachments: normalizeEmailAttachmentInputs((body as { attachments?: unknown }).attachments),
        bodyOverride: optionalStringValue((body as { bodyOverride?: unknown }).bodyOverride),
        bodyOverrideHtml: optionalStringValue((body as { bodyOverrideHtml?: unknown }).bodyOverrideHtml),
        cc: stringListValue((body as { cc?: unknown }).cc),
        is_HTML: Boolean((body as { is_HTML?: unknown }).is_HTML),
        subject: optionalStringValue((body as { subject?: unknown }).subject),
        to: stringListValue((body as { to?: unknown }).to),
      }, { enforceReadPolicy: false });
    }

    if (operation === 'action') {
      if (action === 'archive') data = await archiveEmailMessage(session.user.id, accountId, messageId, folder);
      if (action === 'trash') data = await trashEmailMessage(session.user.id, accountId, messageId, folder);
      if (action === 'permanent-delete') data = await deleteEmailMessagePermanently(session.user.id, accountId, messageId, folder);
      if (action === 'mark-read') data = await setEmailMessageRead(session.user.id, accountId, messageId, folder, true);
      if (action === 'mark-unread') data = await setEmailMessageRead(session.user.id, accountId, messageId, folder, false);
      if (action === 'mark-answered') data = await setEmailMessageAnswered(session.user.id, accountId, messageId, folder, true);
      if (action === 'clear-answered') data = await setEmailMessageAnswered(session.user.id, accountId, messageId, folder, false);
      if (action === 'move') {
        if (!destination) throw new Error('A destination folder is required.');
        data = await moveEmailMessage(session.user.id, accountId, messageId, folder, destination);
      }
    }

    logEmailClientEvent('info', 'message_action_succeeded', {
      accountId,
      action,
      destination,
      durationMs: Date.now() - startedAt,
      folder,
      messageId,
      mode,
      operation,
      requestId,
      status: 'succeeded',
      userId: session.user.id,
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logEmailClientEvent('error', 'message_action_failed', {
      accountId,
      action,
      destination,
      durationMs: Date.now() - startedAt,
      error,
      folder,
      messageId,
      mode,
      operation,
      requestId,
      status: 'failed',
      userId: session.user.id,
    });
    const message = error instanceof Error ? error.message : 'Failed to update email message';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
