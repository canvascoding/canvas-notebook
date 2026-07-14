import type { FileNode } from '@/app/lib/files/types';
import { findNodeInTree } from '@/app/lib/files/tree-utils';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { withWorkspaceQuery, workspaceHeaders } from '@/app/lib/files/client';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';
import { invalidateWorkspaceLinkIndexCache } from '@/app/lib/markdown/workspace-link-index-client';

const POSITIVE_VALIDATION_CACHE_TTL_MS = 30_000;
const NEGATIVE_VALIDATION_CACHE_TTL_MS = 1_000;
const MAX_BACKGROUND_NEGATIVE_RETRIES = 5;

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
const negativeRetryAttempts = new Map<string, number>();
const negativeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
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

function clearNegativeRetry(cacheKey: string, resetAttempts = true) {
  const timer = negativeRetryTimers.get(cacheKey);
  if (timer) clearTimeout(timer);
  negativeRetryTimers.delete(cacheKey);
  if (resetAttempts) negativeRetryAttempts.delete(cacheKey);
}

function scheduleNegativeRetry(cacheKey: string, workspaceId: string, path: string) {
  if (negativeRetryTimers.has(cacheKey)) return;
  const attempts = negativeRetryAttempts.get(cacheKey) ?? 0;
  if (attempts >= MAX_BACKGROUND_NEGATIVE_RETRIES) return;
  negativeRetryAttempts.set(cacheKey, attempts + 1);

  const timer = setTimeout(() => {
    negativeRetryTimers.delete(cacheKey);
    const cached = validationCache.get(cacheKey);
    if (cached?.value?.type !== 'missing') return;
    validationCache.delete(cacheKey);
    notifyValidationListeners({ workspaceId, path });
  }, NEGATIVE_VALIDATION_CACHE_TTL_MS);
  negativeRetryTimers.set(cacheKey, timer);
}

export function subscribeToFileReferenceValidationInvalidation(
  listener: (event: FileReferenceValidationInvalidation) => void,
): () => void {
  validationListeners.add(listener);
  return () => validationListeners.delete(listener);
}

export function hasPendingFileReferenceValidationRetry(filePath: string): boolean {
  const normalizedPath = normalizeChatFilePath(filePath);
  if (!normalizedPath) return false;
  return negativeRetryTimers.has(buildValidationCacheKey(getActiveWorkspaceId(), normalizedPath));
}

export function invalidateFileReferenceValidationCache(options: {
  workspaceId?: string | null;
  path?: string | null;
} = {}): void {
  const workspaceId = options.workspaceId ?? getActiveWorkspaceId() ?? LEGACY_PERSONAL_WORKSPACE_ID;
  const normalizedPath = options.path ? normalizeChatFilePath(options.path) : null;

  const cacheKeys = new Set([...validationCache.keys(), ...negativeRetryTimers.keys()]);
  for (const key of cacheKeys) {
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
    clearNegativeRetry(key);
  }

  invalidateWorkspaceLinkIndexCache(workspaceId);
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
  const resolvedWorkspaceId = workspaceId ?? LEGACY_PERSONAL_WORKSPACE_ID;
  const cacheKey = buildValidationCacheKey(workspaceId, normalizedPath);

  const canUseTree = options.fileTreeWorkspaceId === undefined || options.fileTreeWorkspaceId === workspaceId;
  const nodeInTree = canUseTree ? findNodeInTree(normalizedPath, fileTree) : null;
  if (nodeInTree !== null) {
    clearNegativeRetry(cacheKey);
    return validationResultFromType(normalizedPath, nodeInTree.type);
  }

  if (!normalizedPath || typeof fetch !== 'function') {
    return missingValidationResult(normalizedPath);
  }

  const now = Date.now();
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
      if (result.type === 'missing') {
        scheduleNegativeRetry(cacheKey, resolvedWorkspaceId, normalizedPath);
      } else {
        clearNegativeRetry(cacheKey);
      }
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
