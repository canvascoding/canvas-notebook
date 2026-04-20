import { listDirectory } from './workspace-files';
import type { FileReferenceEntry } from './file-reference-search';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp']);
const FILE_REFERENCE_CACHE_TTL_MS = 30_000;

interface FileReferenceCacheEntry {
  expiresAt: number;
  entries: FileReferenceEntry[];
}

let cacheEntry: FileReferenceCacheEntry | null = null;
let pendingBuild: Promise<FileReferenceEntry[]> | null = null;

async function collectFilesRecursive(dirPath: string): Promise<FileReferenceEntry[]> {
  try {
    const entries = await listDirectory(dirPath);
    const files: FileReferenceEntry[] = [];

    for (const entry of entries) {
      if (entry.type === 'directory') {
        try {
          const subFiles = await collectFilesRecursive(entry.path);
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
      });
    }

    return files;
  } catch {
    return [];
  }
}

export function invalidateFileReferenceCache(): void {
  cacheEntry = null;
  pendingBuild = null;
}

export async function getCachedFileReferenceEntries(forceRefresh = false): Promise<FileReferenceEntry[]> {
  const now = Date.now();
  if (!forceRefresh && cacheEntry && cacheEntry.expiresAt > now) {
    return cacheEntry.entries;
  }

  if (pendingBuild) {
    return pendingBuild;
  }

  pendingBuild = collectFilesRecursive('.')
    .then((entries) => {
      cacheEntry = {
        entries,
        expiresAt: Date.now() + FILE_REFERENCE_CACHE_TTL_MS,
      };
      return entries;
    })
    .finally(() => {
      pendingBuild = null;
    });

  return pendingBuild;
}
