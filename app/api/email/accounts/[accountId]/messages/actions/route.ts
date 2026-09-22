import { createMailboxAiReplyDraft } from '@/app/lib/email/mailbox-ai';
import { createBrowserEmailDerivedDraft } from '@/app/lib/email/mailbox-compose';
import { resolveEmailMailboxAccess, EmailMailboxAccessError } from '@/app/lib/email/mailbox-access';
import { NextRequest, NextResponse } from 'next/server';
import { OutboxSendError } from '@/app/lib/email/outbox-errors';
import crypto from 'crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import {
  archiveEmailMessage,
  deleteEmailMessagePermanently,
  generateEmailAiReplyBody,
  moveEmailMessage,
  readEmailMessage,
  setEmailMessageAnswered,
  setEmailMessageRead,
  streamEmailAiReplyBody,
  summarizeEmailMessage,
  trashEmailMessage,
} from '@/app/lib/email/service';
import { normalizeEmailAttachmentInputs } from '@/app/lib/email/attachments';
import { emailAiRequestBodyErrorStatus, readEmailAiJsonObject } from '@/app/lib/email/ai-request-body';
import { requireEmailAiRouteSession } from '@/app/lib/email/ai-route-guard';
import { isImapMailboxChangedError } from '@/app/lib/email/imap-service';
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
  const session = await requireEmailAiRouteSession(request);
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
    const body = await readEmailAiJsonObject(request);
    messageId = requiredString(body.messageId, 'messageId');
    folder = stringValue(body.folder);
    let workspaceId = stringValue(body.workspaceId);
    operation = operationValue(body.operation);
    let data: unknown;

    if (operation === 'summary' || operation === 'ai-reply' || operation === 'ai-reply-preview') {
      const aiLimited = rateLimit(request, {
        limit: 20,
        windowMs: 60_000,
        keyPrefix: 'email-message-ai-actions-post',
      });
      if (!aiLimited.ok) return aiLimited.response;
    }

    if (operation === 'draft' || operation === 'send') {
      mode = draftMode((body as { mode?: unknown }).mode);
    }

    if (operation === 'action') {
      action = actionValue((body as { action?: unknown }).action);
      destination = stringValue((body as { destination?: unknown }).destination);
    }

    const access = await resolveEmailMailboxAccess({
      userId: session.user.id, accountId, mailboxWorkspaceId: body.mailboxWorkspaceId,
      operation: action === 'permanent-delete' ? 'delete'
        : operation === 'summary' || operation === 'ai-reply' || operation === 'ai-reply-preview' ? 'ai' : 'write',
    });
    workspaceId = access.workspaceId || workspaceId;
    const readOptions = { ...access.readOptions, actorUserId: session.user.id, workspaceId };

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
              access.accountOwnerId,
              accountId,
              messageId,
              folder,
              instruction,
              { ...readOptions, signal: abortController.signal },
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
      data = await summarizeEmailMessage(
        access.accountOwnerId,
        accountId,
        messageId,
        folder,
        readOptions,
      );
    }

    if (operation === 'ai-reply') {
      data = await createMailboxAiReplyDraft({ userId: session.user.id, access, messageId, folder, instruction: optionalStringValue((body as { instruction?: unknown }).instruction), workspaceId });
    }

    if (operation === 'ai-reply-preview') {
      data = await generateEmailAiReplyBody(
        access.accountOwnerId,
        accountId,
        messageId,
        folder,
        optionalStringValue((body as { instruction?: unknown }).instruction),
        readOptions,
      );
    }

    if (operation === 'draft') {
      if (!mode) throw new Error('Unsupported email draft mode.');
      data = await createBrowserEmailDerivedDraft(session.user.id, { accountId, mailboxWorkspaceId: access.workspaceId, messageId, folder, mode, overrides: {
        attachments: normalizeEmailAttachmentInputs((body as { attachments?: unknown }).attachments),
        bodyOverride: optionalStringValue((body as { bodyOverride?: unknown }).bodyOverride),
        bodyOverrideHtml: optionalStringValue((body as { bodyOverrideHtml?: unknown }).bodyOverrideHtml),
        cc: stringListValue((body as { cc?: unknown }).cc),
        is_HTML: Boolean((body as { is_HTML?: unknown }).is_HTML),
        subject: optionalStringValue((body as { subject?: unknown }).subject),
        to: stringListValue((body as { to?: unknown }).to),
      } }, false);
    }

    if (operation === 'send') {
      if (!mode) throw new Error('Unsupported email send mode.');
      data = await createBrowserEmailDerivedDraft(session.user.id, { accountId, mailboxWorkspaceId: access.workspaceId, messageId, folder, mode, overrides: {
        attachments: normalizeEmailAttachmentInputs((body as { attachments?: unknown }).attachments),
        bodyOverride: optionalStringValue((body as { bodyOverride?: unknown }).bodyOverride),
        bodyOverrideHtml: optionalStringValue((body as { bodyOverrideHtml?: unknown }).bodyOverrideHtml),
        cc: stringListValue((body as { cc?: unknown }).cc),
        is_HTML: Boolean((body as { is_HTML?: unknown }).is_HTML),
        subject: optionalStringValue((body as { subject?: unknown }).subject),
        to: stringListValue((body as { to?: unknown }).to),
      } }, operation === 'send');
    }

    if (operation === 'action') {
      if (access.workspaceId) await readEmailMessage(access.accountOwnerId, accountId, messageId, folder, access.readOptions);
      if (action === 'archive') data = await archiveEmailMessage(access.accountOwnerId, accountId, messageId, folder);
      if (action === 'trash') data = await trashEmailMessage(access.accountOwnerId, accountId, messageId, folder);
      if (action === 'permanent-delete') data = await deleteEmailMessagePermanently(access.accountOwnerId, accountId, messageId, folder);
      if (action === 'mark-read') data = await setEmailMessageRead(access.accountOwnerId, accountId, messageId, folder, true);
      if (action === 'mark-unread') data = await setEmailMessageRead(access.accountOwnerId, accountId, messageId, folder, false);
      if (action === 'mark-answered') data = await setEmailMessageAnswered(access.accountOwnerId, accountId, messageId, folder, true);
      if (action === 'clear-answered') data = await setEmailMessageAnswered(access.accountOwnerId, accountId, messageId, folder, false);
      if (action === 'move') {
        if (!destination) throw new Error('A destination folder is required.');
        data = await moveEmailMessage(access.accountOwnerId, accountId, messageId, folder, destination);
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
    if (error instanceof OutboxSendError) return NextResponse.json({ success: false, error: error.message, code: error.code, data: error.draft }, { status: error.status });
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
    if (isImapMailboxChangedError(error)) {
      return NextResponse.json(
        { success: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : 'Failed to update email message';
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof EmailMailboxAccessError ? error.status : emailAiRequestBodyErrorStatus(error) ?? 500 },
    );
  }
}
