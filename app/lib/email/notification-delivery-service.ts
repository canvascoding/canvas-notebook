import 'server-only';

import {
  isEmailAddressAllowed,
  normalizeEmailPolicyList,
  todoNotificationSendPolicyError,
  withEmailPolicyDefaultAddresses,
} from '@/app/lib/email/policy';
import { listEmailAccounts, sendEmailMessage } from '@/app/lib/email/service';
import { getSystemSmtpConfiguration } from '@/app/lib/email/system-smtp-config';
import { sendSystemSmtpEmail } from '@/app/lib/email/system-smtp-service';
import type { EmailCustomHeaders } from '@/app/lib/email/headers';

type EmailAccountCandidate = {
  id: string;
  emailAddress?: string | null;
  isPrimary?: boolean | null;
  status?: string | null;
  policy?: {
    sendTo?: unknown;
  } | null;
};

export type NotificationDeliveryRoute =
  | { kind: 'system_smtp' }
  | { kind: 'personal_email'; accountId: string }
  | { kind: 'unavailable'; reason: string };

export type NotificationMessage = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  headers?: EmailCustomHeaders;
};

function isActiveAccount(value: unknown): value is EmailAccountCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { id?: unknown; status?: unknown };
  if (typeof record.id !== 'string' || !record.id.trim()) return false;
  if (record.status === undefined || record.status === null) return true;
  if (typeof record.status !== 'string') return false;
  return ['active', 'connected'].includes(record.status.trim().toLowerCase());
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

export async function resolveNotificationDeliveryRoute(
  userId: string,
  recipient: string,
): Promise<NotificationDeliveryRoute> {
  const systemSmtp = await getSystemSmtpConfiguration();
  if (systemSmtp) {
    return { kind: 'system_smtp' };
  }

  const accountsResponse = await listEmailAccounts(userId);
  const rawAccounts: unknown[] = Array.isArray(accountsResponse.accounts) ? accountsResponse.accounts : [];
  const accounts = rawAccounts.filter(isActiveAccount);
  const account = accounts.find((candidate) => candidate.isPrimary) || accounts[0];
  if (!account) {
    return { kind: 'unavailable', reason: 'No active email account connected.' };
  }

  const sendToPolicy = sendPolicyForAccount(account, recipient);
  if (sendToPolicy && !isEmailAddressAllowed(recipient, sendToPolicy)) {
    return { kind: 'unavailable', reason: todoNotificationSendPolicyError(recipient) };
  }

  return { kind: 'personal_email', accountId: account.id };
}

export async function sendNotificationThroughRoute(
  route: Exclude<NotificationDeliveryRoute, { kind: 'unavailable' }>,
  userId: string,
  message: NotificationMessage,
): Promise<{ messageId: string | null }> {
  if (route.kind === 'system_smtp') {
    return sendSystemSmtpEmail({
      ...message,
      isHtml: message.isHtml,
    });
  }

  const response = await sendEmailMessage(userId, {
    accountId: route.accountId,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    body: message.body,
    is_HTML: message.isHtml,
    headers: message.headers,
  });
  const messageId = (response as { messageId?: unknown }).messageId;
  return { messageId: typeof messageId === 'string' && messageId.trim() ? messageId.trim() : null };
}
