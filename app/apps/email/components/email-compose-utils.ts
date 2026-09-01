import { extractEmailAddressForCompose } from '@/app/apps/email/components/email-client-format';
import type { EmailComposeAgentUsedContext } from '@/app/apps/email/components/email-client-types';
import type { EmailAttachmentDraft } from '@/app/lib/email/attachment-types';

export function splitRecipientInput(value: string): string[] {
  return value
    .split(/[,\n;]/u)
    .map((entry) => extractEmailAddressForCompose(entry) || entry.trim())
    .filter(Boolean);
}

export function isValidComposeRecipient(value: string): boolean {
  return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u.test(value.trim());
}

export function normalizeComposeRecipient(value: string): string {
  return extractEmailAddressForCompose(value) || value.trim();
}

export function visibleEmailAttachments(attachments: EmailAttachmentDraft[]): EmailAttachmentDraft[] {
  return attachments.filter((attachment) => attachment.disposition !== 'inline');
}

export function mergeVisibleEmailAttachments(current: EmailAttachmentDraft[], visible: EmailAttachmentDraft[]): EmailAttachmentDraft[] {
  return [
    ...current.filter((attachment) => attachment.disposition === 'inline'),
    ...visible,
  ];
}

function referencedInlineContentIds(html: string): Set<string> {
  const ids = new Set<string>();
  const imagePattern = /<img\b[^>]*\ssrc\s*=\s*("cid:([^"]+)"|'cid:([^']+)'|cid:([^\s"'>]+))/giu;
  let match: RegExpExecArray | null;

  while ((match = imagePattern.exec(html)) !== null) {
    const contentId = (match[2] || match[3] || match[4] || '').trim();
    if (contentId) ids.add(contentId);
  }

  return ids;
}

export function pruneUnreferencedInlineEmailAttachments(attachments: EmailAttachmentDraft[], html: string): EmailAttachmentDraft[] {
  const referencedIds = referencedInlineContentIds(html);
  return attachments.filter((attachment) => (
    attachment.disposition !== 'inline'
    || (attachment.contentId && referencedIds.has(attachment.contentId))
  ));
}

export function appendComposeRecipients(current: string[], additions: string[]): string[] {
  const seen = new Set(current.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean));
  const next = [...current];
  for (const addition of additions) {
    const recipient = normalizeComposeRecipient(addition);
    const key = recipient.toLowerCase();
    if (!recipient || seen.has(key)) continue;
    seen.add(key);
    next.push(recipient);
  }
  return next;
}

export function extractRecipientEmailsForCompose(value: string[] | string | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(extractRecipientEmailsForCompose);
  return splitRecipientInput(value);
}

export function uniqueComposeRecipients(values: string[], ownAddresses = new Set<string>()): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const value of values) {
    const email = extractEmailAddressForCompose(value);
    if (!email || ownAddresses.has(email) || seen.has(email)) continue;
    seen.add(email);
    recipients.push(email);
  }
  return recipients;
}

export function composeRecipientText(values: string[]): string {
  return values.join(', ');
}

export function replySubjectForCompose(subject: string): string {
  const normalized = subject.trim();
  if (!normalized) return 'Re:';
  return /^re:/iu.test(normalized) ? normalized : `Re: ${normalized}`;
}

export function forwardSubjectForCompose(subject: string): string {
  const normalized = subject.trim();
  if (!normalized) return 'Fwd:';
  return /^(fwd|fw):/iu.test(normalized) ? normalized : `Fwd: ${normalized}`;
}

export function normalizeAgentUsedContext(value: unknown): EmailComposeAgentUsedContext[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: EmailComposeAgentUsedContext[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const path = String(record.path || '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const reason = String(record.reason || '').trim();
    output.push(reason ? { path, reason } : { path });
  }
  return output;
}
