import type { FileNode } from '@/app/store/file-store';
import { normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';

const POSITIVE_VALIDATION_CACHE_TTL_MS = 30_000;
const NEGATIVE_VALIDATION_CACHE_TTL_MS = 10_000;

type ValidationCacheEntry = {
  expiresAt: number;
  promise?: Promise<boolean>;
  value?: boolean;
};

const validationCache = new Map<string, ValidationCacheEntry>();

export async function validateFileExists(
  filePath: string,
  fileTree: FileNode[]
): Promise<boolean> {
  const normalizedPath = normalizeChatFilePath(filePath);

  const nodeInTree = findNodeInTree(normalizedPath, fileTree);
  if (nodeInTree !== null) {
    return true;
  }

  if (!normalizedPath || typeof fetch !== 'function') {
    return false;
  }

  const now = Date.now();
  const cached = validationCache.get(normalizedPath);
  if (cached && cached.expiresAt > now) {
    if (cached.promise) {
      return cached.promise;
    }
    return cached.value === true;
  }

  const promise = fetch(`/api/files/exists?path=${encodeURIComponent(normalizedPath)}`, {
    credentials: 'include',
    cache: 'no-store',
  })
    .then(async (response) => {
      if (!response.ok) {
        return false;
      }

      const payload = await response.json().catch(() => null);
      return payload?.data?.exists === true;
    })
    .catch(() => false)
    .then((exists) => {
      validationCache.set(normalizedPath, {
        value: exists,
        expiresAt: Date.now() + (exists ? POSITIVE_VALIDATION_CACHE_TTL_MS : NEGATIVE_VALIDATION_CACHE_TTL_MS),
      });
      return exists;
    });

  validationCache.set(normalizedPath, {
    promise,
    expiresAt: now + NEGATIVE_VALIDATION_CACHE_TTL_MS,
  });

  return promise;
}

export function findNodeInTree(path: string, nodes: FileNode[]): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNodeInTree(path, node.children);
      if (found) return found;
    }
  }
  return null;
}
