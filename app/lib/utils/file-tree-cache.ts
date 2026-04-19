import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { LruCache } from './lru-cache';

export const fileTreeCache = new LruCache<FileNode[]>(50, 5 * 60 * 1000);

export function clearFileTreeCache() {
  fileTreeCache.clear();
}

export function clearSubtreeCache(dirPath: string) {
  const keys = fileTreeCache.keys();
  for (const key of keys) {
    if (key === dirPath || key.startsWith(dirPath + '/') || dirPath.startsWith(key.split(':')[0] + '/')) {
      fileTreeCache.delete(key);
    }
  }
}
