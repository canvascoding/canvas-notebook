import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { todoItems, user } from '@/app/lib/db/schema';
import {
  isEmailAddressAllowed,
  normalizeEmailPolicyList,
  todoNotificationSendPolicyError,
  withEmailPolicyDefaultAddresses,
} from '@/app/lib/email/policy';
import { listEmailAccounts, sendEmailMessage } from '@/app/lib/email/service';
import { renderTodoNotificationEmail } from '@/app/lib/email/templates/todo-notification';
import { getUserPreferredLocale } from '@/app/lib/user-preferences';
import type { TodoWithRelations } from '@/app/lib/todos/store';
import {
  appendTodoEmailReplyTokenToSubject,
  createTodoEmailReplyToken,
  createTodoEmailReplyWatcher,
  todoEmailReplyTrackingHeaders,
} from '@/app/lib/todos/email-reply-tracking';

type EmailAccountCandidate = {
  id: string;
  emailAddress?: string | null;
  isPrimary?: boolean | null;
  status?: string | null;
  policy?: {
    sendTo?: unknown;
  } | null;
};

export type TodoEmailNotificationResult =
  | { status: 'sent'; accountId: string; messageId: string | null; replyToken: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to send todo email notification.';
}

function isActiveAccount(value: unknown): value is EmailAccountCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { id?: unknown; status?: unknown };
  if (typeof record.id !== 'string' || !record.id.trim()) return false;
  if (record.status === undefined || record.status === null) return true;
  if (typeof record.status !== 'string') return false;
  return ['active', 'connected'].includes(record.status.trim().toLowerCase());
}

function normalizeRecipient(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.includes('@') ? normalized : null;
}

function sendPolicyForAccount(account: EmailAccountCandidate, recipient: string): string[] | null {
  if (!account.policy || typeof account.policy !== 'object' || !('sendTo' in account.policy)) {
    return null;
  }
  return withEmailPolicyDefaultAddresses(
    { sendTo: normalizeEmailPolicyList(account.policy.sendTo) },
    [recipient, account.emailAddress],
  ).sendTo;
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

export async function sendTodoCreatedEmailNotification(userId: string, todo: TodoWithRelations): Promise<TodoEmailNotificationResult> {
  if (todo.sourceType !== 'agent') {
    return { status: 'skipped', reason: 'Todo was not created by an agent.' };
  }

  const owner = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { email: true },
  });
  const recipient = normalizeRecipient(owner?.email);
  if (!recipient) {
    await markTodoNotificationStatus(todo.id, { error: 'User has no usable email address.' });
    return { status: 'skipped', reason: 'User has no usable email address.' };
  }

  try {
    const accountsResponse = await listEmailAccounts(userId);
    const rawAccounts: unknown[] = Array.isArray(accountsResponse.accounts)
      ? accountsResponse.accounts
      : [];
    const accounts = rawAccounts.filter(isActiveAccount);
    const account = accounts.find((candidate) => candidate.isPrimary) || accounts[0];
    if (!account) {
      await markTodoNotificationStatus(todo.id, { error: 'No active email account connected.' });
      return { status: 'skipped', reason: 'No active email account connected.' };
    }

    const sendToPolicy = sendPolicyForAccount(account, recipient);
    if (sendToPolicy && !isEmailAddressAllowed(recipient, sendToPolicy)) {
      const message = todoNotificationSendPolicyError(recipient);
      await markTodoNotificationStatus(todo.id, { error: message });
      return { status: 'skipped', reason: message };
    }

    const locale = await resolveUserLocale(userId);
    const replyToken = todo.sourceSessionId ? createTodoEmailReplyToken() : null;
    const email = renderTodoNotificationEmail(todo, locale, { replyToken });
    const sendResponse = await sendEmailMessage(userId, {
      accountId: account.id,
      to: [recipient],
      subject: replyToken ? appendTodoEmailReplyTokenToSubject(email.subject, replyToken) : email.subject,
      body: email.html,
      is_HTML: true,
      headers: replyToken ? todoEmailReplyTrackingHeaders(todo.id, replyToken) : undefined,
    });
    const messageId = (sendResponse as { messageId?: unknown }).messageId;
    const normalizedMessageId = typeof messageId === 'string' && messageId.trim() ? messageId.trim() : null;

    if (replyToken) {
      await createTodoEmailReplyWatcher({
        todoId: todo.id,
        userId,
        accountId: account.id,
        replyToken,
        outboundMessageId: normalizedMessageId,
        sourceAgentId: todo.sourceAgentId,
        sourceSessionId: todo.sourceSessionId,
        locale,
        sentAt: new Date(),
      });
    }

    await markTodoNotificationStatus(todo.id, { sentAt: new Date(), error: null });
    return { status: 'sent', accountId: account.id, messageId: normalizedMessageId, replyToken };
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
