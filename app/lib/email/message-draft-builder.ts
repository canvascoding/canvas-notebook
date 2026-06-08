import 'server-only';

export type EmailDerivedDraftMode = 'forward' | 'reply' | 'reply-all';

export type EmailDerivedDraftOverrides = {
  bodyOverride?: string;
  cc?: string[];
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
};

type BuildEmailDerivedDraftInput = {
  accountId: string;
  message: Record<string, unknown>;
  mode: EmailDerivedDraftMode;
  ownAddresses: Set<string>;
} & EmailDerivedDraftOverrides;

export function htmlToPlainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p>/giu, '\n\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

function textFromMessage(message: Record<string, unknown>): string {
  const body = typeof message.body === 'string' ? message.body : '';
  const snippet = typeof message.snippet === 'string' ? message.snippet : '';
  return htmlToPlainText(body || snippet);
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
  const body = isForward
    ? [intro, forwardedBody(input.message)].filter(Boolean).join('\n\n')
    : [intro, quotedBody(input.message)].filter(Boolean).join('\n\n');

  return {
    accountId: input.accountId,
    to,
    cc,
    subject: input.subject?.trim() || (isForward ? forwardSubject(subject) : replySubject(subject)),
    body,
    is_HTML: false,
  };
}
