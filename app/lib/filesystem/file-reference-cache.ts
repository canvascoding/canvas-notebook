import { listDirectory, type WorkspaceFileOperationOptions } from './workspace-files';
import type { FileReferenceEntry } from './file-reference-search';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp']);
const FILE_REFERENCE_CACHE_TTL_MS = 30_000;

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
  options?: WorkspaceFileOperationOptions
): Promise<FileReferenceEntry[]> {
  try {
    const entries = await listDirectory(dirPath, options);
    const files: FileReferenceEntry[] = [];

    for (const entry of entries) {
      if (entry.type === 'directory') {
        try {
          const subFiles = await collectFilesRecursive(entry.path, options);
          files.push(...subFiles);
        } catch {
          // Skip directories we can't read.
        }
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
      });
    }

    return files;
  } catch {
    return [];
  }
}

export function invalidateFileReferenceCache(): void {
  cacheEntries.clear();
  pendingBuilds.clear();
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

  const nextBuild = collectFilesRecursive('.', options)
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
