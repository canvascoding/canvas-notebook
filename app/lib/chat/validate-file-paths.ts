import type { FileNode } from '@/app/lib/files/types';
import { findNodeInTree } from '@/app/lib/files/tree-utils';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { withWorkspaceQuery, workspaceHeaders } from '@/app/lib/files/client';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';

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
export interface FileReferenceValidationInvalidation {
  workspaceId: string;
  path: string | null;
}

const validationListeners = new Set<(event: FileReferenceValidationInvalidation) => void>();

function getActiveWorkspaceId(): string | null {
  return useWorkspaceStore.getState().activeWorkspaceId;
}

function buildValidationCacheKey(workspaceId: string | null, path: string): string {
  return `${workspaceId ?? LEGACY_PERSONAL_WORKSPACE_ID}\0${path}`;
}

function notifyValidationListeners(event: FileReferenceValidationInvalidation) {
  for (const listener of validationListeners) listener(event);
}

export function subscribeToFileReferenceValidationInvalidation(
  listener: (event: FileReferenceValidationInvalidation) => void,
): () => void {
  validationListeners.add(listener);
  return () => validationListeners.delete(listener);
}

export function invalidateFileReferenceValidationCache(options: {
  workspaceId?: string | null;
  path?: string | null;
} = {}): void {
  const workspaceId = options.workspaceId ?? getActiveWorkspaceId() ?? LEGACY_PERSONAL_WORKSPACE_ID;
  const normalizedPath = options.path ? normalizeChatFilePath(options.path) : null;

  for (const key of validationCache.keys()) {
    const [cachedWorkspaceId, cachedPath] = key.split('\0', 2);
    if (workspaceId && cachedWorkspaceId !== workspaceId) continue;
    if (
      normalizedPath &&
      cachedPath !== normalizedPath &&
      !cachedPath.startsWith(`${normalizedPath}/`) &&
      !normalizedPath.startsWith(`${cachedPath}/`)
    ) {
      continue;
    }
    validationCache.delete(key);
  }

  notifyValidationListeners({ workspaceId, path: normalizedPath });
}

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
  fileTree: FileNode[],
  options: { fileTreeWorkspaceId?: string | null } = {},
): Promise<FileReferenceValidationResult> {
  const normalizedPath = normalizeChatFilePath(filePath);
  const workspaceId = getActiveWorkspaceId();

  const canUseTree = options.fileTreeWorkspaceId === undefined || options.fileTreeWorkspaceId === workspaceId;
  const nodeInTree = canUseTree ? findNodeInTree(normalizedPath, fileTree) : null;
  if (nodeInTree !== null) {
    return validationResultFromType(normalizedPath, nodeInTree.type);
  }

  if (!normalizedPath || typeof fetch !== 'function') {
    return missingValidationResult(normalizedPath);
  }

  const now = Date.now();
  const cacheKey = buildValidationCacheKey(workspaceId, normalizedPath);
  const cached = validationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if (cached.promise) {
      return cached.promise;
    }
    return cached.value ?? missingValidationResult(normalizedPath);
  }

  const url = withWorkspaceQuery(`/api/files/exists?path=${encodeURIComponent(normalizedPath)}`, workspaceId);
  const promise = fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    headers: workspaceHeaders(workspaceId),
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
      validationCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + getCacheTtl(result),
      });
      return result;
    });

  validationCache.set(cacheKey, {
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
