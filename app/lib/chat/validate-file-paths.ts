import type { FileNode } from '@/app/lib/files/types';
import { findNodeInTree } from '@/app/lib/files/tree-utils';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { withWorkspaceQuery, workspaceHeaders } from '@/app/lib/files/client';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';
import { invalidateWorkspaceLinkIndexCache } from '@/app/lib/markdown/workspace-link-index-client';

const POSITIVE_VALIDATION_CACHE_TTL_MS = 30_000;
const NEGATIVE_VALIDATION_CACHE_TTL_MS = 30_000;
const UNAVAILABLE_VALIDATION_CACHE_TTL_MS = 5_000;

export type FileReferenceValidationType = 'file' | 'directory' | 'missing' | 'unavailable';

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

function unavailableValidationResult(path: string): FileReferenceValidationResult {
  return { path, type: 'unavailable', exists: false };
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
    return unavailableValidationResult(normalizedPath);
  }

  const data = payload.data;
  if (!data || typeof data !== 'object' || !('exists' in data) || typeof data.exists !== 'boolean') {
    return unavailableValidationResult(normalizedPath);
  }
  if (!data.exists) return missingValidationResult(normalizedPath);

  const responsePath = 'path' in data && typeof data.path === 'string'
    ? normalizeChatFilePath(data.path)
    : normalizedPath;
  const type =
    ('type' in data && data.type === 'directory') ||
    ('isDirectory' in data && data.isDirectory === true)
      ? 'directory'
      : 'file';

  if (responsePath !== normalizedPath) return unavailableValidationResult(normalizedPath);
  return validationResultFromType(normalizedPath, type);
}

function getCacheTtl(result: FileReferenceValidationResult): number {
  if (result.type === 'unavailable') return UNAVAILABLE_VALIDATION_CACHE_TTL_MS;
  return result.type === 'missing'
    ? NEGATIVE_VALIDATION_CACHE_TTL_MS
    : POSITIVE_VALIDATION_CACHE_TTL_MS;
}

export async function validateFileReference(
  filePath: string,
  fileTree: FileNode[],
  options: { workspaceId?: string | null; fileTreeWorkspaceId?: string | null; preferFresh?: boolean } = {},
): Promise<FileReferenceValidationResult> {
  const normalizedPath = normalizeChatFilePath(filePath);
  const workspaceId = options.workspaceId === undefined ? getActiveWorkspaceId() : options.workspaceId;
  const cacheKey = buildValidationCacheKey(workspaceId, normalizedPath);

  const now = Date.now();
  const cached = validationCache.get(cacheKey);
  // In-flight work has no TTL. A slow request must not cause another request.
  if (cached?.promise) return cached.promise;
  if (cached?.value && cached.expiresAt > now) return cached.value;

  const canUseTree = !options.preferFresh && (options.fileTreeWorkspaceId === undefined || options.fileTreeWorkspaceId === workspaceId);
  const nodeInTree = canUseTree ? findNodeInTree(normalizedPath, fileTree) : null;
  if (nodeInTree !== null) {
    return validationResultFromType(normalizedPath, nodeInTree.type);
  }

  if (!normalizedPath) return missingValidationResult(normalizedPath);
  if (typeof fetch !== 'function') return unavailableValidationResult(normalizedPath);

  const url = withWorkspaceQuery(`/api/files/exists?path=${encodeURIComponent(normalizedPath)}`, workspaceId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const promise: Promise<FileReferenceValidationResult> = fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    headers: workspaceHeaders(workspaceId),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        return unavailableValidationResult(normalizedPath);
      }

      const payload = await response.json().catch(() => null);
      return parseApiValidationResult(normalizedPath, payload);
    })
    .catch(() => unavailableValidationResult(normalizedPath))
    .then((result) => {
      const current = validationCache.get(cacheKey);
      if (current?.promise !== promise) {
        return current?.promise ?? current?.value ?? unavailableValidationResult(normalizedPath);
      }
      validationCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + getCacheTtl(result),
      });
      return result;
    }).finally(() => clearTimeout(timeout));

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
