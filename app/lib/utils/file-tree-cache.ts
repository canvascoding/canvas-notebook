import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { LruCache } from './lru-cache';

export const fileTreeCache = new LruCache<FileNode[]>(50, 5 * 60 * 1000);

export function clearFileTreeCache() {
  fileTreeCache.clear();
}
