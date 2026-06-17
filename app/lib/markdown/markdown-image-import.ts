import 'server-only';

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'path';
import { getImageConversionErrorMessage } from '@/app/lib/images/convert';
import { normalizeUploadImageBuffer, type UploadConvertParams } from '@/app/lib/images/upload-conversion';
import { createDirectory, getFileStats, writeFile } from '@/app/lib/filesystem/workspace-files';
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

const MAX_REMOTE_IMAGE_REDIRECTS = 5;

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

function normalizeRemoteHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isPrivateIPv4Address(hostname: string) {
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224
  );
}

function isPrivateIPv6Address(hostname: string) {
  const normalized = normalizeRemoteHostname(hostname);
  const mappedIPv4 = normalized.match(/(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (mappedIPv4) return isPrivateIPv4Address(mappedIPv4);

  if (normalized === '::' || normalized === '::1') return true;

  const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if (!Number.isFinite(firstHextet)) return true;

  return (
    (firstHextet & 0xfe00) === 0xfc00
    || (firstHextet & 0xffc0) === 0xfe80
    || (firstHextet & 0xff00) === 0xff00
    || normalized.startsWith('2001:db8:')
  );
}

function isPrivateIpAddress(hostname: string) {
  const normalized = normalizeRemoteHostname(hostname);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateIPv4Address(normalized);
  if (ipVersion === 6) return isPrivateIPv6Address(normalized);
  return false;
}

async function assertRemoteImageUrlAllowed(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS image URLs can be imported.');
  }

  const hostname = normalizeRemoteHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Image URL host is not allowed.');
  }

  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) throw new Error('Image URL host is not allowed.');
    return;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Image URL host could not be resolved.');
  }

  if (addresses.length === 0 || addresses.some((entry) => isPrivateIpAddress(entry.address))) {
    throw new Error('Image URL host is not allowed.');
  }
}

async function readResponseBufferWithLimit(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = Buffer.from(value);
    totalSize += chunk.length;
    if (totalSize > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Image URL is too large.');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, totalSize);
}

async function fetchAllowedRemoteImage(url: URL, signal: AbortSignal) {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_IMAGE_REDIRECTS; redirectCount += 1) {
    await assertRemoteImageUrlAllowed(currentUrl);

    const response = await fetch(currentUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      redirect: 'manual',
      signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Image URL redirect did not include a location.');
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    return response;
  }

  throw new Error('Image URL redirected too many times.');
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

async function allocateImagePath(targetDir: string, filename: string) {
  const ext = path.posix.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = filename;
  let index = 1;

  while (true) {
    const candidatePath = targetDir === '.' ? candidate : path.posix.join(targetDir, candidate);

    try {
      await getFileStats(candidatePath);
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
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid image URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS image URLs can be imported.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetchAllowedRemoteImage(url, controller.signal);

    if (!response.ok) {
      throw new Error(`Image URL responded with ${response.status}.`);
    }

    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > MARKDOWN_IMAGE_MAX_FILE_SIZE) {
      throw new Error('Image URL is too large.');
    }

    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
    const buffer = await readResponseBufferWithLimit(response, MARKDOWN_IMAGE_MAX_FILE_SIZE);

    return {
      buffer,
      filename: getRemoteFileName(url, mimeType),
      mimeType,
      sourceName: rawUrl,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Image URL request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function importMarkdownImages(params: {
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
    await createDirectory(targetDir);
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

    const allocated = await allocateImagePath(targetDir, sanitizeImageFileName(normalized.filename, normalized.mimeType));
    await writeFile(allocated.workspacePath, normalized.buffer);
    writtenPaths.push(allocated.workspacePath);

    imported.push({
      name: allocated.filename,
      path: allocated.workspacePath,
      markdownSrc: markdownImageSrcForWorkspacePath(allocated.workspacePath, params.markdownFilePath),
      mimeType: normalized.mimeType,
      size: normalized.size,
    });
  }

  await syncPublicSharesAfterWrite(writtenPaths);
  clearFileTreeCache();
  invalidateFileReferenceCache();

  return imported;
}
