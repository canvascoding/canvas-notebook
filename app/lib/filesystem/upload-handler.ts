import { promises as fs } from 'fs';
import path from 'path';
import { fileTypeFromBuffer } from 'file-type';
import { randomUUID } from 'crypto';

// Upload configuration
const DATA = process.env.DATA || path.join(process.cwd(), 'data');
const UPLOAD_BASE_DIR = path.join(DATA, 'user-uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// File categories based on MIME type
const CATEGORY_MAP: Record<string, string> = {
  // Images
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/svg+xml': 'image',
  'image/bmp': 'image',
  'image/tiff': 'image',
  'image/avif': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'image/heic-sequence': 'image',
  
  // Documents
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.oasis.opendocument.text': 'document',
  'text/plain': 'document',
  'text/markdown': 'document',
  'text/csv': 'document',
  'text/html': 'document',
  'text/xml': 'document',
  'application/json': 'document',
  'application/yaml': 'document',
  'text/yaml': 'document',
  
  // Audio
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/wave': 'audio',
  'audio/ogg': 'audio',
  'audio/flac': 'audio',
  'audio/aac': 'audio',
  'audio/mp4': 'audio',
  'audio/webm': 'audio',
  
  // Video
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/ogg': 'video',
  'video/quicktime': 'video',
  'video/x-msvideo': 'video',
  'video/x-matroska': 'video',
  
  // Archives
  'application/zip': 'archive',
  'application/x-zip-compressed': 'archive',
  'application/gzip': 'archive',
  'application/x-tar': 'archive',
  'application/x-rar-compressed': 'archive',
  'application/x-7z-compressed': 'archive',
};

export interface UploadedFile {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  category: string;
  storagePath: string;
}

/**
 * Sanitize a filename to be safe for filesystem storage
 */
function sanitizeFilename(filename: string): string {
  // Remove path components, keep only filename
  const baseName = path.basename(filename.replace(/\\/g, '/'));
  
  // Replace unsafe characters with underscore
  const sanitized = baseName.replace(/[^a-zA-Z0-9._\-]/g, '_');
  
  // Ensure it's not empty and not too long
  if (!sanitized || sanitized === '_') {
    return 'unnamed';
  }
  
  // Limit length (keep extension)
  const ext = path.extname(sanitized);
  const nameWithoutExt = path.basename(sanitized, ext);
  const maxNameLength = 100;
  
  if (nameWithoutExt.length > maxNameLength) {
    return nameWithoutExt.slice(0, maxNameLength) + ext;
  }
  
  return sanitized;
}

/**
 * Determine file category from MIME type
 */
function getCategoryFromMimeType(mimeType: string): string {
  return CATEGORY_MAP[mimeType] || 'other';
}

/**
 * Resolve content type from file extension as fallback
 */
function resolveContentTypeFromExtension(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  
  const extensionMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'text/xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
  };
  
  return extensionMap[ext] || null;
}

/**
 * Generate a unique file ID and storage path
 */
function generateFileIdAndPath(originalName: string, category: string): { id: string; storagePath: string; fullPath: string } {
  const sanitizedOriginal = sanitizeFilename(originalName);
  const ext = path.extname(sanitizedOriginal);
  const nameWithoutExt = path.basename(sanitizedOriginal, ext);
  const uuid = randomUUID();
  
  // Pattern: {sanitizedOriginal}---{uuid}.{ext}
  const fileId = ext 
    ? `${nameWithoutExt}---${uuid}${ext}`
    : `${nameWithoutExt}---${uuid}`;
  
  const categoryDir = path.join(UPLOAD_BASE_DIR, category);
  const storagePath = path.join(category, fileId);
  // Full path must include the category directory
  const fullPath = path.join(categoryDir, fileId);
  
  return { id: fileId, storagePath, fullPath };
}

/**
 * Validate file ID to prevent path traversal
 */
export function validateFileId(fileId: string): boolean {
  // Check for path traversal attempts
  if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\') || fileId.includes('\0')) {
    return false;
  }
  
  // Check for valid filename pattern
  const validPattern = /^[a-zA-Z0-9._\-]+$/;
  if (!validPattern.test(fileId)) {
    return false;
  }
  
  return true;
}

/**
 * Get the full filesystem path for a file ID
 */
export function getFilePath(fileId: string): string | null {
  if (!validateFileId(fileId)) {
    return null;
  }
  
  // Extract category from filename pattern: name---uuid.ext
  // The category is the parent directory
  const categories = ['image', 'document', 'audio', 'video', 'archive', 'other'];
  
  for (const category of categories) {
    const candidatePath = path.join(UPLOAD_BASE_DIR, category, fileId);
    // Return the path - existence will be checked by the caller
    return candidatePath;
  }
  
  return null;
}

/**
 * Find the actual path for a file ID by checking all categories
 */
export async function findFilePath(fileId: string): Promise<string | null> {
  if (!validateFileId(fileId)) {
    return null;
  }
  
  const categories = ['image', 'document', 'audio', 'video', 'archive', 'other'];
  
  for (const category of categories) {
    const candidatePath = path.join(UPLOAD_BASE_DIR, category, fileId);
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      // File doesn't exist in this category, continue checking
      continue;
    }
  }
  
  return null;
}

/**
 * Save an upload buffer to the filesystem
 * Unified handler for ALL file types - no special handling based on file type
 */
export async function saveUploadBuffer(
  buffer: Buffer,
  originalFilename: string,
  providedMimeType?: string
): Promise<UploadedFile> {
  // Check file size
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
  }
  
  // Detect MIME type from buffer
  const fileType = await fileTypeFromBuffer(buffer);
  const detectedMimeType = fileType?.mime;
  
  // Use provided MIME type as fallback, or detect from extension
  let mimeType = detectedMimeType || providedMimeType || 'application/octet-stream';
  
  // If still no MIME type, try to detect from extension
  if (mimeType === 'application/octet-stream') {
    const extMimeType = resolveContentTypeFromExtension(originalFilename);
    if (extMimeType) {
      mimeType = extMimeType;
    }
  }
  
  // Determine category
  const category = getCategoryFromMimeType(mimeType);
  
  // Generate ID and paths
  const { id, storagePath, fullPath } = generateFileIdAndPath(originalFilename, category);
  
  // Ensure category directory exists
  const categoryDir = path.dirname(fullPath);
  await fs.mkdir(categoryDir, { recursive: true });
  
  // Write file
  await fs.writeFile(fullPath, buffer, { mode: 0o644 });
  
  return {
    id,
    originalName: originalFilename,
    mimeType,
    size: buffer.length,
    category,
    storagePath,
  };
}

/**
 * Get file info by ID
 */
export async function getFileInfo(fileId: string): Promise<UploadedFile | null> {
  const filePath = await findFilePath(fileId);
  if (!filePath) {
    return null;
  }
  
  try {
    const stats = await fs.stat(filePath);
    const category = path.basename(path.dirname(filePath));
    
    return {
      id: fileId,
      originalName: fileId, // Extract original name from ID pattern if needed
      mimeType: 'application/octet-stream', // Could be detected if needed
      size: stats.size,
      category,
      storagePath: path.join(category, fileId),
    };
  } catch {
    return null;
  }
}

/**
 * Delete a file by ID
 */
export async function deleteFile(fileId: string): Promise<boolean> {
  const filePath = await findFilePath(fileId);
  if (!filePath) {
    return false;
  }
  
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file by ID
 */
export async function readFile(fileId: string): Promise<Buffer | null> {
  const filePath = await findFilePath(fileId);
  if (!filePath) {
    return null;
  }
  
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Create a read stream for a file by ID
 */
export async function createReadStream(fileId: string): Promise<{ stream: import('fs').ReadStream; cleanup: () => void } | null> {
  const filePath = await findFilePath(fileId);
  if (!filePath) {
    return null;
  }
  
  const { createReadStream: createLocalReadStream } = await import('fs');
  const stream = createLocalReadStream(filePath);
  
  return {
    stream,
    cleanup: () => {
      stream.destroy();
    },
  };
}
