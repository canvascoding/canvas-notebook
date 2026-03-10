import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ImageContent, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isImageContentPart(value: unknown): value is ImageContent {
  return (
    isRecord(value) &&
    value.type === 'image' &&
    typeof value.data === 'string' &&
    typeof value.mimeType === 'string'
  );
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

function isValidBase64(value: string): boolean {
  const normalized = stripWhitespace(value);
  return normalized.length > 0 && normalized.length % 4 === 0 && BASE64_PATTERN.test(normalized);
}

function resolveImageMimeType(filePath: string, fallbackMimeType?: string): string {
  if (fallbackMimeType?.startsWith('image/')) {
    return fallbackMimeType;
  }

  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
  if (!mimeType) {
    throw new Error(`Unsupported image attachment type for file: ${filePath}`);
  }

  return mimeType;
}

async function loadImageDataFromFile(filePath: string, mimeType: string): Promise<ImageContent> {
  const bytes = await fs.readFile(filePath);
  return {
    type: 'image',
    data: bytes.toString('base64'),
    mimeType: resolveImageMimeType(filePath, mimeType),
  };
}

async function normalizeImagePart(part: ImageContent): Promise<ImageContent> {
  const rawData = part.data.trim();
  const dataUrlMatch = rawData.match(DATA_URL_PATTERN);
  if (dataUrlMatch) {
    return {
      type: 'image',
      data: stripWhitespace(dataUrlMatch[2]),
      mimeType: part.mimeType || dataUrlMatch[1],
    };
  }

  if (rawData.startsWith('file://')) {
    return loadImageDataFromFile(fileURLToPath(rawData), part.mimeType);
  }

  if (path.isAbsolute(rawData)) {
    return loadImageDataFromFile(rawData, part.mimeType);
  }

  if (isValidBase64(rawData)) {
    return {
      type: 'image',
      data: stripWhitespace(rawData),
      mimeType: part.mimeType,
    };
  }

  throw new Error(
    'Invalid image attachment payload. Expected base64 image data, a base64 data URL, or an absolute file path.',
  );
}

async function normalizeImageArray(
  content: Array<{ type: 'text'; text: string } | ImageContent>,
): Promise<Array<{ type: 'text'; text: string } | ImageContent>> {
  let changed = false;
  const normalizedContent = await Promise.all(
    content.map(async (part) => {
      if (!isImageContentPart(part)) {
        return part;
      }

      const normalizedPart = await normalizeImagePart(part);
      if (normalizedPart.data !== part.data || normalizedPart.mimeType !== part.mimeType) {
        changed = true;
      }

      return normalizedPart;
    }),
  );

  return changed ? normalizedContent : content;
}

async function normalizePiMessage(message: AgentMessage): Promise<Message> {
  if (!Array.isArray(message.content)) {
    return message as Message;
  }

  if (message.role === 'user') {
    const normalizedContent = await normalizeImageArray(message.content);
    return normalizedContent === message.content
      ? (message as UserMessage)
      : {
          ...message,
          content: normalizedContent,
        };
  }

  if (message.role === 'toolResult') {
    const normalizedContent = await normalizeImageArray(message.content);
    return normalizedContent === message.content
      ? (message as ToolResultMessage)
      : {
          ...message,
          content: normalizedContent,
        };
  }

  return message as Message;
}

export async function normalizePiMessagesForLlm(messages: AgentMessage[]): Promise<Message[]> {
  return Promise.all(messages.map((message) => normalizePiMessage(message)));
}
