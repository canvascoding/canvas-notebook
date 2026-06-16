export const EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES = 20 * 1024 * 1024;
export const EMAIL_ATTACHMENT_MAX_FILES = 25;

export type EmailAttachmentSource = 'workspace' | 'upload';

export type EmailAttachmentInput = {
  source: EmailAttachmentSource;
  name?: string;
  mimeType?: string;
  size?: number;
  path?: string;
  uploadId?: string;
};

export type EmailAttachmentDraft = {
  id: string;
  source: EmailAttachmentSource;
  name: string;
  mimeType: string;
  size: number;
  path?: string;
  uploadId?: string;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'text/xml',
  '.zip': 'application/zip',
};

export function inferEmailAttachmentMimeType(name: string, fallback?: string): string {
  const normalizedFallback = typeof fallback === 'string' ? fallback.trim().toLowerCase() : '';
  if (normalizedFallback && !/[\r\n]/u.test(normalizedFallback)) return normalizedFallback;
  const extension = name.match(/\.[^.]+$/u)?.[0]?.toLowerCase() || '';
  return MIME_BY_EXTENSION[extension] || 'application/octet-stream';
}

export function estimateEmailAttachmentTransferBytes(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.ceil(size / 3) * 4 + 512;
}

export function emailAttachmentLimitUsageBytes(attachments: Array<{ size?: number }>): number {
  return attachments.reduce((total, attachment) => total + estimateEmailAttachmentTransferBytes(attachment.size || 0), 0);
}

export function formatEmailAttachmentSize(size?: number): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value < 10 && unitIndex > 0 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}
