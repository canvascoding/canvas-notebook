import path from 'node:path';

import {
  sanitizeInboundEmailAttachmentFilename,
  type EmailMessageAttachment,
} from '@/app/lib/email/inbound-attachments';

export const EMAIL_ATTACHMENT_BATCH_MAX_COUNT = 50;
export const EMAIL_ATTACHMENT_BATCH_MAX_BYTES = 100 * 1024 * 1024;

export class EmailAttachmentBatchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'EMAIL_ATTACHMENT_BATCH_INVALID',
  ) {
    super(message);
    this.name = 'EmailAttachmentBatchError';
  }
}

function cleanAttachmentMetadata(value: unknown): EmailMessageAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  return {
    id,
    filename: sanitizeInboundEmailAttachmentFilename(record.filename),
    contentType: typeof record.contentType === 'string' && record.contentType.trim()
      ? record.contentType.trim()
      : 'application/octet-stream',
    size: typeof record.size === 'number' && Number.isSafeInteger(record.size) && record.size >= 0
      ? record.size
      : null,
    inline: record.inline === true,
    downloadable: record.downloadable !== false,
    ...(typeof record.contentId === 'string' && record.contentId.trim()
      ? { contentId: record.contentId.trim() }
      : {}),
  };
}

function detailRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const message = (value as Record<string, unknown>).message;
  return message && typeof message === 'object' && !Array.isArray(message)
    ? message as Record<string, unknown>
    : {};
}

export function selectDownloadableEmailAttachments(
  detail: unknown,
  requestedAttachmentIds?: readonly string[],
): { attachments: EmailMessageAttachment[]; subject: string } {
  const message = detailRecord(detail);
  const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
    .map(cleanAttachmentMetadata)
    .filter((attachment): attachment is EmailMessageAttachment => Boolean(attachment));
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const requestedIds = requestedAttachmentIds
    ? [...new Set(requestedAttachmentIds.map((id) => id.trim()).filter(Boolean))]
    : attachments.filter((attachment) => attachment.downloadable).map((attachment) => attachment.id);

  if (requestedIds.length === 0) {
    throw new EmailAttachmentBatchError('This email has no downloadable attachments.', 404, 'EMAIL_ATTACHMENTS_NOT_FOUND');
  }
  if (requestedIds.length > EMAIL_ATTACHMENT_BATCH_MAX_COUNT) {
    throw new EmailAttachmentBatchError(
      `Too many attachments selected (max ${EMAIL_ATTACHMENT_BATCH_MAX_COUNT}).`,
      413,
      'EMAIL_ATTACHMENT_BATCH_TOO_MANY',
    );
  }

  const selected = requestedIds.map((id) => {
    const attachment = byId.get(id);
    if (!attachment) {
      throw new EmailAttachmentBatchError('An attachment is no longer available on this email.', 404, 'EMAIL_ATTACHMENT_NOT_FOUND');
    }
    if (!attachment.downloadable) {
      throw new EmailAttachmentBatchError(`Attachment cannot be downloaded: ${attachment.filename}`, 409, 'EMAIL_ATTACHMENT_UNAVAILABLE');
    }
    return attachment;
  });

  return {
    attachments: selected,
    subject: typeof message.subject === 'string' ? message.subject : '',
  };
}

export function nextUniqueEmailAttachmentFilename(fileName: string, usedNames: Set<string>): string {
  const sanitized = sanitizeInboundEmailAttachmentFilename(fileName);
  const parsed = path.posix.parse(sanitized);
  const baseName = parsed.name || 'attachment';
  let candidate = sanitized;
  let index = 2;
  while (usedNames.has(candidate.normalize('NFC').toLocaleLowerCase('en-US'))) {
    candidate = `${baseName}-${index}${parsed.ext}`;
    index += 1;
  }
  usedNames.add(candidate.normalize('NFC').toLocaleLowerCase('en-US'));
  return candidate;
}

export function emailAttachmentArchiveFilename(subject: string): string {
  const safeSubject = sanitizeInboundEmailAttachmentFilename(subject, 'email')
    .replace(/\.[^.]+$/u, '')
    .slice(0, 180)
    .trim() || 'email';
  return `${safeSubject}-attachments.zip`;
}
