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
const DISPLAY_MCP_DETAILS_LIMIT = 2 * 1024 * 1024;
const MCP_APP_DESCRIPTOR_KEYS = new Set(['version', 'connectionId', 'toolName', 'resourceUri']);

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

function isMcpToolResultDetails(value: unknown, toolName: unknown): value is Record<string, unknown> {
  return isRecord(value) && (
    isRecord(value.mcpApp)
    || (isRecord(value.result) && typeof toolName === 'string' && toolName.toLowerCase().includes('mcp'))
  );
}

function compactMcpAppDescriptor(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const descriptor: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!MCP_APP_DESCRIPTOR_KEYS.has(key)) continue;
    if (key === 'version' && entry === 1) descriptor[key] = entry;
    if (key === 'connectionId' && typeof entry === 'string' && entry.length <= 64) descriptor[key] = entry;
    if (key === 'toolName' && typeof entry === 'string' && entry.length <= 256) descriptor[key] = entry;
    if (key === 'resourceUri' && typeof entry === 'string' && entry.length <= 4_096) descriptor[key] = entry;
  }
  return Object.keys(descriptor).length > 0 ? descriptor : undefined;
}

function stripMcpModelMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMcpModelMetadata);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '_meta' || key === 'internalWidgetDescriptor') {
      continue;
    }
    result[key] = stripMcpModelMetadata(entry);
  }
  return result;
}

function projectMcpToolResultDetails(
  details: Record<string, unknown>,
  mode: Exclude<PiMessageProjectionMode, 'raw'>,
): Record<string, unknown> {
  if (mode === 'context') {
    const { mcpApp: _mcpApp, mcpToolInput: _mcpToolInput, result, ...rest } = details;
    return result === undefined
      ? rest
      : { ...rest, result: compactDetailsValue(stripMcpModelMetadata(result)) };
  }

  const serialized = JSON.stringify(details);
  if (serialized.length <= DISPLAY_MCP_DETAILS_LIMIT) return details;

  const { mcpApp, mcpToolInput, result, ...rest } = details;
  const compacted = {
    ...rest,
    ...(compactMcpAppDescriptor(mcpApp) ? { mcpApp: compactMcpAppDescriptor(mcpApp) } : {}),
    ...(mcpToolInput === undefined ? {} : { mcpToolInput: compactDetailsValue(mcpToolInput) }),
    ...(result === undefined ? {} : { result: compactDetailsValue(stripMcpModelMetadata(result)) }),
  };
  if (JSON.stringify(compacted).length <= DISPLAY_MCP_DETAILS_LIMIT) return compacted;

  return {
    ...(compactMcpAppDescriptor(mcpApp) ? { mcpApp: compactMcpAppDescriptor(mcpApp) } : {}),
    result: {
      content: [{
        type: 'text',
        text: '[MCP result details exceeded the display limit. The complete result remains in the raw database record.]',
      }],
    },
  };
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
  const isMcp = isMcpToolResultDetails(record.details, record.toolName);
  const details = isMcp
    ? projectMcpToolResultDetails(record.details as Record<string, unknown>, mode)
    : record.details;
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

  if (!truncated && rawContentLength <= LARGE_PERSISTED_MESSAGE_THRESHOLD && details === record.details) {
    return message;
  }

  return {
    ...record,
    content: compactedContent,
    details: isMcp
      ? details
      : details === record.details
      ? (record.details === undefined ? undefined : compactDetailsValue(record.details))
      : details,
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
