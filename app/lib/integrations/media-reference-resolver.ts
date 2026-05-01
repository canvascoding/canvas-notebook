import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { fetchExternalResourceSafely } from '@/app/lib/security/safe-external-fetch';
import {
  getWorkspaceRoot,
  resolveValidatedStudioAssetPath,
  resolveValidatedStudioOutputPath,
  resolveValidatedUserUploadStudioRefPath,
  resolveValidatedWorkspaceFilePath,
  resolveValidatedWorkspaceRelativePath,
} from '@/app/lib/integrations/studio-paths';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 30_000;

const IMAGE_MIME: Record<string, string> = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const VIDEO_MIME: Record<string, string> = {
  mov: 'video/quicktime',
  mp4: 'video/mp4',
};

export type MediaReferenceKind =
  | 'studio_reference'
  | 'studio_output'
  | 'studio_asset'
  | 'user_upload'
  | 'workspace_relative'
  | 'workspace_absolute'
  | 'external_url';

export type MediaReferenceType = 'image' | 'video';

export interface ResolvedMediaReference {
  kind: MediaReferenceKind;
  absolutePath: string | null;
  relativePath: string;
  sourceId: string;
  fileName: string;
  mimeType: string;
  mediaType: MediaReferenceType;
}

export interface LoadedMediaFile {
  bytes: Buffer;
  imageBytes: string;
  videoBytes: string;
  mimeType: string;
  fileName: string;
  sourceKind: MediaReferenceKind;
  sourceId: string;
  width: number | null;
  height: number | null;
  fileSize: number;
}

export interface LoadMediaReferenceOptions {
  userId?: string;
  maxBytes?: number;
  timeoutMs?: number;
  allowedTypes?: MediaReferenceType[];
}

function extensionFromPath(filePath: string): string {
  const cleanPath = filePath.split(/[?#]/, 1)[0] || filePath;
  const ext = path.posix.extname(cleanPath).replace(/^\./, '').toLowerCase();
  return ext;
}

function mimeFromPath(filePath: string): { mimeType: string; mediaType: MediaReferenceType } {
  const ext = extensionFromPath(filePath);
  const imageMime = IMAGE_MIME[ext];
  if (imageMime) {
    return { mimeType: imageMime, mediaType: 'image' };
  }

  const videoMime = VIDEO_MIME[ext];
  if (videoMime) {
    return { mimeType: videoMime, mediaType: 'video' };
  }

  return { mimeType: 'application/octet-stream', mediaType: 'image' };
}

function fileNameFromPath(filePath: string, fallback: string): string {
  return path.posix.basename(filePath.split(/[?#]/, 1)[0] || '') || fallback;
}

function decodePath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function getLocalReferencePath(rawValue: string): { pathOnly: string; isRemoteUrl: boolean } | null {
  try {
    const parsed = new URL(rawValue);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return { pathOnly: parsed.pathname, isRemoteUrl: true };
  } catch {
    const pathOnly = rawValue.split(/[?#]/, 1)[0]?.trim();
    return pathOnly ? { pathOnly, isRemoteUrl: false } : null;
  }
}

function resolveWithinRoot(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, relativePath);
  if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    return resolvedTarget;
  }
  return null;
}

function isSafeRelativePath(relativePath: string): boolean {
  const normalizedPath = path.posix.normalize(relativePath).replace(/^\.?\//, '');
  return Boolean(
    normalizedPath &&
      normalizedPath !== '.' &&
      !normalizedPath.startsWith('/') &&
      !normalizedPath.startsWith('../') &&
      !normalizedPath.includes('/../'),
  );
}

function makeResolvedReference(
  kind: MediaReferenceKind,
  input: string,
  relativePath: string,
  absolutePath: string | null,
): ResolvedMediaReference | null {
  const normalizedRelativePath = relativePath.replace(/^\/+/, '');
  if (kind !== 'external_url' && !isSafeRelativePath(normalizedRelativePath)) {
    return null;
  }

  const { mimeType, mediaType } = mimeFromPath(normalizedRelativePath || input);
  return {
    kind,
    absolutePath,
    relativePath: normalizedRelativePath,
    sourceId: input,
    fileName: fileNameFromPath(normalizedRelativePath || input, mediaType === 'video' ? 'reference.mp4' : 'reference.png'),
    mimeType,
    mediaType,
  };
}

function classifyStudioMediaPath(input: string, studioMediaPath: string): ResolvedMediaReference | null {
  if (studioMediaPath.startsWith('studio/outputs/')) {
    const relativePath = studioMediaPath.slice('studio/outputs/'.length);
    return makeResolvedReference('studio_output', input, relativePath, resolveValidatedStudioOutputPath(relativePath));
  }

  if (studioMediaPath.startsWith('studio/assets/')) {
    const relativePath = studioMediaPath.slice('studio/assets/'.length);
    return makeResolvedReference('studio_asset', input, relativePath, resolveValidatedStudioAssetPath(relativePath));
  }

  if (studioMediaPath.startsWith('user-uploads/studio-references/')) {
    const relativePath = studioMediaPath.slice('user-uploads/studio-references/'.length);
    return makeResolvedReference('user_upload', input, relativePath, resolveValidatedUserUploadStudioRefPath(relativePath));
  }

  if (
    studioMediaPath.startsWith('products/') ||
    studioMediaPath.startsWith('personas/') ||
    studioMediaPath.startsWith('styles/') ||
    studioMediaPath.startsWith('presets/') ||
    studioMediaPath.startsWith('references/')
  ) {
    return makeResolvedReference('studio_asset', input, studioMediaPath, resolveValidatedStudioAssetPath(studioMediaPath));
  }

  if (studioMediaPath.startsWith('studio-gen-')) {
    return makeResolvedReference('studio_output', input, studioMediaPath, resolveValidatedStudioOutputPath(studioMediaPath));
  }

  return null;
}

export function classifyMediaReference(input: string, options: Pick<LoadMediaReferenceOptions, 'userId'> = {}): ResolvedMediaReference | null {
  const rawValue = input.trim();
  if (!rawValue) {
    return null;
  }

  const localPath = getLocalReferencePath(rawValue);
  if (!localPath) {
    return null;
  }

  const { pathOnly, isRemoteUrl } = localPath;
  if (pathOnly.startsWith('/api/studio/references/')) {
    const referenceId = decodePath(pathOnly.slice('/api/studio/references/'.length));
    if (!referenceId || referenceId.includes('/') || referenceId.includes('\\') || referenceId.includes('..')) {
      return null;
    }

    const relativePath = options.userId ? `references/${options.userId}/${referenceId}` : referenceId;
    const absolutePath = options.userId ? resolveValidatedStudioAssetPath(relativePath) : null;
    return makeResolvedReference('studio_reference', rawValue, relativePath, absolutePath);
  }

  const studioMediaPath = pathOnly.startsWith('/api/studio/media/')
    ? decodePath(pathOnly.slice('/api/studio/media/'.length))
    : decodePath(pathOnly.replace(/^\/+/, ''));
  const studioReference = classifyStudioMediaPath(rawValue, studioMediaPath);
  if (studioReference) {
    return studioReference;
  }

  if (pathOnly.startsWith('/api/media/')) {
    const relativePath = decodePath(pathOnly.slice('/api/media/'.length));
    return makeResolvedReference('workspace_relative', rawValue, relativePath, resolveValidatedWorkspaceRelativePath(relativePath));
  }

  const workspaceRoot = getWorkspaceRoot();
  if (pathOnly.startsWith(`${workspaceRoot}/`) || pathOnly.startsWith(`${workspaceRoot}${path.sep}`)) {
    const absolutePath = resolveValidatedWorkspaceFilePath(pathOnly);
    const relativePath = absolutePath ? path.relative(workspaceRoot, absolutePath).split(path.sep).join('/') : fileNameFromPath(pathOnly, '');
    return makeResolvedReference('workspace_absolute', rawValue, relativePath, absolutePath);
  }

  if (isRemoteUrl) {
    return makeResolvedReference('external_url', rawValue, rawValue, null);
  }

  return makeResolvedReference('workspace_relative', rawValue, decodePath(pathOnly.replace(/^\.?\//, '')), resolveValidatedWorkspaceRelativePath(decodePath(pathOnly.replace(/^\.?\//, ''))));
}

function assertAllowedType(ref: ResolvedMediaReference, allowedTypes: MediaReferenceType[] | undefined): void {
  if (!allowedTypes || allowedTypes.length === 0) {
    return;
  }

  if (ref.kind !== 'external_url' && ref.mimeType === 'application/octet-stream') {
    throw new Error(`Unsupported media reference format: ${ref.sourceId}`);
  }

  if (!allowedTypes.includes(ref.mediaType)) {
    throw new Error(`Unsupported ${ref.mediaType} reference: ${ref.sourceId}`);
  }
}

async function readFilesystemReference(ref: ResolvedMediaReference, maxBytes: number): Promise<{ buffer: Buffer; absolutePath: string }> {
  const candidates = [ref.absolutePath].filter(Boolean) as string[];
  if (ref.kind === 'workspace_relative' || ref.kind === 'workspace_absolute' || ref.kind === 'studio_asset' || ref.kind === 'studio_output') {
    const dataFallback = resolveWithinRoot(resolveCanvasDataRoot(), ref.relativePath);
    if (dataFallback && !candidates.includes(dataFallback)) {
      candidates.push(dataFallback);
    }
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isFile()) {
        throw new Error(`Not a file: ${ref.sourceId}`);
      }
      if (stats.size <= 0) {
        throw new Error(`Reference file is empty: ${ref.sourceId}`);
      }
      if (stats.size > maxBytes) {
        throw new Error(`Reference file is too large (max ${Math.floor(maxBytes / (1024 * 1024))}MB): ${ref.sourceId}`);
      }
      return { buffer: await fs.readFile(candidate), absolutePath: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`Reference file not found: ${ref.sourceId}`);
}

async function fetchExternalReference(ref: ResolvedMediaReference, maxBytes: number, timeoutMs: number): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetchExternalResourceSafely(ref.sourceId, { maxBytes, timeoutMs });
  return {
    buffer: response.buffer,
    mimeType: response.contentType.split(';', 1)[0]?.trim() || 'application/octet-stream',
  };
}

export async function loadMediaReference(input: string, options: LoadMediaReferenceOptions = {}): Promise<LoadedMediaFile> {
  const ref = classifyMediaReference(input, options);
  if (!ref) {
    throw new Error(`Unsupported media reference path: ${input}`);
  }

  assertAllowedType(ref, options.allowedTypes);

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const loaded = ref.kind === 'external_url'
    ? await fetchExternalReference(ref, maxBytes, options.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS)
    : { buffer: (await readFilesystemReference(ref, maxBytes)).buffer, mimeType: ref.mimeType };
  const buffer = loaded.buffer;
  const mimeType = loaded.mimeType === 'application/octet-stream' ? ref.mimeType : loaded.mimeType;
  if (options.allowedTypes?.length) {
    const matchesAllowedType = (options.allowedTypes.includes('image') && mimeType.startsWith('image/')) ||
      (options.allowedTypes.includes('video') && mimeType.startsWith('video/'));
    if (!matchesAllowedType) {
      throw new Error(`Unsupported media reference format: ${ref.sourceId}`);
    }
  }

  if (buffer.length <= 0) {
    throw new Error(`Reference file is empty: ${ref.sourceId}`);
  }
  if (buffer.length > maxBytes) {
    throw new Error(`Reference file is too large (max ${Math.floor(maxBytes / (1024 * 1024))}MB): ${ref.sourceId}`);
  }

  return {
    bytes: buffer,
    imageBytes: buffer.toString('base64'),
    videoBytes: buffer.toString('base64'),
    mimeType: mimeType === 'application/octet-stream' ? (ref.mediaType === 'video' ? 'video/mp4' : 'image/png') : mimeType,
    fileName: ref.fileName,
    sourceKind: ref.kind,
    sourceId: ref.sourceId,
    width: null,
    height: null,
    fileSize: buffer.length,
  };
}

export async function loadMediaReferences(inputs: string[], options: LoadMediaReferenceOptions = {}): Promise<LoadedMediaFile[]> {
  const files: LoadedMediaFile[] = [];

  for (const input of inputs) {
    const rawValue = input.trim();
    if (!rawValue) {
      continue;
    }

    try {
      files.push(await loadMediaReference(rawValue, options));
    } catch (error) {
      console.warn(`[Media Reference Resolver] Failed to load reference "${rawValue.slice(0, 100)}":`, error);
    }
  }

  return files;
}
