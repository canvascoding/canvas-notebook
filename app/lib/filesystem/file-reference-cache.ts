import { listDirectory, type WorkspaceFileOperationOptions } from './workspace-files';
import type { FileReferenceEntry } from './file-reference-search';
import { AsyncSemaphore } from '@/app/lib/utils/async-semaphore';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp']);
const FILE_REFERENCE_CACHE_TTL_MS = 30_000;
const FILE_REFERENCE_DIRECTORY_CONCURRENCY = 12;

interface FileReferenceCacheEntry {
  expiresAt: number;
  entries: FileReferenceEntry[];
}

const cacheEntries = new Map<string, FileReferenceCacheEntry>();
const pendingBuilds = new Map<string, Promise<FileReferenceEntry[]>>();

function getWorkspaceCacheKey(options?: WorkspaceFileOperationOptions): string {
  return options?.workspace?.workspaceId ?? 'legacy';
}

async function collectFilesRecursive(
  dirPath: string,
  options: WorkspaceFileOperationOptions | undefined,
  semaphore: AsyncSemaphore,
  isRoot = false,
): Promise<FileReferenceEntry[]> {
  try {
    const entries = await semaphore.run(() => listDirectory(dirPath, {
      ...options,
      includeMetadata: true,
    }));
    const files: FileReferenceEntry[] = [];
    const directories = [];

    for (const entry of entries) {
      if (entry.type === 'directory') {
        directories.push(entry.path);
        continue;
      }

      const extension = entry.path.split('.').pop()?.toLowerCase();
      files.push({
        name: entry.name,
        path: entry.path,
        type: 'file',
        extension,
        isImage: extension ? IMAGE_EXTENSIONS.has(extension) : false,
        size: entry.size,
        created: entry.created,
        modified: entry.modified,
      });
    }

    const nestedFiles = await Promise.all(
      directories.map((path) => collectFilesRecursive(path, options, semaphore)),
    );
    for (const entries of nestedFiles) files.push(...entries);

    return files;
  } catch (error) {
    if (isRoot) throw error;
    console.warn(`[FileReferenceCache] Skipping unreadable directory: ${dirPath}`, error);
    return [];
  }
}

export function invalidateFileReferenceCache(options?: WorkspaceFileOperationOptions): void {
  if (!options?.workspace) {
    cacheEntries.clear();
    pendingBuilds.clear();
    return;
  }

  const cacheKey = getWorkspaceCacheKey(options);
  cacheEntries.delete(cacheKey);
  pendingBuilds.delete(cacheKey);
}

export async function getCachedFileReferenceEntries(
  forceRefresh = false,
  options?: WorkspaceFileOperationOptions
): Promise<FileReferenceEntry[]> {
  const cacheKey = getWorkspaceCacheKey(options);
  const now = Date.now();
  const cacheEntry = cacheEntries.get(cacheKey);
  if (!forceRefresh && cacheEntry && cacheEntry.expiresAt > now) {
    return cacheEntry.entries;
  }

  const pendingBuild = pendingBuilds.get(cacheKey);
  if (pendingBuild) {
    return pendingBuild;
  }

  const nextBuild = collectFilesRecursive(
    '.',
    options,
    new AsyncSemaphore(FILE_REFERENCE_DIRECTORY_CONCURRENCY),
    true,
  )
    .then((entries) => {
      cacheEntries.set(cacheKey, {
        entries,
        expiresAt: Date.now() + FILE_REFERENCE_CACHE_TTL_MS,
      });
      return entries;
    })
    .finally(() => {
      pendingBuilds.delete(cacheKey);
    });

  pendingBuilds.set(cacheKey, nextBuild);
  return nextBuild;
}
