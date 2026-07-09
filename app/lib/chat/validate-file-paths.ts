import type { FileNode } from '@/app/lib/files/types';
import { findNodeInTree } from '@/app/lib/files/tree-utils';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';

const POSITIVE_VALIDATION_CACHE_TTL_MS = 30_000;
const NEGATIVE_VALIDATION_CACHE_TTL_MS = 10_000;

export type FileReferenceValidationType = 'file' | 'directory' | 'missing';

export type FileReferenceValidationResult = {
  path: string;
  type: FileReferenceValidationType;
  exists: boolean;
};

type ValidationCacheEntry = {
  expiresAt: number;
  promise?: Promise<FileReferenceValidationResult>;
  value?: FileReferenceValidationResult;
};

const validationCache = new Map<string, ValidationCacheEntry>();

function missingValidationResult(path: string): FileReferenceValidationResult {
  return {
    path,
    type: 'missing',
    exists: false,
  };
}

function validationResultFromType(
  path: string,
  type: 'file' | 'directory'
): FileReferenceValidationResult {
  return {
    path,
    type,
    exists: true,
  };
}

function parseApiValidationResult(
  normalizedPath: string,
  payload: unknown
): FileReferenceValidationResult {
  if (!payload || typeof payload !== 'object' || !('data' in payload)) {
    return missingValidationResult(normalizedPath);
  }

  const data = payload.data;
  if (!data || typeof data !== 'object' || !('exists' in data) || data.exists !== true) {
    return missingValidationResult(normalizedPath);
  }

  const responsePath = 'path' in data && typeof data.path === 'string'
    ? normalizeChatFilePath(data.path)
    : normalizedPath;
  const type =
    ('type' in data && data.type === 'directory') ||
    ('isDirectory' in data && data.isDirectory === true)
      ? 'directory'
      : 'file';

  return validationResultFromType(responsePath || normalizedPath, type);
}

function getCacheTtl(result: FileReferenceValidationResult): number {
  return result.type === 'missing'
    ? NEGATIVE_VALIDATION_CACHE_TTL_MS
    : POSITIVE_VALIDATION_CACHE_TTL_MS;
}

export async function validateFileReference(
  filePath: string,
  fileTree: FileNode[]
): Promise<FileReferenceValidationResult> {
  const normalizedPath = normalizeChatFilePath(filePath);

  const nodeInTree = findNodeInTree(normalizedPath, fileTree);
  if (nodeInTree !== null) {
    return validationResultFromType(normalizedPath, nodeInTree.type);
  }

  if (!normalizedPath || typeof fetch !== 'function') {
    return missingValidationResult(normalizedPath);
  }

  const now = Date.now();
  const cached = validationCache.get(normalizedPath);
  if (cached && cached.expiresAt > now) {
    if (cached.promise) {
      return cached.promise;
    }
    return cached.value ?? missingValidationResult(normalizedPath);
  }

  const promise = fetch(`/api/files/exists?path=${encodeURIComponent(normalizedPath)}`, {
    credentials: 'include',
    cache: 'no-store',
  })
    .then(async (response) => {
      if (!response.ok) {
        return missingValidationResult(normalizedPath);
      }

      const payload = await response.json().catch(() => null);
      return parseApiValidationResult(normalizedPath, payload);
    })
    .catch(() => missingValidationResult(normalizedPath))
    .then((result) => {
      validationCache.set(normalizedPath, {
        value: result,
        expiresAt: Date.now() + getCacheTtl(result),
      });
      return result;
    });

  validationCache.set(normalizedPath, {
    promise,
    expiresAt: now + NEGATIVE_VALIDATION_CACHE_TTL_MS,
  });

  return promise;
}

export async function validateFileExists(
  filePath: string,
  fileTree: FileNode[]
): Promise<boolean> {
  const result = await validateFileReference(filePath, fileTree);
  return result.type === 'file';
}

export { findNodeInTree } from '@/app/lib/files/tree-utils';
