import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ImageContent, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai';
import { getWorkspacePath } from '../utils/workspace-manager';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Regex to detect image file references in text
// Supports both quoted: "path/to/file.jpg" and unquoted: path/to/file.jpg
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
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

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

function isValidBase64(value: string): boolean {
  const normalized = stripWhitespace(value);
  if (normalized.length === 0 || normalized.length % 4 !== 0) {
    return false;
  }
  
  // For very large strings, only sample the beginning, middle and end
  // to avoid stack overflow with complex regex
  const MAX_SAMPLE_SIZE = 10000; // Sample 10KB chunks
  if (normalized.length > MAX_SAMPLE_SIZE * 3) {
    const start = normalized.slice(0, MAX_SAMPLE_SIZE);
    const middle = normalized.slice(Math.floor(normalized.length / 2) - MAX_SAMPLE_SIZE / 2, Math.floor(normalized.length / 2) + MAX_SAMPLE_SIZE / 2);
    const end = normalized.slice(-MAX_SAMPLE_SIZE);
    
    return BASE64_PATTERN.test(start) && 
           BASE64_PATTERN.test(middle) && 
           BASE64_PATTERN.test(end);
  }
  
  return BASE64_PATTERN.test(normalized);
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
  
  // Log for debugging
  console.log(`[Message Normalization] Normalizing image part. Data length: ${rawData.length}, starts with: ${rawData.substring(0, 50)}...`);
  
  const dataUrlMatch = rawData.match(DATA_URL_PATTERN);
  if (dataUrlMatch) {
    console.log('[Message Normalization] Detected data URL format');
    return {
      type: 'image',
      data: stripWhitespace(dataUrlMatch[2]),
      mimeType: part.mimeType || dataUrlMatch[1],
    };
  }

  if (rawData.startsWith('file://')) {
    console.log('[Message Normalization] Detected file:// URL');
    return loadImageDataFromFile(fileURLToPath(rawData), part.mimeType);
  }

  // Check if it's base64 first (before treating as file path)
  if (isValidBase64(rawData)) {
    console.log('[Message Normalization] Detected base64 data');
    return {
      type: 'image',
      data: stripWhitespace(rawData),
      mimeType: part.mimeType,
    };
  }

  // Only treat as file path if it's reasonable length and looks like a path
  // Mac OS has a max path length of 1024, but base64 data can be much longer
  const MAX_PATH_LENGTH = 4096;
  if (path.isAbsolute(rawData) && rawData.length < MAX_PATH_LENGTH) {
    console.log(`[Message Normalization] Attempting to load from path: ${rawData}`);
    try {
      return loadImageDataFromFile(rawData, part.mimeType);
    } catch (error) {
      // If file reading fails, it's probably not a file path
      console.warn(`[Message Normalization] Failed to load image from path: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // If we get here, the data format is unrecognized
  console.error(`[Message Normalization] Unrecognized image data format. Length: ${rawData.length}, preview: ${rawData.substring(0, 100)}`);

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

async function normalizePiMessage(message: AgentMessage): Promise<Message> {
  if (message.role === 'compact-break') return message as unknown as Message;
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
  return Promise.all(messages.map((message) => normalizePiMessage(message)));
}

/**
 * Filters out image content from messages for non-vision models.
 * Converts image content to text descriptions.
 */
export function filterImagesForNonVisionModel(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === 'compact-break') return message;
    if (!Array.isArray(message.content)) {
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
