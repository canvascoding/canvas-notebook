import path from 'node:path';
import { Readable } from 'node:stream';

export const EMAIL_INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export type EmailMessageAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number | null;
  inline: boolean;
  downloadable: boolean;
  contentId?: string | null;
};

export type DownloadedEmailAttachment = {
  attachment: EmailMessageAttachment;
  content: Readable;
};

type GmailMessagePart = {
  partId?: unknown;
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: unknown;
  parts?: unknown;
};

export type GmailAttachmentPart = {
  attachment: EmailMessageAttachment;
  attachmentId: string | null;
  data: string | null;
};

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function sanitizeInboundEmailAttachmentFilename(value: unknown, fallback = 'attachment'): string {
  const normalized = cleanString(value)
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\\/gu, '/');
  const basename = path.posix.basename(normalized).trim();
  if (!basename || basename === '.' || basename === '..') return fallback;
  return basename.slice(0, 240);
}

export function assertInboundEmailAttachmentSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Email attachment size is invalid.');
  if (size > EMAIL_INBOUND_ATTACHMENT_MAX_BYTES) {
    throw new Error('Email attachment exceeds the 25 MB download limit.');
  }
}

function gmailPartHeader(part: GmailMessagePart, name: string): string {
  const headers = Array.isArray(part.headers)
    ? part.headers as Array<{ name?: unknown; value?: unknown }>
    : [];
  const header = headers.find((candidate) => cleanString(candidate.name).toLowerCase() === name.toLowerCase());
  return cleanString(header?.value);
}

function gmailAttachmentPartId(part: GmailMessagePart, attachmentId: string): string {
  if (attachmentId) return `gmail-attachment:${attachmentId}`;
  const partId = cleanString(part.partId);
  return partId ? `gmail-part:${partId}` : '';
}

function collectGmailAttachmentParts(part: GmailMessagePart, output: GmailAttachmentPart[]): void {
  const body = part.body && typeof part.body === 'object' && !Array.isArray(part.body)
    ? part.body as Record<string, unknown>
    : {};
  const filename = cleanString(part.filename);
  const attachmentId = cleanString(body.attachmentId);
  const data = cleanString(body.data);
  const disposition = gmailPartHeader(part, 'Content-Disposition').toLowerCase();
  const contentId = gmailPartHeader(part, 'Content-ID').replace(/^<|>$/gu, '') || null;
  const isAttachment = Boolean(filename || attachmentId || disposition.startsWith('attachment'));

  if (isAttachment) {
    const id = gmailAttachmentPartId(part, attachmentId);
    if (id) {
      output.push({
        attachment: {
          id,
          filename: sanitizeInboundEmailAttachmentFilename(filename, `attachment-${output.length + 1}`),
          contentType: cleanString(part.mimeType) || 'application/octet-stream',
          size: safeSize(body.size),
          inline: disposition.startsWith('inline'),
          downloadable: true,
          ...(contentId ? { contentId } : {}),
        },
        attachmentId: attachmentId || null,
        data: data || null,
      });
    }
  }

  const children = Array.isArray(part.parts) ? part.parts as GmailMessagePart[] : [];
  children.forEach((child) => collectGmailAttachmentParts(child, output));
}

export function gmailMessageAttachmentParts(payload: unknown): GmailAttachmentPart[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const output: GmailAttachmentPart[] = [];
  collectGmailAttachmentParts(payload as GmailMessagePart, output);
  return output;
}

export function decodeGmailAttachmentData(value: string): Buffer {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const content = Buffer.from(normalized, 'base64');
  assertInboundEmailAttachmentSize(content.length);
  return content;
}

export function microsoftMessageAttachments(value: unknown): EmailMessageAttachment[] {
  const entries = Array.isArray(value) ? value : [];
  return entries.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const id = cleanString(record.id);
    if (!id) return [];
    const kind = cleanString(record['@odata.type']).toLowerCase();
    const contentId = cleanString(record.contentId) || null;
    return [{
      id,
      filename: sanitizeInboundEmailAttachmentFilename(record.name, `attachment-${index + 1}`),
      contentType: cleanString(record.contentType) || 'application/octet-stream',
      size: safeSize(record.size),
      inline: record.isInline === true,
      downloadable: !kind.endsWith('referenceattachment'),
      ...(contentId ? { contentId } : {}),
    }];
  });
}

export function readableFromBuffer(content: Buffer): Readable {
  return Readable.from(content);
}
