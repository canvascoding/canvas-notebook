import type { AgentMessage } from '@earendil-works/pi-agent-core';

export type PiMessageProjectionMode = 'raw' | 'context' | 'display';

const LARGE_PERSISTED_MESSAGE_THRESHOLD = 200_000;
const CONTEXT_TOOL_RESULT_TEXT_LIMIT = 12_000;
const DISPLAY_TOOL_RESULT_TEXT_LIMIT = 20_000;
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
          omittedImages += 1;
          truncated = true;
          const mimeType = typeof part.mimeType === 'string' ? part.mimeType : 'image';
          const dataLength = typeof part.data === 'string' ? part.data.length : 0;
          return {
            type: 'text',
            text: `[${mimeType} image omitted from loaded chat context (${dataLength} base64 characters); raw image remains in database]`,
          };
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
  if (message.role !== 'toolResult') return message;
  return compactToolResultMessage(message, mode, rawContentLength);
}

export function parsePersistedPiMessage(
  content: string,
  mode: PiMessageProjectionMode = 'context',
): AgentMessage {
  const message = JSON.parse(content) as AgentMessage;
  return projectAgentMessageForLoadedContext(message, mode, content.length);
}
