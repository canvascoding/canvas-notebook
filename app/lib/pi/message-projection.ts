import type { AgentMessage } from '@earendil-works/pi-agent-core';

export type PiMessageProjectionMode = 'raw' | 'context' | 'display';

const LARGE_PERSISTED_MESSAGE_THRESHOLD = 200_000;
const CONTEXT_TOOL_RESULT_TEXT_LIMIT = 12_000;
const DISPLAY_TOOL_RESULT_TEXT_LIMIT = 20_000;
const LARGE_INLINE_IMAGE_THRESHOLD = 8 * 1024 * 1024;
const DETAILS_STRING_LIMIT = 4_000;
const DETAILS_ARRAY_LIMIT = 20;
const DETAILS_OBJECT_KEY_LIMIT = 40;
const DETAILS_MAX_DEPTH = 5;

type ProjectionMetadata = {
  mode: Exclude<PiMessageProjectionMode, 'raw'>;
  rawContentLength: number;
  truncated: boolean;
  omittedImages: number;
  omittedTextCharacters: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getTextLimit(mode: PiMessageProjectionMode): number {
  return mode === 'display' ? DISPLAY_TOOL_RESULT_TEXT_LIMIT : CONTEXT_TOOL_RESULT_TEXT_LIMIT;
}

function truncateTextForProjection(value: string, remainingCharacters: number): { text: string; omitted: number; truncated: boolean } {
  if (remainingCharacters <= 0) {
    return { text: '', omitted: value.length, truncated: value.length > 0 };
  }

  if (value.length <= remainingCharacters) {
    return { text: value, omitted: 0, truncated: false };
  }

  const suffix = `\n\n[...tool result truncated for loaded chat context; ${value.length - remainingCharacters} characters remain in the raw database record]`;
  const sliceLength = Math.max(0, remainingCharacters - suffix.length);
  return {
    text: `${value.slice(0, sliceLength).trimEnd()}${suffix}`,
    omitted: value.length - sliceLength,
    truncated: true,
  };
}

function compactDetailsValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length <= DETAILS_STRING_LIMIT) return value;
    return `${value.slice(0, DETAILS_STRING_LIMIT).trimEnd()}\n[...truncated details string; raw value remains in database]`;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (depth >= DETAILS_MAX_DEPTH) {
    return '[Nested details omitted from loaded chat context; raw value remains in database]';
  }

  if (Array.isArray(value)) {
    const compacted = value.slice(0, DETAILS_ARRAY_LIMIT).map((entry) => compactDetailsValue(entry, depth + 1));
    if (value.length > DETAILS_ARRAY_LIMIT) {
      compacted.push(`[...${value.length - DETAILS_ARRAY_LIMIT} detail entries omitted; raw value remains in database]`);
    }
    return compacted;
  }

  const entries = Object.entries(value);
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(0, DETAILS_OBJECT_KEY_LIMIT)) {
    result[key] = compactDetailsValue(entryValue, depth + 1);
  }
  if (entries.length > DETAILS_OBJECT_KEY_LIMIT) {
    result.__omittedKeys = entries.length - DETAILS_OBJECT_KEY_LIMIT;
  }
  return result;
}

function looksLikeInlineImageData(value: string): boolean {
  if (value.length <= LARGE_INLINE_IMAGE_THRESHOLD) {
    return false;
  }
  if (
    value.startsWith('/') ||
    value.startsWith('file://') ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/api/')
  ) {
    return false;
  }

  const sample = value.length > 12_000
    ? `${value.slice(0, 4_000)}${value.slice(Math.floor(value.length / 2), Math.floor(value.length / 2) + 4_000)}${value.slice(-4_000)}`
    : value;
  return /^[A-Za-z0-9+/=\s]+$/u.test(sample);
}

function compactImagePart(
  part: Record<string, unknown>,
  metadata: { omittedImages: number },
): Record<string, unknown> {
  if (part.type !== 'image' || typeof part.data !== 'string' || !looksLikeInlineImageData(part.data)) {
    return part;
  }

  metadata.omittedImages += 1;
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType : 'image';
  return {
    type: 'text',
    text: `[${mimeType} image omitted from loaded chat context (${part.data.length} inline characters); raw image remains in database]`,
  };
}

function compactInlineImagesForProjection(
  message: AgentMessage,
  mode: Exclude<PiMessageProjectionMode, 'raw'>,
  rawContentLength: number,
): AgentMessage {
  const record = message as unknown as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) {
    return message;
  }

  const metadata = { omittedImages: 0 };
  const compactedContent = content.map((part) => {
    if (!isRecord(part)) return part;
    return compactImagePart(part, metadata);
  });

  if (metadata.omittedImages === 0) {
    return message;
  }

  return {
    ...record,
    content: compactedContent,
    persistenceProjection: {
      mode,
      rawContentLength,
      truncated: true,
      omittedImages: metadata.omittedImages,
      omittedTextCharacters: 0,
    } satisfies ProjectionMetadata,
  } as unknown as AgentMessage;
}

function compactToolResultMessage(
  message: AgentMessage,
  mode: Exclude<PiMessageProjectionMode, 'raw'>,
  rawContentLength: number,
): AgentMessage {
  const record = message as unknown as Record<string, unknown>;
  const textLimit = getTextLimit(mode);
  const content = record.content;
  let remainingText = textLimit;
  let truncated = rawContentLength > LARGE_PERSISTED_MESSAGE_THRESHOLD;
  let omittedImages = 0;
  let omittedTextCharacters = 0;

  const compactTextPart = (text: string) => {
    const compacted = truncateTextForProjection(text, remainingText);
    remainingText = Math.max(0, remainingText - compacted.text.length);
    omittedTextCharacters += compacted.omitted;
    truncated = truncated || compacted.truncated;
    return compacted.text;
  };

  const compactedContent = Array.isArray(content)
    ? content.map((part) => {
        if (!isRecord(part)) return part;
        if (part.type === 'text' && typeof part.text === 'string') {
          return { ...part, text: compactTextPart(part.text) };
        }
        if (part.type === 'image') {
          const imageMetadata = { omittedImages: 0 };
          const compactedImagePart = compactImagePart(part, imageMetadata);
          if (imageMetadata.omittedImages > 0) {
            omittedImages += imageMetadata.omittedImages;
            truncated = true;
            return compactedImagePart;
          }
          return part;
        }
        return compactDetailsValue(part);
      })
    : typeof content === 'string'
      ? compactTextPart(content)
      : compactDetailsValue(content);

  if (!truncated && rawContentLength <= LARGE_PERSISTED_MESSAGE_THRESHOLD) {
    return message;
  }

  return {
    ...record,
    content: compactedContent,
    details: record.details === undefined ? undefined : compactDetailsValue(record.details),
    persistenceProjection: {
      mode,
      rawContentLength,
      truncated,
      omittedImages,
      omittedTextCharacters,
    } satisfies ProjectionMetadata,
  } as unknown as AgentMessage;
}

export function projectAgentMessageForLoadedContext(
  message: AgentMessage,
  mode: PiMessageProjectionMode = 'context',
  rawContentLength = JSON.stringify(message).length,
): AgentMessage {
  if (mode === 'raw') return message;
  if (message.role === 'toolResult') {
    return compactToolResultMessage(message, mode, rawContentLength);
  }
  return compactInlineImagesForProjection(message, mode, rawContentLength);
}

export function parsePersistedPiMessage(
  content: string,
  mode: PiMessageProjectionMode = 'context',
): AgentMessage {
  const message = JSON.parse(content) as AgentMessage;
  return projectAgentMessageForLoadedContext(message, mode, content.length);
}
