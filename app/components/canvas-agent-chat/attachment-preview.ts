import { toMediaUrl, toPreviewUrl, toUploadMediaUrl, toUploadPreviewUrl } from '@/app/lib/utils/media-url';

export interface ChatAttachment {
  name: string;
  contentKind: 'image' | 'document';
  // Upload file ID or stable attachment key.
  id: string;
  mimeType?: string;
  category?: string;
  // Optional absolute/container path for direct server-side reading.
  filePath?: string;
  // Lightweight image thumbnail. Chat UI must use this instead of loading originals.
  previewUrl?: string;
  // Original media URL, used only for explicit open/zoom actions.
  mediaUrl?: string;
  size?: number;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeMediaPath(value: string): string {
  return value
    .split('/')
    .map((segment) => decodePathSegment(segment))
    .join('/');
}

function parseRelativeUrl(value: string): URL | null {
  try {
    return new URL(value, 'http://canvas.local');
  } catch {
    return null;
  }
}

export function deriveUploadAttachmentPreview(attachment: ChatAttachment): ChatAttachment {
  if (attachment.contentKind !== 'image' || !attachment.id) {
    return attachment;
  }

  return {
    ...attachment,
    previewUrl: attachment.previewUrl || toUploadPreviewUrl(attachment.id, 192, { preset: 'mini' }),
    mediaUrl: attachment.mediaUrl || toUploadMediaUrl(attachment.id),
  };
}

export function getAttachmentMediaUrl(attachment: ChatAttachment): string | undefined {
  if (attachment.mediaUrl) {
    return attachment.mediaUrl;
  }

  if (attachment.contentKind === 'image' && attachment.id) {
    return toUploadMediaUrl(attachment.id);
  }

  return undefined;
}

export function resolvePreviewSrcFromMediaUrl(mediaUrl: string, width = 640): string {
  const parsed = parseRelativeUrl(mediaUrl);
  if (!parsed) {
    return mediaUrl;
  }

  const pathParts = parsed.pathname.split('/').filter(Boolean);

  if (pathParts[0] === 'api' && pathParts[1] === 'files') {
    if (pathParts[2] && pathParts[2] !== 'preview') {
      return toUploadPreviewUrl(decodePathSegment(pathParts[2]), width, { preset: 'mini' });
    }
    return mediaUrl;
  }

  if (pathParts[0] === 'api' && pathParts[1] === 'media') {
    const filePath = decodeMediaPath(pathParts.slice(2).join('/'));
    return filePath ? toPreviewUrl(filePath, width, { preset: 'mini' }) : mediaUrl;
  }

  if (pathParts[0] === 'media') {
    const filePath = decodeMediaPath(pathParts.slice(1).join('/'));
    return filePath ? toPreviewUrl(filePath, width, { preset: 'mini' }) : mediaUrl;
  }

  if (pathParts[0] === 'api' && pathParts[1] === 'studio' && pathParts[2] === 'media') {
    const studioPath = decodeMediaPath(pathParts.slice(3).join('/'));
    return studioPath ? toPreviewUrl(studioPath, width, { preset: 'mini' }) : mediaUrl;
  }

  return mediaUrl;
}

export function createImageAttachmentFromMediaUrl(mediaUrl: string, name = 'Image preview'): ChatAttachment {
  return {
    name,
    contentKind: 'image',
    id: mediaUrl,
    mediaUrl,
    previewUrl: resolvePreviewSrcFromMediaUrl(mediaUrl, 1280),
  };
}

export function createImageAttachmentFromWorkspacePath(filePath: string, fallbackName: string): ChatAttachment {
  return {
    name: fallbackName,
    contentKind: 'image',
    id: filePath,
    filePath,
    previewUrl: toPreviewUrl(filePath, 192, { preset: 'mini' }),
    mediaUrl: toMediaUrl(filePath),
  };
}

export function formatAttachmentSize(size?: number): string | null {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return null;
  }

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
