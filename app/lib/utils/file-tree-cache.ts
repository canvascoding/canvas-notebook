import type { FileNode } from '@/app/lib/files/types';
import { LruCache } from './lru-cache';

export const fileTreeCache = new LruCache<FileNode[]>(50, 5 * 60 * 1000);

export function buildFileTreeCacheKey(dirPath: string, depth: number, workspaceId = 'legacy', includeStats = true) {
  return `${workspaceId}\0${dirPath}:${depth}:${includeStats ? 'stats' : 'fast'}`;
}

export function parseFileTreeCacheKey(key: string) {
  const [workspaceId, pathKey = key] = key.includes('\0') ? key.split('\0', 2) : ['legacy', key];
  const metadataSeparatorIndex = pathKey.lastIndexOf(':');
  const metadataToken = metadataSeparatorIndex === -1 ? '' : pathKey.slice(metadataSeparatorIndex + 1);
  const hasMetadataToken = metadataToken === 'stats' || metadataToken === 'fast';
  const includeStats = hasMetadataToken ? metadataToken === 'stats' : true;
  const depthPathKey = hasMetadataToken ? pathKey.slice(0, metadataSeparatorIndex) : pathKey;
  const separatorIndex = depthPathKey.lastIndexOf(':');
  if (separatorIndex === -1) {
    return { workspaceId, path: pathKey, depth: null, includeStats };
  }

  const depth = Number.parseInt(depthPathKey.slice(separatorIndex + 1), 10);
  if (Number.isNaN(depth)) {
    return { workspaceId, path: pathKey, depth: null, includeStats };
  }

  return {
    workspaceId,
    path: depthPathKey.slice(0, separatorIndex),
    depth,
    includeStats,
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
