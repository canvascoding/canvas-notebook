import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { LruCache } from './lru-cache';

export const fileTreeCache = new LruCache<FileNode[]>(50, 5 * 60 * 1000);

export function buildFileTreeCacheKey(dirPath: string, depth: number) {
  return `${dirPath}:${depth}`;
}

export function parseFileTreeCacheKey(key: string) {
  const separatorIndex = key.lastIndexOf(':');
  if (separatorIndex === -1) {
    return { path: key, depth: null };
  }

  const depth = Number.parseInt(key.slice(separatorIndex + 1), 10);
  if (Number.isNaN(depth)) {
    return { path: key, depth: null };
  }

  return {
    path: key.slice(0, separatorIndex),
    depth,
  };
}

export function clearFileTreeCache() {
  fileTreeCache.clear();
}

export function clearSubtreeCache(dirPath: string) {
  const keys = fileTreeCache.keys();
  for (const key of keys) {
    const { path: cachedPath } = parseFileTreeCacheKey(key);
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
