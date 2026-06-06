import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ImageContent, Message, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { getWorkspacePath } from '../utils/workspace-manager';
import { findFilePath } from '../filesystem/upload-handler';
import { projectAgentMessageForLoadedContext } from './message-projection';
import { convertImage } from '../images/convert';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const INLINE_IMAGE_BYTE_LIMIT = 6 * 1024 * 1024;
const SOURCE_IMAGE_BYTE_LIMIT = 50 * 1024 * 1024;
const LARGE_IMAGE_MAX_DIMENSION = 2048;

// Regex to detect image file references in text
// Supports both quoted: "path/to/file.jpg" and unquoted: path/to/file.jpg
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.heic', '.heif'];
const EXT_PATTERN = IMAGE_EXTENSIONS.map(ext => ext.replace(/\./g, '\\.')).join('|');
const IMAGE_PATH_REGEX = new RegExp(`(?:"([^"]*(?:${EXT_PATTERN}))"|\\b([\\w\\-./]+(?:${EXT_PATTERN}))\\b)`, 'gi');

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

function hasWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

function isCleanBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  // Sample-based check avoids allocating copies of large strings
  const MAX_SAMPLE = 10000;
  if (value.length > MAX_SAMPLE * 3) {
    return BASE64_PATTERN.test(value.slice(0, MAX_SAMPLE))
      && BASE64_PATTERN.test(value.slice(Math.floor(value.length / 2) - MAX_SAMPLE / 2, Math.floor(value.length / 2) + MAX_SAMPLE / 2))
      && BASE64_PATTERN.test(value.slice(-MAX_SAMPLE));
  }
  return BASE64_PATTERN.test(value);
}

function isValidBase64(value: string): boolean {
  if (!hasWhitespace(value)) return isCleanBase64(value);
  const normalized = stripWhitespace(value);
  return isCleanBase64(normalized);
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

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

async function compactImageBufferForLlm(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<ImageContent> {
  if (buffer.length > SOURCE_IMAGE_BYTE_LIMIT) {
    throw new Error(
      `Image attachment is too large for chat context (${Math.ceil(buffer.length / (1024 * 1024))}MB). Maximum source image size is ${SOURCE_IMAGE_BYTE_LIMIT / (1024 * 1024)}MB.`,
    );
  }

  if (buffer.length <= INLINE_IMAGE_BYTE_LIMIT || mimeType === 'image/svg+xml') {
    return {
      type: 'image',
      data: buffer.toString('base64'),
      mimeType,
    };
  }

  try {
    const converted = await convertImage(buffer, originalName, {
      format: 'webp',
      quality: 82,
      maxDimension: LARGE_IMAGE_MAX_DIMENSION,
      sourceMimeType: mimeType,
    });

    return {
      type: 'image',
      data: converted.buffer.toString('base64'),
      mimeType: converted.mimeType,
    };
  } catch (error) {
    console.warn('[Message Normalization] Failed to compact large image attachment:', error instanceof Error ? error.message : error);
    throw new Error(
      `Image attachment is too large for chat context and could not be compacted (${Math.ceil(buffer.length / (1024 * 1024))}MB).`,
    );
  }
}

async function normalizeBase64ImageData(
  data: string,
  mimeType: string,
  originalName = 'attachment',
): Promise<ImageContent> {
  const clean = hasWhitespace(data) ? stripWhitespace(data) : data;
  const estimatedBytes = estimateBase64Bytes(clean);

  if (estimatedBytes <= INLINE_IMAGE_BYTE_LIMIT || mimeType === 'image/svg+xml') {
    return {
      type: 'image',
      data: clean,
      mimeType,
    };
  }

  if (estimatedBytes > SOURCE_IMAGE_BYTE_LIMIT) {
    throw new Error(
      `Image attachment is too large for chat context (${Math.ceil(estimatedBytes / (1024 * 1024))}MB). Maximum source image size is ${SOURCE_IMAGE_BYTE_LIMIT / (1024 * 1024)}MB.`,
    );
  }

  return compactImageBufferForLlm(Buffer.from(clean, 'base64'), originalName, mimeType);
}

async function loadImageDataFromFile(filePath: string, mimeType: string): Promise<ImageContent> {
  const resolvedMimeType = resolveImageMimeType(filePath, mimeType);
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Image attachment path is not a file: ${filePath}`);
  }
  if (stats.size > SOURCE_IMAGE_BYTE_LIMIT) {
    throw new Error(
      `Image attachment is too large for chat context (${Math.ceil(stats.size / (1024 * 1024))}MB). Maximum source image size is ${SOURCE_IMAGE_BYTE_LIMIT / (1024 * 1024)}MB.`,
    );
  }

  const bytes = await fs.readFile(filePath);
  return compactImageBufferForLlm(bytes, path.basename(filePath), resolvedMimeType);
}

async function normalizeImagePart(part: ImageContent): Promise<ImageContent> {
  const rawData = part.data;

  // Fast path: already clean base64 with no leading/trailing whitespace.
  if (rawData.length > 256 && !hasWhitespace(rawData) && isCleanBase64(rawData)) {
    return normalizeBase64ImageData(rawData, part.mimeType, 'base64-attachment');
  }

  const trimmed = rawData.trim();

  const dataUrlMatch = trimmed.match(DATA_URL_PATTERN);
  if (dataUrlMatch) {
    return normalizeBase64ImageData(dataUrlMatch[2], part.mimeType || dataUrlMatch[1], 'data-url-attachment');
  }

  if (trimmed.startsWith('file://')) {
    return loadImageDataFromFile(fileURLToPath(trimmed), part.mimeType);
  }

  if (trimmed.startsWith('/api/files/')) {
    const fileId = trimmed.replace('/api/files/', '');
    try {
      const filePath = await findFilePath(fileId);
      if (filePath) {
        return loadImageDataFromFile(filePath, part.mimeType);
      }
    } catch (error) {
      console.warn(`[Message Normalization] Failed to resolve API file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  if (isValidBase64(trimmed)) {
    return normalizeBase64ImageData(trimmed, part.mimeType, 'base64-attachment');
  }

  const MAX_PATH_LENGTH = 4096;
  if (path.isAbsolute(trimmed) && trimmed.length < MAX_PATH_LENGTH) {
    try {
      return loadImageDataFromFile(trimmed, part.mimeType);
    } catch (error) {
      console.warn(`[Message Normalization] Failed to load image from path: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  throw new Error(
    'Invalid image attachment payload. Expected base64 image data, a base64 data URL, or an absolute file path.',
  );
}

/**
 * Scans text for image file references and converts them to ImageContent
 */
async function extractImageReferencesFromText(text: string): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  const matches = [...text.matchAll(IMAGE_PATH_REGEX)];
  const processedPaths = new Set<string>();
  
  for (const match of matches) {
    // match[1] is quoted path, match[2] is unquoted path
    const filePath = match[1] || match[2];
    if (!filePath || processedPaths.has(filePath)) continue;
    
    // Skip if the "path" is too long (likely base64 data)
    const MAX_PATH_LENGTH = 4096;
    if (filePath.length > MAX_PATH_LENGTH) continue;
    
    processedPaths.add(filePath);
    
    try {
      const workspacePath = getWorkspacePath();
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);
      
      // Check if file exists and is readable
      const stats = await fs.stat(fullPath);
      if (stats.isFile()) {
        const buffer = await fs.readFile(fullPath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = IMAGE_MIME_BY_EXTENSION[ext];
        
        if (mimeType) {
          images.push({
            type: 'image',
            data: buffer.toString('base64'),
            mimeType,
          });
        }
      }
    } catch {
      // File doesn't exist or can't be read, skip
    }
  }
  
  return images;
}

/**
 * Processes text content to extract image references and convert them to ImageContent
 * @param content - The content array to process
 * @param shouldExtractImages - Whether to extract image references from text (default: true)
 *                           Set to false for tool results to avoid context explosion
 */
async function processTextContent(
  content: Array<{ type: 'text'; text: string } | ImageContent>,
  shouldExtractImages: boolean = true,
): Promise<Array<{ type: 'text'; text: string } | ImageContent>> {
  const result: Array<{ type: 'text'; text: string } | ImageContent> = [];

  for (const part of content) {
    if (isImageContentPart(part)) {
      result.push(part);
    } else if (part.type === 'text' && part.text) {
      // Only extract image references if explicitly allowed
      // This prevents context explosion from tool results like 'ls' showing many images
      const images = shouldExtractImages
        ? await extractImageReferencesFromText(part.text)
        : [];

      if (images.length > 0) {
        result.push(part);
        result.push(...images);
      } else {
        result.push(part);
      }
    } else {
      result.push(part);
    }
  }

  return result;
}

async function normalizeImageArray(
  content: Array<{ type: 'text'; text: string } | ImageContent>,
  shouldExtractImages: boolean = true,
): Promise<Array<{ type: 'text'; text: string } | ImageContent>> {
  // First process text content for image references
  const processedContent = await processTextContent(content, shouldExtractImages);
  
  let changed = processedContent !== content;
  const normalizedContent = await Promise.all(
    processedContent.map(async (part) => {
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

function hasMessageContent(message: AgentMessage): message is AgentMessage & { content: unknown } {
  return 'content' in message;
}

async function normalizePiMessage(message: AgentMessage): Promise<Message | null> {
  if (message.role === 'compact-break') return null;
  if (message.role === 'composio_auth_required') return null;
  if (!hasMessageContent(message)) {
    return null;
  }
  if (!Array.isArray(message.content)) {
    return message as Message;
  }

  if (message.role === 'user') {
    // For user messages, extract image references from text
    // This allows users to reference images with @path/to/image.jpg
    const normalizedContent = await normalizeImageArray(message.content, true);
    return normalizedContent === message.content
      ? (message as UserMessage)
      : {
          ...message,
          content: normalizedContent,
        };
  }

  if (message.role === 'toolResult') {
    // For tool results, DON'T extract image references from text
    // This prevents context explosion when tools like 'ls' list many image files
    // Images should only be included when explicitly returned by the tool (e.g., read tool)
    const normalizedContent = await normalizeImageArray(message.content, false);
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
  const contextMessages = messages.map((message) => projectAgentMessageForLoadedContext(message, 'context'));
  const normalized = await Promise.all(contextMessages.map((message) => normalizePiMessage(message)));
  return normalized.filter((message): message is Message => message !== null);
}

/**
 * Filters out image content from messages for non-vision models.
 * Converts image content to text descriptions.
 */
export function filterImagesForNonVisionModel(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === 'compact-break') return message;
    if (message.role === 'composio_auth_required') return message;
    if (!hasMessageContent(message) || !Array.isArray(message.content)) {
      return message;
    }

    // Count images before filtering
    const imageCount = message.content.filter((part) => isImageContentPart(part)).length;
    
    // Filter out image content
    const filteredContent = message.content.filter((part) => {
      if (isImageContentPart(part)) {
        console.log('[Message Normalization] Filtering out image content for non-vision model');
        return false;
      }
      return true;
    });

    // If we removed images and there's a text part, add a note to it
    if (imageCount > 0) {
      const textPartIndex = filteredContent.findIndex((p) => isRecord(p) && p.type === 'text');
      
      if (textPartIndex >= 0) {
        const textPart = filteredContent[textPartIndex];
        if (isRecord(textPart) && typeof textPart.text === 'string') {
          (filteredContent[textPartIndex] as { type: 'text'; text: string }).text += 
            `\n\n[Note: ${imageCount} image(s) were attached but removed because the current model does not support vision capabilities.]`;
        }
      } else {
        // No text part exists, add one with the note
        (filteredContent as Array<{ type: 'text'; text: string }>).push({
          type: 'text',
          text: `[Note: ${imageCount} image(s) were attached but removed because the current model does not support vision capabilities.]`,
        });
      }
    }

    return {
      ...message,
      content: filteredContent,
    } as AgentMessage;
  });
}
