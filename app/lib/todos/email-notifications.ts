import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { todoItems, user } from '@/app/lib/db/schema';
import { todoNotificationSendPolicyError } from '@/app/lib/email/policy';
import {
  resolveNotificationDeliveryRoute,
  sendNotificationThroughRoute,
} from '@/app/lib/email/notification-delivery-service';
import { renderTodoNotificationEmail } from '@/app/lib/email/templates/todo-notification';
import { getUserPreferredLocale } from '@/app/lib/user-preferences';
import type { TodoWithRelations } from '@/app/lib/todos/store';
import {
  appendTodoEmailReplyTokenToSubject,
  createTodoEmailReplyToken,
  createTodoEmailReplyWatcher,
  todoEmailReplyTrackingHeaders,
} from '@/app/lib/todos/email-reply-tracking';

export type TodoEmailNotificationResult =
  | {
      status: 'sent';
      delivery: 'managed_system_email' | 'system_smtp' | 'personal_email';
      accountId: string | null;
      messageId: string | null;
      replyToken: string | null;
    }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to send todo email notification.';
}

function normalizeRecipient(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.includes('@') ? normalized : null;
}

function isSendPolicyError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('sendto')
    || normalized.includes('send policy')
    || (normalized.includes('recipient') && normalized.includes('allowed'))
  );
}

async function markTodoNotificationStatus(todoId: string, status: { sentAt?: Date | null; error?: string | null }) {
  await db
    .update(todoItems)
    .set({
      emailNotificationSentAt: status.sentAt ?? null,
      emailNotificationError: status.error ? status.error.slice(0, 1000) : null,
      updatedAt: new Date(),
    })
    .where(eq(todoItems.id, todoId));
}

async function resolveUserLocale(userId: string): Promise<string> {
  try {
    return await getUserPreferredLocale(userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[TodoEmailNotification] Failed to resolve user locale:', message);
    return 'de';
  }
}

export async function sendTodoCreatedEmailNotification(_creatorUserId: string, todo: TodoWithRelations): Promise<TodoEmailNotificationResult> {
  if (todo.sourceType !== 'agent') {
    return { status: 'skipped', reason: 'Todo was not created by an agent.' };
  }

  const recipientUserId = todo.assigneeUserId || todo.userId;
  const recipientUser = await db.query.user.findFirst({
    where: eq(user.id, recipientUserId),
    columns: { email: true },
  });
  const recipient = normalizeRecipient(recipientUser?.email);
  if (!recipient) {
    await markTodoNotificationStatus(todo.id, { error: 'User has no usable email address.' });
    return { status: 'skipped', reason: 'User has no usable email address.' };
  }

  try {
    const route = await resolveNotificationDeliveryRoute(recipientUserId, recipient);
    if (route.kind === 'unavailable') {
      await markTodoNotificationStatus(todo.id, { error: route.reason });
      return { status: 'skipped', reason: route.reason };
    }

    const locale = await resolveUserLocale(recipientUserId);
    const replyToken = route.kind === 'personal_email' && todo.sourceSessionId ? createTodoEmailReplyToken() : null;
    const email = renderTodoNotificationEmail(todo, locale, { replyToken });
    const sendResponse = await sendNotificationThroughRoute(route, recipientUserId, {
      to: [recipient],
      subject: replyToken ? appendTodoEmailReplyTokenToSubject(email.subject, replyToken) : email.subject,
      body: email.html,
      isHtml: true,
      headers: replyToken ? todoEmailReplyTrackingHeaders(todo.id, replyToken) : undefined,
      purpose: 'todo_created',
      idempotencyKey: `todo-created:${todo.id}`,
    });
    const normalizedMessageId = sendResponse.messageId;

    if (replyToken && route.kind === 'personal_email') {
      await createTodoEmailReplyWatcher({
        todoId: todo.id,
        userId: recipientUserId,
        accountId: route.accountId,
        replyToken,
        outboundMessageId: normalizedMessageId,
        sourceAgentId: todo.sourceAgentId,
        sourceSessionId: todo.sourceSessionId,
        locale,
        sentAt: new Date(),
      });
    }

    await markTodoNotificationStatus(todo.id, { sentAt: new Date(), error: null });
    return {
      status: 'sent',
      delivery: route.kind,
      accountId: route.kind === 'personal_email' ? route.accountId : null,
      messageId: normalizedMessageId,
      replyToken,
    };
  } catch (error) {
    const rawMessage = getErrorMessage(error);
    const message = isSendPolicyError(rawMessage)
      ? `${todoNotificationSendPolicyError(recipient)} (${rawMessage})`
      : rawMessage;
    await markTodoNotificationStatus(todo.id, { error: message });
    console.warn('[TodoEmailNotification] Failed to send todo notification email:', message);
    return { status: 'failed', error: message };
  }
}
