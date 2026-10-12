import type { EmailAttachmentDraft } from './attachment-types';
import { markdownEmailAttachmentPdfName } from './attachment-types';
import type { EmailReviewEntry } from './review-client';
import { toUploadMediaUrl, toWorkspaceMediaUrl } from '@/app/lib/utils/media-url';

export const EMAIL_ATTACHMENT_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

type PreviewSource =
  | { kind: 'inbound'; accountId: string; messageId: string; attachmentId: string; folder?: string; workspaceId?: string | null }
  | { kind: 'upload'; uploadId: string }
  | { kind: 'workspace'; workspaceId: string; path: string; asPdf: boolean }
  | { kind: 'draft'; uploadId: string; draftId: string; version: number; workspaceId?: string };
export type EmailAttachmentPreviewItem = { id: string; name: string; mimeType?: string; size?: number; source: PreviewSource | null };
export type EmailAttachmentPreviewKind = 'image' | 'pdf' | 'office' | 'markdown' | 'text' | 'unsupported';
export type EmailAttachmentPreviewResource = {
  objectUrl: string; kind: EmailAttachmentPreviewKind; data?: ArrayBuffer; text?: string; truncated: boolean; size: number;
};
export class EmailAttachmentPreviewError extends Error {
  constructor(readonly code: 'unavailable' | 'forbidden' | 'changed' | 'large' | 'failed', readonly status = 0) { super(code); }
}

export function inboundEmailAttachmentPreviewItems(input: {
  accountId?: string; messageId: string; folder?: string; workspaceId?: string | null;
  attachments: Array<{ id: string; filename: string; contentType?: string; size?: number | null; downloadable?: boolean }>;
}): EmailAttachmentPreviewItem[] {
  return input.attachments.map((attachment, index) => ({
    id: attachment.id || `unavailable-${index}`, name: attachment.filename, mimeType: attachment.contentType, size: attachment.size ?? undefined,
    source: input.accountId && attachment.id && attachment.downloadable !== false
      ? { kind: 'inbound', accountId: input.accountId, messageId: input.messageId, attachmentId: attachment.id, folder: input.folder, workspaceId: input.workspaceId } : null,
  }));
}
export function draftEmailAttachmentPreviewItems(entry: EmailReviewEntry | null): EmailAttachmentPreviewItem[] {
  return (entry?.attachments || []).map((attachment, index) => ({
    id: attachment.uploadId || attachment.id || `unavailable-${index}`, name: attachment.name || 'attachment', mimeType: attachment.mimeType, size: attachment.size,
    source: entry && attachment.source === 'upload' && attachment.uploadId
      ? { kind: 'draft', uploadId: attachment.uploadId, draftId: entry.id, version: entry.version, workspaceId: entry.scope === 'workspace' ? entry.workspaceId : undefined } : null,
  }));
}
export function composeEmailAttachmentPreviewItems(attachments: EmailAttachmentDraft[], workspaceId: string | null): EmailAttachmentPreviewItem[] {
  return attachments.map(attachment => {
    const asPdf = attachment.source === 'workspace' && attachment.deliveryFormat === 'pdf';
    return {
      id: attachment.id, name: asPdf ? markdownEmailAttachmentPdfName(attachment.name) : attachment.name,
      mimeType: asPdf ? 'application/pdf' : attachment.mimeType, size: asPdf ? undefined : attachment.size,
      source: attachment.source === 'upload' && attachment.uploadId ? { kind: 'upload' as const, uploadId: attachment.uploadId }
        : attachment.source === 'workspace' && attachment.path && workspaceId ? { kind: 'workspace' as const, workspaceId, path: attachment.path, asPdf } : null,
    };
  });
}
export function emailAttachmentPreviewURL(item: EmailAttachmentPreviewItem): string | null {
  const source = item.source;
  if (!source) return null;
  if (source.kind === 'upload' || source.kind === 'draft') return toUploadMediaUrl(source.uploadId);
  if (source.kind === 'workspace') return source.asPdf ? '/api/files/markdown-pdf' : toWorkspaceMediaUrl(source.path, { workspaceId: source.workspaceId });
  const params = new URLSearchParams();
  if (source.folder) params.set('folder', source.folder);
  if (source.workspaceId) params.set('mailboxWorkspaceId', source.workspaceId);
  const base = `/api/email/accounts/${encodeURIComponent(source.accountId)}/messages/${encodeURIComponent(source.messageId)}/attachments/${encodeURIComponent(source.attachmentId)}`;
  return params.size ? `${base}?${params}` : base;
}
export function emailAttachmentPreviewKind(item: Pick<EmailAttachmentPreviewItem, 'name' | 'mimeType'>): EmailAttachmentPreviewKind {
  const extension = item.name.split('.').pop()?.toLowerCase() || '';
  if (['svg', 'html', 'htm', 'xhtml', 'xml', 'js', 'mjs', 'cjs'].includes(extension)) return 'text';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'].includes(extension) || /^image\/(png|jpeg|gif|webp|bmp|avif|x-icon)$/u.test(item.mimeType || '')) return 'image';
  if (extension === 'pdf' || item.mimeType === 'application/pdf') return 'pdf';
  if (['docx', 'xlsx', 'xls', 'csv'].includes(extension)) return 'office';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  if (['txt', 'json', 'yaml', 'yml', 'log', 'ics', 'rtf'].includes(extension) || item.mimeType?.startsWith('text/')) return 'text';
  return 'unsupported';
}
function requireSuccessfulPreviewResponse(response: Response) {
  if (response.ok) return;
  throw new EmailAttachmentPreviewError(response.status === 401 || response.status === 403 ? 'forbidden'
    : response.status === 404 ? 'unavailable' : response.status === 409 ? 'changed' : response.status === 413 ? 'large' : 'failed', response.status);
}
export async function checkEmailAttachmentPreviewAccess(item: EmailAttachmentPreviewItem, signal: AbortSignal, rechecking = false) {
  const source = item.source;
  if (!source) throw new EmailAttachmentPreviewError('unavailable');
  if (source.kind === 'draft') {
    const base = source.workspaceId ? `/api/workspaces/${encodeURIComponent(source.workspaceId)}/email/outbox` : '/api/email/outbox';
    const response = await fetch(`${base}/${encodeURIComponent(source.draftId)}`, { cache: 'no-store', credentials: 'include', signal });
    requireSuccessfulPreviewResponse(response);
    const payload = await response.json();
    if (!payload.success || payload.data?.version !== source.version || !payload.data.attachments?.some((attachment: { uploadId?: string }) => attachment.uploadId === source.uploadId)) throw new EmailAttachmentPreviewError('changed', 409);
  }
  if (!rechecking) return;
  if (source.kind === 'inbound') {
    const response = await fetch('/api/email/mailboxes', { cache: 'no-store', credentials: 'include', signal });
    requireSuccessfulPreviewResponse(response);
    const payload = await response.json();
    if (!payload.success || !payload.data?.accounts?.some((account: { id?: string; workspaceId?: string | null }) => account.id === source.accountId && (account.workspaceId || null) === (source.workspaceId || null))) throw new EmailAttachmentPreviewError('forbidden', 403);
  } else if (source.kind === 'workspace' && source.asPdf) {
    const response = await fetch('/api/workspaces', { cache: 'no-store', credentials: 'include', signal });
    requireSuccessfulPreviewResponse(response);
    const payload = await response.json();
    if (!payload.workspaces?.some((workspace: { id: string; permissions?: { canRead?: boolean } }) => workspace.id === source.workspaceId && workspace.permissions?.canRead !== false)) throw new EmailAttachmentPreviewError('forbidden', 403);
  } else {
    const response = await fetch(emailAttachmentPreviewURL(item)!, { cache: 'no-store', credentials: 'include', signal,
      headers: item.size === 0 ? undefined : { Range: 'bytes=0-0' } });
    try { requireSuccessfulPreviewResponse(response); } finally { await response.body?.cancel(); }
  }
}
export async function loadEmailAttachmentPreviewResource(item: EmailAttachmentPreviewItem, signal: AbortSignal): Promise<EmailAttachmentPreviewResource> {
  await checkEmailAttachmentPreviewAccess(item, signal);
  if (typeof item.size === 'number' && item.size > EMAIL_ATTACHMENT_PREVIEW_MAX_BYTES) throw new EmailAttachmentPreviewError('large', 413);
  const source = item.source!;
  const response = await fetch(emailAttachmentPreviewURL(item)!, { credentials: 'include', cache: 'no-store', signal,
    ...(source.kind === 'workspace' && source.asPdf ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': source.workspaceId }, body: JSON.stringify({ path: source.path }) } : {}),
  });
  requireSuccessfulPreviewResponse(response);
  if (Number(response.headers.get('Content-Length')) > EMAIL_ATTACHMENT_PREVIEW_MAX_BYTES) {
    await response.body?.cancel(); throw new EmailAttachmentPreviewError('large', 413);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new EmailAttachmentPreviewError('failed');
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > EMAIL_ATTACHMENT_PREVIEW_MAX_BYTES) throw new EmailAttachmentPreviewError('large', 413);
      chunks.push(part.value.slice().buffer);
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  signal.throwIfAborted();
  const kind = emailAttachmentPreviewKind(item);
  const blob = new Blob(chunks, { type: kind === 'pdf' ? 'application/pdf' : response.headers.get('Content-Type') || item.mimeType || 'application/octet-stream' });
  const text = kind === 'text' || kind === 'markdown' ? await blob.slice(0, TEXT_PREVIEW_MAX_BYTES).text() : undefined;
  const data = kind === 'pdf' || kind === 'office' ? await blob.arrayBuffer() : undefined;
  signal.throwIfAborted();
  return { objectUrl: URL.createObjectURL(blob), kind, data, text, truncated: text !== undefined && size > TEXT_PREVIEW_MAX_BYTES, size };
}
