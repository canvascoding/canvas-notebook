import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { deriveUploadAttachmentPreview } from '@/app/lib/chat/attachment-preview';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import type { Attachment, ChatMessage, PersistedToolCallPart } from '@/app/lib/chat/types';
import { isCompactBreakMessage, isComposioAuthRequiredMessage, isRuntimeContinuationMessage } from '@/app/lib/pi/custom-messages';
import { toMediaUrl, toPreviewUrl, toUploadMediaUrl, toUploadPreviewUrl, toWorkspaceMediaUrl } from '@/app/lib/utils/media-url';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getPiMessageDetails(piMessage?: AgentMessage | null): unknown {
  return isRecord(piMessage) ? piMessage.details : undefined;
}

export function isTextPart(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

export function isImagePart(value: unknown): value is { type: 'image'; data: string; mimeType: string } {
  return isRecord(value) && value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string';
}

export function contentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (isTextPart(part) ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

export function createAttachmentBlockRegex(): RegExp {
  return /(^|\n)--- Attachment: ([^\n]+) ---\n([\s\S]*?)\n--- Ende Attachment: [^\n]+ ---/g;
}

function getAttachmentBlockField(block: string, fieldName: string): string | undefined {
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^${escapedFieldName}:\\s*(.*)$`, 'm'));
  return match?.[1]?.trim() || undefined;
}

export function parseAttachmentBlocks(text: string): Attachment[] {
  const attachments: Attachment[] = [];

  for (const match of text.matchAll(createAttachmentBlockRegex())) {
    const name = match[2]?.trim();
    const block = match[3] || '';
    const id = getAttachmentBlockField(block, 'fileId');
    const rawContentKind = getAttachmentBlockField(block, 'contentKind');
    const contentKind = rawContentKind === 'image' || rawContentKind === 'document'
      ? rawContentKind
      : null;

    if (!name || !id || !contentKind) {
      continue;
    }

    attachments.push(deriveUploadAttachmentPreview({
      name,
      id,
      contentKind,
      mimeType: getAttachmentBlockField(block, 'mimeType'),
      category: getAttachmentBlockField(block, 'category'),
      filePath: getAttachmentBlockField(block, 'containerFilePath'),
      previewUrl: getAttachmentBlockField(block, 'previewUrl'),
      mediaUrl: getAttachmentBlockField(block, 'mediaUrl'),
    }));
  }

  return attachments;
}

export function stripAttachmentBlocks(text: string): string {
  return text
    .replace(createAttachmentBlockRegex(), (_match, prefix: string) => prefix || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeAttachmentId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getImagePartAttachmentId(part: { data: string }): string | null {
  if (!part.data.startsWith('/api/files/')) {
    return null;
  }

  const rawId = part.data.slice('/api/files/'.length).split(/[?#]/, 1)[0];
  return rawId ? decodeAttachmentId(rawId) : null;
}

export function dedupeAttachments(attachments: Attachment[]): Attachment[] {
  const byKey = new Map<string, Attachment>();

  for (const attachment of attachments) {
    const key = `${attachment.contentKind}:${attachment.id || attachment.filePath || attachment.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, attachment);
      continue;
    }

    byKey.set(key, {
      ...existing,
      name: existing.name || attachment.name,
      mimeType: existing.mimeType || attachment.mimeType,
      category: existing.category || attachment.category,
      filePath: existing.filePath || attachment.filePath,
      previewUrl: existing.previewUrl || attachment.previewUrl,
      mediaUrl: existing.mediaUrl || attachment.mediaUrl,
    });
  }

  return Array.from(byKey.values());
}

export function normalizeMessageStart(text: string): string {
  return text.replace(/^\s+/, '');
}

export function isAbortedAssistantPiMessage(piMessage?: AgentMessage | null): boolean {
  const candidate = piMessage as { role?: unknown; stopReason?: unknown } | null | undefined;
  return candidate?.role === 'assistant' && candidate.stopReason === 'aborted';
}

export function getPiMessageContent(piMessage?: AgentMessage | null): string | unknown[] | undefined {
  if (!piMessage || !('content' in piMessage)) {
    return undefined;
  }

  return piMessage.content;
}

export function getChatMessageRole(role: AgentMessage['role']): ChatMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'toolResult') {
    return role;
  }

  return 'system';
}

function stripThinkingTags(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<\/?thinking>/gi, '')
    .replace(/<\/?reasoning>/gi, '')
    .trim();
}

export function extractPiMessageText(piMessage?: AgentMessage | null, options?: { hideAttachmentMetadata?: boolean }): string {
  if (!piMessage || isCompactBreakMessage(piMessage) || isComposioAuthRequiredMessage(piMessage) || isRuntimeContinuationMessage(piMessage)) {
    return '';
  }

  const messageContent = getPiMessageContent(piMessage);
  if (!Array.isArray(messageContent)) {
    const text = typeof messageContent === 'string' ? messageContent : '';
    const strippedText = stripThinkingTags(text);
    return options?.hideAttachmentMetadata ? stripAttachmentBlocks(strippedText) : strippedText;
  }

  const textContent = messageContent
    .map((part: unknown) => (isTextPart(part) ? part.text : ''))
    .filter(Boolean)
    .join('\n');

  if (textContent) {
    const strippedText = stripThinkingTags(textContent);
    const visibleText = options?.hideAttachmentMetadata ? stripAttachmentBlocks(strippedText) : strippedText;
    return normalizeMessageStart(visibleText);
  }

  if (piMessage.role === 'assistant' && piMessage.stopReason === 'error' && piMessage.errorMessage) {
    return `[Error] ${piMessage.errorMessage}`;
  }

  return '';
}

export function extractToolResultText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return normalizeMessageStart(
    content
      .map((part) => (isTextPart(part) ? part.text : ''))
      .filter(Boolean)
      .join('\n'),
  );
}

export function isToolCallPart(part: unknown): part is PersistedToolCallPart {
  return (
    !!part &&
    typeof part === 'object' &&
    'type' in part &&
    part.type === 'toolCall' &&
    'id' in part &&
    typeof part.id === 'string' &&
    'name' in part &&
    typeof part.name === 'string'
  );
}

export function extractImageAttachments(content: unknown, metadataAttachments: Attachment[] = []): Attachment[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const metadataById = new Map(metadataAttachments.map((attachment) => [attachment.id, attachment]));
  const attachments = content.reduce<Attachment[]>((result, part, index) => {
    if (isImagePart(part)) {
      const imageId = getImagePartAttachmentId(part);
      if (!imageId) {
        return result;
      }

      const metadata = metadataById.get(imageId);
      result.push(deriveUploadAttachmentPreview({
        name: metadata?.name || `attachment-${index + 1}`,
        contentKind: 'image',
        id: imageId,
        mimeType: metadata?.mimeType || part.mimeType,
        category: metadata?.category || 'image',
        filePath: metadata?.filePath,
        previewUrl: metadata?.previewUrl,
        mediaUrl: metadata?.mediaUrl,
      }));
    }
    return result;
  }, []);

  return attachments;
}

export function extractMessageAttachments(content: unknown): Attachment[] | undefined {
  const text = contentToString(content);
  const metadataAttachments = parseAttachmentBlocks(text);
  const imageAttachments = extractImageAttachments(content, metadataAttachments);
  const attachments = dedupeAttachments([...metadataAttachments, ...imageAttachments]);
  return attachments.length > 0 ? attachments : undefined;
}

const IMAGE_PREVIEW_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);

function getPathBasename(value: string): string {
  const cleanPath = value.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  return cleanPath.split('/').filter(Boolean).pop() || value;
}

function getImageFileExtension(value: string): string {
  const basename = getPathBasename(value);
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex === -1 ? '' : basename.slice(dotIndex + 1).toLowerCase();
}

function isPreviewableImagePath(value: string): boolean {
  return IMAGE_PREVIEW_EXTENSIONS.has(getImageFileExtension(value));
}

function getUploadImageIdFromPath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').split(/[?#]/, 1)[0];
  const apiFileMatch = normalized.match(/^\/api\/files\/([^/]+)$/);
  if (apiFileMatch?.[1]) {
    return decodeAttachmentId(apiFileMatch[1]);
  }

  const uploadMatch = normalized.match(/(?:^|\/)user-uploads\/image\/([^/]+)$/);
  if (uploadMatch?.[1]) {
    return uploadMatch[1];
  }

  const storagePathMatch = normalized.match(/^image\/([^/]+)$/);
  if (storagePathMatch?.[1]) {
    return storagePathMatch[1];
  }

  return null;
}

function decodeMediaPath(value: string): string {
  return value
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function normalizeStudioOutputPath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').split(/[?#]/, 1)[0];
  const apiStudioPrefix = '/api/studio/media/';
  if (normalized.startsWith(apiStudioPrefix)) {
    return decodeMediaPath(normalized.slice(apiStudioPrefix.length));
  }

  const studioOutputMatch = normalized.match(/(?:^|\/)studio\/outputs\/(.+)$/);
  if (studioOutputMatch?.[1]) {
    return `studio/outputs/${studioOutputMatch[1]}`;
  }

  return null;
}

function createImageAttachmentFromFileReference(value: string, fallbackName?: string): Attachment | null {
  const uploadId = getUploadImageIdFromPath(value);
  if (uploadId && isPreviewableImagePath(uploadId)) {
    return {
      name: fallbackName || getPathBasename(uploadId),
      contentKind: 'image',
      id: uploadId,
      category: 'image',
      previewUrl: toUploadPreviewUrl(uploadId, 192, { preset: 'mini' }),
      mediaUrl: toUploadMediaUrl(uploadId),
      filePath: value,
    };
  }

  const studioPath = normalizeStudioOutputPath(value);
  if (studioPath && isPreviewableImagePath(studioPath)) {
    return {
      name: fallbackName || getPathBasename(studioPath),
      contentKind: 'image',
      id: `studio:${studioPath}`,
      category: 'image',
      previewUrl: toPreviewUrl(studioPath, 192, { preset: 'mini' }),
      mediaUrl: toMediaUrl(studioPath),
      filePath: value,
    };
  }

  if (!isPreviewableImagePath(value)) {
    return null;
  }

  const normalizedWorkspacePath = normalizeChatFilePath(value);
  return {
    name: fallbackName || getPathBasename(value),
    contentKind: 'image',
    id: `workspace:${normalizedWorkspacePath}`,
    category: 'image',
    previewUrl: toPreviewUrl(normalizedWorkspacePath, 192, { preset: 'mini' }),
    mediaUrl: toWorkspaceMediaUrl(normalizedWorkspacePath),
    filePath: value,
  };
}

export function extractToolResultImageAttachments(piMessage?: AgentMessage | null): Attachment[] {
  if (!piMessage || piMessage.role !== 'toolResult') {
    return [];
  }

  const record = piMessage as unknown as Record<string, unknown>;
  const details = record.details;
  if (!isRecord(details)) {
    return [];
  }

  const type = typeof details.type === 'string' ? details.type : '';
  const filePath = typeof details.filePath === 'string' ? details.filePath : '';
  if (type !== 'image' || !filePath) {
    return [];
  }

  const previewUrl = typeof details.previewUrl === 'string' ? details.previewUrl : undefined;
  const mediaUrl = typeof details.mediaUrl === 'string' ? details.mediaUrl : undefined;
  const mimeType = typeof details.mimeType === 'string' ? details.mimeType : undefined;
  const size = typeof details.size === 'number' ? details.size : undefined;
  const name = typeof details.name === 'string' ? details.name : getPathBasename(filePath);
  const inferredAttachment = createImageAttachmentFromFileReference(filePath, name);
  if (!inferredAttachment && !previewUrl && !mediaUrl) {
    return [];
  }

  return [{
    ...(inferredAttachment || {
      name,
      contentKind: 'image' as const,
      id: `tool-result:${filePath}`,
      category: 'image',
      filePath,
    }),
    previewUrl: previewUrl || inferredAttachment?.previewUrl,
    mediaUrl: mediaUrl || inferredAttachment?.mediaUrl,
    mimeType: mimeType || inferredAttachment?.mimeType,
    size: size ?? inferredAttachment?.size,
  }];
}

export function formatToolArgs(args: unknown): string {
  if (args === undefined) {
    return '';
  }

  if (typeof args === 'string') {
    return args;
  }

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function truncatePreview(value: string, maxLength = 88): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}
