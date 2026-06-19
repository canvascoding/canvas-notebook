import type { FileNode } from '@/app/lib/files/types';
import { LruCache } from './lru-cache';

export const fileTreeCache = new LruCache<FileNode[]>(50, 5 * 60 * 1000);

export function buildFileTreeCacheKey(dirPath: string, depth: number, workspaceId = 'legacy') {
  return `${workspaceId}\0${dirPath}:${depth}`;
}

export function parseFileTreeCacheKey(key: string) {
  const [workspaceId, pathKey = key] = key.includes('\0') ? key.split('\0', 2) : ['legacy', key];
  const separatorIndex = pathKey.lastIndexOf(':');
  if (separatorIndex === -1) {
    return { workspaceId, path: pathKey, depth: null };
  }

  const depth = Number.parseInt(pathKey.slice(separatorIndex + 1), 10);
  if (Number.isNaN(depth)) {
    return { workspaceId, path: pathKey, depth: null };
  }

  return {
    workspaceId,
    path: pathKey.slice(0, separatorIndex),
    depth,
  };
}

export function clearFileTreeCache(workspaceId?: string) {
  if (!workspaceId) {
    fileTreeCache.clear();
    return;
  }

  for (const key of fileTreeCache.keys()) {
    if (parseFileTreeCacheKey(key).workspaceId === workspaceId) {
      fileTreeCache.delete(key);
    }
  }
}

export function clearSubtreeCache(dirPath: string, workspaceId?: string) {
  const keys = fileTreeCache.keys();
  for (const key of keys) {
    const { workspaceId: cachedWorkspaceId, path: cachedPath } = parseFileTreeCacheKey(key);
    if (workspaceId && cachedWorkspaceId !== workspaceId) {
      continue;
    }

    const shouldDelete =
      dirPath === '.'
      || cachedPath === '.'
      || cachedPath === dirPath
      || cachedPath.startsWith(`${dirPath}/`)
      || dirPath.startsWith(`${cachedPath}/`);

    if (shouldDelete) {
      fileTreeCache.delete(key);
    }
  }
}
