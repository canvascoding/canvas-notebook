import 'server-only';

import type { EmailAttachmentInput } from '@/app/lib/email/attachment-types';
import { escapeEmailHtml, htmlToPlainText, plainTextToEmailHtml } from '@/app/lib/email/html-conversion';

export type EmailDerivedDraftMode = 'forward' | 'reply' | 'reply-all';

export type EmailDerivedDraftOverrides = {
  attachments?: EmailAttachmentInput[];
  bodyOverride?: string;
  bodyOverrideHtml?: string;
  cc?: string[];
  is_HTML?: boolean;
  subject?: string;
  to?: string[];
};

type EmailDraftInput = {
  accountId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  is_HTML?: boolean;
  attachments?: EmailAttachmentInput[];
};

type BuildEmailDerivedDraftInput = {
  accountId: string;
  message: Record<string, unknown>;
  mode: EmailDerivedDraftMode;
  ownAddresses: Set<string>;
} & EmailDerivedDraftOverrides;

function textFromMessage(message: Record<string, unknown>): string {
  const body = typeof message.body === 'string' ? message.body : '';
  const bodyHtml = typeof message.bodyHtml === 'string' ? message.bodyHtml : '';
  const snippet = typeof message.snippet === 'string' ? message.snippet : '';
  return body.trim() || htmlToPlainText(bodyHtml) || htmlToPlainText(snippet);
}

function subjectFromMessage(message: Record<string, unknown>): string {
  return String(message.subject || '').trim();
}

function replySubject(subject: string): string {
  const normalized = subject.trim();
  if (!normalized) return 'Re:';
  return /^re:/iu.test(normalized) ? normalized : `Re: ${normalized}`;
}

function forwardSubject(subject: string): string {
  const normalized = subject.trim();
  if (!normalized) return 'Fwd:';
  return /^(fwd|fw):/iu.test(normalized) ? normalized : `Fwd: ${normalized}`;
}

function extractEmailAddress(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') {
    const match = value.match(/<([^<>@\s]+@[^<>@\s]+)>/u) || value.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu);
    return (match?.[1] || '').trim().toLowerCase();
  }
  if (typeof value === 'object') {
    const record = value as {
      address?: unknown;
      email?: unknown;
      emailAddress?: { address?: unknown };
    };
    return extractEmailAddress(record.emailAddress?.address || record.address || record.email);
  }
  return '';
}

function extractEmailAddresses(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(extractEmailAddresses);
  }
  if (typeof value === 'string') {
    return value.split(',').map(extractEmailAddress).filter(Boolean);
  }
  return [extractEmailAddress(value)].filter(Boolean);
}

function uniqueAddresses(values: string[], ownAddresses: Set<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const email = extractEmailAddress(value);
    if (!email || ownAddresses.has(email) || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
}

function overrideAddresses(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const email = extractEmailAddress(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
}

function quotedBody(message: Record<string, unknown>): string {
  const from = String(message.from || '').trim();
  const date = String(message.date || '').trim();
  const body = textFromMessage(message);
  const quoted = body.split(/\r?\n/u).map((line) => `> ${line}`).join('\n');
  const intro = date && from ? `On ${date}, ${from} wrote:` : from ? `${from} wrote:` : 'Original message:';
  return `${intro}\n${quoted}`;
}

function forwardedBody(message: Record<string, unknown>): string {
  return [
    '---------- Forwarded message ----------',
    `From: ${String(message.from || '').trim()}`,
    `Date: ${String(message.date || '').trim()}`,
    `Subject: ${subjectFromMessage(message)}`,
    `To: ${extractEmailAddresses(message.to).join(', ')}`,
    '',
    textFromMessage(message),
  ].join('\n');
}

function quotedBodyHtml(message: Record<string, unknown>): string {
  const from = String(message.from || '').trim();
  const date = String(message.date || '').trim();
  const body = plainTextToEmailHtml(textFromMessage(message));
  const intro = date && from ? `On ${escapeEmailHtml(date)}, ${escapeEmailHtml(from)} wrote:` : from ? `${escapeEmailHtml(from)} wrote:` : 'Original message:';
  return `<p>${intro}</p><blockquote>${body}</blockquote>`;
}

function forwardedBodyHtml(message: Record<string, unknown>): string {
  const to = extractEmailAddresses(message.to).join(', ');
  return [
    '<p>---------- Forwarded message ----------<br>',
    `From: ${escapeEmailHtml(String(message.from || '').trim())}<br>`,
    `Date: ${escapeEmailHtml(String(message.date || '').trim())}<br>`,
    `Subject: ${escapeEmailHtml(subjectFromMessage(message))}<br>`,
    `To: ${escapeEmailHtml(to)}</p>`,
    plainTextToEmailHtml(textFromMessage(message)),
  ].join('');
}

export function buildEmailDerivedDraft(input: BuildEmailDerivedDraftInput): EmailDraftInput {
  const subject = subjectFromMessage(input.message);
  const isForward = input.mode === 'forward';
  const from = extractEmailAddress(input.message.from);
  const originalTo = extractEmailAddresses(input.message.to);
  const originalCc = extractEmailAddresses(input.message.cc);
  const defaultTo = isForward
    ? []
    : uniqueAddresses([from, ...(input.mode === 'reply-all' ? originalTo : [])], input.ownAddresses);
  const defaultCc = input.mode === 'reply-all' ? uniqueAddresses(originalCc, input.ownAddresses) : [];
  const to = overrideAddresses(input.to) ?? defaultTo;
  const cc = overrideAddresses(input.cc) ?? defaultCc;
  const intro = input.bodyOverride?.trim() || '';
  const wantsHtml = input.is_HTML || Boolean(input.bodyOverrideHtml?.trim());
  const introHtml = input.bodyOverrideHtml?.trim() || plainTextToEmailHtml(intro);
  const body = wantsHtml
    ? (
        isForward
          ? [introHtml, forwardedBodyHtml(input.message)].filter(Boolean).join('<br>')
          : [introHtml, quotedBodyHtml(input.message)].filter(Boolean).join('<br>')
      )
    : (
        isForward
          ? [intro, forwardedBody(input.message)].filter(Boolean).join('\n\n')
          : [intro, quotedBody(input.message)].filter(Boolean).join('\n\n')
      );

  return {
    accountId: input.accountId,
    to,
    cc,
    subject: input.subject?.trim() || (isForward ? forwardSubject(subject) : replySubject(subject)),
    body,
    is_HTML: wantsHtml,
    attachments: input.attachments,
  };
}
