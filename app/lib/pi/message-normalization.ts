import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ImageContent, Message, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { findFilePath } from '../filesystem/upload-handler';
import { projectAgentMessageForLoadedContext } from './message-projection';
import { convertImage } from '../images/convert';
import { isRuntimeContinuationMessage } from './custom-messages';
import { isPathInside } from '../security/safe-paths';
import { MAX_LLM_IMAGE_BYTES, MAX_LLM_TOTAL_IMAGE_BYTES } from './llm-payload-limits';

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
const SOURCE_IMAGE_BYTE_LIMIT = 50 * 1024 * 1024;
const LLM_IMAGE_COMPRESSION_PROFILES = [
  { maxDimension: 1600, quality: 80 },
  { maxDimension: 1280, quality: 70 },
  { maxDimension: 1024, quality: 60 },
] as const;

/**
 * Filesystem paths in model image parts are a privileged server-side capability.
 * Callers must provide the exact trusted roots that may be read for the session.
 * Upload URLs remain supported because they are resolved through the upload store.
 */
export type PiMessageNormalizationOptions = {
  allowedImageFileRoots?: readonly string[];
  workspaceImageRoot?: string | null;
  uploadOwnerUserId?: string;
  uploadWorkspaceId?: string | null;
};

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

function decodeUrlSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveApiUploadFileId(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value, 'http://canvas.local');
  } catch {
    return null;
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'files') {
    return null;
  }

  const rawFileId = parts[2];
  if (!rawFileId || rawFileId === 'preview') {
    return null;
  }

  if (parts.length > 3 && parts[3] !== 'preview') {
    return null;
  }

  return decodeUrlSegment(rawFileId);
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

export async function compactImageBufferForLlm(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<ImageContent> {
  if (buffer.length > SOURCE_IMAGE_BYTE_LIMIT) {
    throw new Error(
      `Image attachment is too large for chat context (${Math.ceil(buffer.length / (1024 * 1024))}MB). Maximum source image size is ${SOURCE_IMAGE_BYTE_LIMIT / (1024 * 1024)}MB.`,
    );
  }

  if (buffer.length <= MAX_LLM_IMAGE_BYTES) {
    return {
      type: 'image',
      data: buffer.toString('base64'),
      mimeType,
    };
  }

  try {
    let smallestResult: Awaited<ReturnType<typeof convertImage>> | null = null;
    for (const profile of LLM_IMAGE_COMPRESSION_PROFILES) {
      const converted = await convertImage(buffer, originalName, {
        format: 'webp',
        quality: profile.quality,
        maxDimension: profile.maxDimension,
        sourceMimeType: mimeType,
      });
      if (!smallestResult || converted.buffer.length < smallestResult.buffer.length) {
        smallestResult = converted;
      }
      if (converted.buffer.length <= MAX_LLM_IMAGE_BYTES) {
        return {
          type: 'image',
          data: converted.buffer.toString('base64'),
          mimeType: converted.mimeType,
        };
      }
    }

    throw new Error(
      `Image attachment could not be compacted below the ${Math.ceil(MAX_LLM_IMAGE_BYTES / 1024)}KB LLM transfer limit` +
      `${smallestResult ? ` (smallest result: ${Math.ceil(smallestResult.buffer.length / 1024)}KB)` : ''}.`,
    );
  } catch (error) {
    console.warn('[Message Normalization] Failed to compact large image attachment:', error instanceof Error ? error.message : error);
    throw new Error(
      `Image attachment is too large for the LLM request and could not be compacted below ${Math.ceil(MAX_LLM_IMAGE_BYTES / 1024)}KB (${Math.ceil(buffer.length / (1024 * 1024))}MB source).`,
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

  if (estimatedBytes <= MAX_LLM_IMAGE_BYTES) {
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

async function assertAllowedImageFilePath(filePath: string, allowedRoots: readonly string[]): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const candidateRoots = allowedRoots
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map((root) => path.resolve(root));

  if (!candidateRoots.some((root) => isPathInside(root, resolvedPath))) {
    throw new Error('Image attachment path is outside the trusted workspace or runtime directories.');
  }

  const realPath = await fs.realpath(resolvedPath);
  const realRoots = await Promise.all(candidateRoots.map(async (root) => {
    try {
      return await fs.realpath(root);
    } catch {
      return root;
    }
  }));

  if (!realRoots.some((root) => isPathInside(root, realPath))) {
    throw new Error('Image attachment path resolves outside the trusted workspace or runtime directories.');
  }
}

async function loadImageDataFromFile(
  filePath: string,
  mimeType: string,
  allowedRoots: readonly string[],
): Promise<ImageContent> {
  await assertAllowedImageFilePath(filePath, allowedRoots);
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

async function normalizeImagePart(
  part: ImageContent,
  options: PiMessageNormalizationOptions,
): Promise<ImageContent> {
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
    return loadImageDataFromFile(fileURLToPath(trimmed), part.mimeType, options.allowedImageFileRoots ?? []);
  }

  const apiUploadFileId = resolveApiUploadFileId(trimmed);
  if (apiUploadFileId) {
    try {
      const {
        getUploadAccessGrant,
        isUploadAccessAllowed,
      } = await import('../files/upload-access-store');
      const grant = await getUploadAccessGrant(apiUploadFileId);
      if (
        !grant
        || !options.uploadOwnerUserId
        || !isUploadAccessAllowed(grant, {
          userId: options.uploadOwnerUserId,
          workspaceId: options.uploadWorkspaceId,
        })
      ) {
        throw new Error('Upload attachment is not available to this user.');
      }
      const filePath = await findFilePath(apiUploadFileId);
      if (filePath) {
        // Upload IDs are resolved by the server-side upload store. Do not accept
        // client-provided paths here; constrain the resolved file to its category.
        return loadImageDataFromFile(filePath, part.mimeType, [path.dirname(filePath)]);
      }
    } catch (error) {
      console.warn(`[Message Normalization] Failed to resolve API file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new Error('Upload attachment is not available to this user.');
    }
    throw new Error('Upload attachment is not available to this user.');
  }

  if (isValidBase64(trimmed)) {
    return normalizeBase64ImageData(trimmed, part.mimeType, 'base64-attachment');
  }

  const MAX_PATH_LENGTH = 4096;
  if (path.isAbsolute(trimmed) && trimmed.length < MAX_PATH_LENGTH) {
    return loadImageDataFromFile(trimmed, part.mimeType, options.allowedImageFileRoots ?? []);
  }

  throw new Error(
    'Invalid image attachment payload. Expected base64 image data, a base64 data URL, an /api/files upload URL, or an absolute file path.',
  );
}

/**
 * Scans text for image file references and converts them to ImageContent
 */
async function extractImageReferencesFromText(
  text: string,
  options: PiMessageNormalizationOptions,
): Promise<ImageContent[]> {
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
    
    if (path.isAbsolute(filePath) || !options.workspaceImageRoot) {
      continue;
    }

    try {
      const fullPath = path.resolve(options.workspaceImageRoot, filePath);
      await assertAllowedImageFilePath(fullPath, [options.workspaceImageRoot]);
      
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
  options: PiMessageNormalizationOptions = {},
): Promise<Array<{ type: 'text'; text: string } | ImageContent>> {
  const result: Array<{ type: 'text'; text: string } | ImageContent> = [];

  for (const part of content) {
    if (isImageContentPart(part)) {
      result.push(part);
    } else if (part.type === 'text' && part.text) {
      // Only extract image references if explicitly allowed
      // This prevents context explosion from tool results like 'ls' showing many images
      const images = shouldExtractImages
        ? await extractImageReferencesFromText(part.text, options)
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
  options: PiMessageNormalizationOptions = {},
): Promise<Array<{ type: 'text'; text: string } | ImageContent>> {
  // First process text content for image references
  const processedContent = await processTextContent(content, shouldExtractImages, options);
  
  let changed = processedContent !== content;
  const normalizedContent = await Promise.all(
    processedContent.map(async (part) => {
      if (!isImageContentPart(part)) {
        return part;
      }

      const normalizedPart = await normalizeImagePart(part, options);
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

async function normalizePiMessage(
  message: AgentMessage,
  options: PiMessageNormalizationOptions,
): Promise<Message | null> {
  if (message.role === 'compact-break') return null;
  if (message.role === 'composio_auth_required') return null;
  if (isRuntimeContinuationMessage(message)) {
    return {
      role: 'user',
      content: [{ type: 'text', text: message.content }],
      timestamp: message.timestamp,
    };
  }
  if (!hasMessageContent(message)) {
    return null;
  }
  if (!Array.isArray(message.content)) {
    return message as Message;
  }

  if (message.role === 'user') {
    // For user messages, extract image references from text
    // This allows users to reference images with @path/to/image.jpg
    const normalizedContent = await normalizeImageArray(message.content, true, options);
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
    const normalizedContent = await normalizeImageArray(message.content, false, options);
    return normalizedContent === message.content
      ? (message as ToolResultMessage)
      : {
          ...message,
          content: normalizedContent,
        };
  }

  return message as Message;
}

export async function normalizePiMessagesForLlm(
  messages: AgentMessage[],
  options: PiMessageNormalizationOptions = {},
): Promise<Message[]> {
  const contextMessages = messages.map((message) => projectAgentMessageForLoadedContext(message, 'context'));
  const normalized = await Promise.all(contextMessages.map((message) => normalizePiMessage(message, options)));
  return enforceImagePayloadBudget(normalized.filter((message): message is Message => message !== null));
}

function enforceImagePayloadBudget(messages: Message[]): Message[] {
  let includedImageBytes = 0;

  return [...messages].reverse().map((message) => {
    if (message.role === 'assistant' || !Array.isArray(message.content)) {
      return message;
    }

    let omittedImageCount = 0;
    const content = message.content.filter((part) => {
      if (!isImageContentPart(part)) return true;
      const imageBytes = estimateBase64Bytes(part.data);
      if (includedImageBytes + imageBytes <= MAX_LLM_TOTAL_IMAGE_BYTES) {
        includedImageBytes += imageBytes;
        return true;
      }
      omittedImageCount += 1;
      return false;
    });

    if (omittedImageCount === 0) return message;

    content.push({
      type: 'text',
      text: `[${omittedImageCount} image${omittedImageCount === 1 ? '' : 's'} omitted to keep the LLM request within its transfer limit.]`,
    });
    return { ...message, content };
  }).reverse();
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
