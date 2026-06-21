import 'server-only';

import path from 'path';
import { getImageConversionErrorMessage } from '@/app/lib/images/convert';
import { fetchRemoteImageBuffer } from '@/app/lib/images/remote-image-fetch';
import { normalizeUploadImageBuffer, type UploadConvertParams } from '@/app/lib/images/upload-conversion';
import {
  createDirectory,
  getFileStats,
  writeFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import { invalidateFileReferenceCache } from '@/app/lib/filesystem/file-reference-cache';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { syncPublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import {
  markdownImageSrcForWorkspacePath,
  normalizeWorkspaceMarkdownPath,
} from '@/app/lib/markdown/markdown-image-path';

export const MARKDOWN_IMAGE_MAX_FILES = 12;
export const MARKDOWN_IMAGE_MAX_FILE_SIZE = 30 * 1024 * 1024;
export const MARKDOWN_IMAGE_MAX_TOTAL_SIZE = 80 * 1024 * 1024;

export type MarkdownImageImportInput = {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
  sourceName: string;
  convertParams?: UploadConvertParams | null;
};

export type ImportedMarkdownImage = {
  name: string;
  path: string;
  markdownSrc: string;
  mimeType: string;
  size: number;
};

const MIME_EXTENSION: Record<string, string> = {
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

function isEnoent(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isImageMimeType(mimeType: string) {
  return mimeType.toLowerCase().startsWith('image/');
}

function sanitizeImageFileName(value: string, mimeType?: string): string {
  const fallbackExtension = mimeType ? MIME_EXTENSION[mimeType.toLowerCase()] : undefined;
  const rawName = path.posix.basename(value.replace(/\\/g, '/').split('?')[0].split('#')[0]) || 'image';
  const ext = path.posix.extname(rawName);
  const base = (ext ? rawName.slice(0, -ext.length) : rawName)
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 80);
  const cleanBase = base || 'image';
  const cleanExt = ext
    ? ext.toLowerCase().replace(/[^.\w-]+/g, '')
    : fallbackExtension ? `.${fallbackExtension}` : '';

  return `${cleanBase}${cleanExt}`;
}

async function allocateImagePath(
  targetDir: string,
  filename: string,
  fileOptions?: WorkspaceFileOperationOptions
) {
  const ext = path.posix.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = filename;
  let index = 1;

  while (true) {
    const candidatePath = targetDir === '.' ? candidate : path.posix.join(targetDir, candidate);

    try {
      await getFileStats(candidatePath, fileOptions);
      candidate = ext ? `${base}-${index}${ext}` : `${base}-${index}`;
      index += 1;
    } catch (error) {
      if (isEnoent(error)) return { filename: candidate, workspacePath: candidatePath };
      throw error;
    }
  }
}

function getRemoteFileName(url: URL, contentType: string | null) {
  const pathnameName = path.posix.basename(url.pathname || '');
  if (pathnameName && pathnameName !== '/' && pathnameName !== '.') {
    return sanitizeImageFileName(pathnameName, contentType || undefined);
  }

  return sanitizeImageFileName(`${url.hostname}-image`, contentType || undefined);
}

export async function fetchMarkdownImageUrl(rawUrl: string): Promise<MarkdownImageImportInput> {
  const remoteImage = await fetchRemoteImageBuffer(rawUrl, {
    maxBytes: MARKDOWN_IMAGE_MAX_FILE_SIZE,
  });

  return {
    buffer: remoteImage.buffer,
    filename: getRemoteFileName(remoteImage.finalUrl, remoteImage.mimeType),
    mimeType: remoteImage.mimeType,
    sourceName: rawUrl,
  };
}

export async function importMarkdownImages(params: {
  fileOptions?: WorkspaceFileOperationOptions;
  images: MarkdownImageImportInput[];
  markdownFilePath?: string | null;
  targetDir?: string | null;
}): Promise<ImportedMarkdownImage[]> {
  if (params.images.length === 0) {
    throw new Error('No images were provided.');
  }

  if (params.images.length > MARKDOWN_IMAGE_MAX_FILES) {
    throw new Error(`Maximum ${MARKDOWN_IMAGE_MAX_FILES} images can be imported at once.`);
  }

  const totalSize = params.images.reduce((sum, image) => sum + image.buffer.length, 0);
  if (totalSize > MARKDOWN_IMAGE_MAX_TOTAL_SIZE) {
    throw new Error('Imported images exceed the total size limit.');
  }

  for (const image of params.images) {
    if (image.buffer.length > MARKDOWN_IMAGE_MAX_FILE_SIZE) {
      throw new Error(`Image "${image.sourceName}" exceeds the size limit.`);
    }
  }

  const targetDir = normalizeWorkspaceMarkdownPath(params.targetDir || '.') || '.';
  if (targetDir !== '.') {
    await createDirectory(targetDir, params.fileOptions);
  }

  const imported: ImportedMarkdownImage[] = [];
  const writtenPaths: string[] = [];

  for (const image of params.images) {
    let normalized;
    try {
      normalized = await normalizeUploadImageBuffer({
        buffer: image.buffer,
        filename: sanitizeImageFileName(image.filename, image.mimeType),
        mimeType: image.mimeType || 'application/octet-stream',
        convertParams: image.convertParams,
      });
    } catch (error) {
      throw new Error(getImageConversionErrorMessage(image.sourceName, error));
    }

    if (!isImageMimeType(normalized.mimeType)) {
      throw new Error(`"${image.sourceName}" is not a supported image.`);
    }

    const allocated = await allocateImagePath(
      targetDir,
      sanitizeImageFileName(normalized.filename, normalized.mimeType),
      params.fileOptions
    );
    await writeFile(allocated.workspacePath, normalized.buffer, params.fileOptions);
    writtenPaths.push(allocated.workspacePath);

    imported.push({
      name: allocated.filename,
      path: allocated.workspacePath,
      markdownSrc: markdownImageSrcForWorkspacePath(allocated.workspacePath, params.markdownFilePath),
      mimeType: normalized.mimeType,
      size: normalized.size,
    });
  }

  await syncPublicSharesAfterWrite(writtenPaths, params.fileOptions?.workspace);
  clearFileTreeCache(params.fileOptions?.workspace?.workspaceId);
  invalidateFileReferenceCache(params.fileOptions);

  return imported;
}
