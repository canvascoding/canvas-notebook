import 'server-only';

import path from 'node:path';

import {
  EMAIL_ATTACHMENT_MAX_FILES,
  EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
  estimateEmailAttachmentTransferBytes,
  inferEmailAttachmentMimeType,
  isMarkdownEmailAttachmentName,
  markdownEmailAttachmentPdfName,
  type EmailAttachmentDeliveryFormat,
  type EmailAttachmentInput,
  type EmailAttachmentSource,
} from '@/app/lib/email/attachment-types';
import {
  getFileStats as getWorkspaceFileStats,
  readFile as readWorkspaceFile,
} from '@/app/lib/filesystem/workspace-files';
import {
  getFileInfo as getUploadedFileInfo,
  readFile as readUploadedFile,
} from '@/app/lib/filesystem/upload-handler';

export type ResolvedEmailAttachment = {
  content: Buffer;
  mimeType: string;
  name: string;
  size: number;
  source: EmailAttachmentSource;
};

type EmailAttachmentMetadata = Omit<ResolvedEmailAttachment, 'content'> & {
  deliveryFormat: EmailAttachmentDeliveryFormat;
  input: EmailAttachmentInput;
};

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanFileName(value: string): string {
  const base = path.basename(value.replace(/\\/g, '/')).replace(/[\r\n"]/g, '_').trim();
  return base || 'attachment';
}

export function normalizeEmailAttachmentInputs(value: unknown): EmailAttachmentInput[] {
  if (!Array.isArray(value)) return [];
  const output: EmailAttachmentInput[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const source = record.source === 'workspace' || record.source === 'upload' ? record.source : null;
    if (!source) continue;

    const normalized: EmailAttachmentInput = {
      source,
      name: cleanString(record.name) || undefined,
      mimeType: cleanString(record.mimeType) || undefined,
      size: typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0 ? record.size : undefined,
      path: cleanString(record.path) || undefined,
      uploadId: cleanString(record.uploadId) || undefined,
      deliveryFormat: record.deliveryFormat === 'pdf' || record.deliveryFormat === 'original' ? record.deliveryFormat : undefined,
    };
    output.push(normalized);
  }

  return output;
}

function assertAttachmentLimit(metadata: Array<{ size: number }>) {
  if (metadata.length > EMAIL_ATTACHMENT_MAX_FILES) {
    throw new Error(`Maximum ${EMAIL_ATTACHMENT_MAX_FILES} attachments per email.`);
  }

  const total = metadata.reduce((sum, attachment) => sum + estimateEmailAttachmentTransferBytes(attachment.size), 0);
  if (total > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
    throw new Error('Email attachments exceed the 20 MB total limit.');
  }
}

async function resolveWorkspaceAttachmentMetadata(input: EmailAttachmentInput): Promise<EmailAttachmentMetadata> {
  const workspacePath = cleanString(input.path);
  if (!workspacePath) throw new Error('Workspace attachment path is required.');
  const stats = await getWorkspaceFileStats(workspacePath);
  if (!stats.isFile) throw new Error(`Attachment "${workspacePath}" is not a file.`);
  const name = cleanFileName(input.name || workspacePath);
  const wantsPdf = input.deliveryFormat === 'pdf';
  if (wantsPdf) {
    const markdownName = isMarkdownEmailAttachmentName(name) ? name : path.basename(workspacePath);
    if (!isMarkdownEmailAttachmentName(workspacePath) && !isMarkdownEmailAttachmentName(markdownName)) {
      throw new Error(`Attachment "${name}" cannot be sent as PDF because it is not a markdown file.`);
    }
    return {
      deliveryFormat: 'pdf',
      input: { ...input, path: workspacePath },
      mimeType: 'application/pdf',
      name: cleanFileName(markdownEmailAttachmentPdfName(markdownName)),
      size: stats.size,
      source: 'workspace',
    };
  }

  return {
    deliveryFormat: 'original',
    input: { ...input, path: workspacePath },
    mimeType: inferEmailAttachmentMimeType(name, input.mimeType),
    name,
    size: stats.size,
    source: 'workspace',
  };
}

async function resolveUploadAttachmentMetadata(input: EmailAttachmentInput): Promise<EmailAttachmentMetadata> {
  const uploadId = cleanString(input.uploadId);
  if (!uploadId) throw new Error('Uploaded attachment id is required.');
  const info = await getUploadedFileInfo(uploadId);
  if (!info) throw new Error(`Uploaded attachment "${uploadId}" was not found.`);
  const name = cleanFileName(input.name || info.originalName || uploadId);
  if (input.deliveryFormat === 'pdf') {
    throw new Error(`Uploaded attachment "${name}" cannot be sent as PDF. Attach a workspace markdown file to use PDF conversion.`);
  }

  return {
    deliveryFormat: 'original',
    input: { ...input, uploadId },
    mimeType: inferEmailAttachmentMimeType(name, input.mimeType || info.mimeType),
    name,
    size: info.size,
    source: 'upload',
  };
}

async function resolveAttachmentMetadata(input: EmailAttachmentInput): Promise<EmailAttachmentMetadata> {
  if (input.source === 'workspace') return resolveWorkspaceAttachmentMetadata(input);
  return resolveUploadAttachmentMetadata(input);
}

async function readAttachmentContent(metadata: EmailAttachmentMetadata): Promise<ResolvedEmailAttachment> {
  const content = metadata.deliveryFormat === 'pdf'
    ? await renderWorkspaceMarkdownPdf(metadata)
    : metadata.source === 'workspace'
      ? await readWorkspaceFile(metadata.input.path || '')
      : await readUploadedFile(metadata.input.uploadId || '');

  if (!content) throw new Error(`Attachment "${metadata.name}" could not be read.`);
  if (estimateEmailAttachmentTransferBytes(content.length) > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
    throw new Error(`Attachment "${metadata.name}" exceeds the 20 MB total limit.`);
  }

  return {
    content,
    mimeType: metadata.mimeType,
    name: metadata.name,
    size: content.length,
    source: metadata.source,
  };
}

async function renderWorkspaceMarkdownPdf(metadata: EmailAttachmentMetadata): Promise<Buffer> {
  if (metadata.source !== 'workspace' || !metadata.input.path) {
    throw new Error(`Attachment "${metadata.name}" cannot be rendered as PDF.`);
  }

  const { renderMarkdownWorkspaceFileToPdf } = await import('@/app/lib/pdf/markdown-pdf');
  return renderMarkdownWorkspaceFileToPdf(metadata.input.path);
}

export async function resolveEmailAttachments(value: unknown): Promise<ResolvedEmailAttachment[]> {
  const inputs = normalizeEmailAttachmentInputs(value);
  if (inputs.length === 0) return [];

  const metadata = await Promise.all(inputs.map(resolveAttachmentMetadata));
  assertAttachmentLimit(metadata);

  const resolved = await Promise.all(metadata.map(readAttachmentContent));
  assertAttachmentLimit(resolved);
  return resolved;
}
