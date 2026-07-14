import { markdownFileToHtmlDocument } from '@/app/lib/pdf/markdown-to-html';
import { resolveExistingWorkspacePath, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import {
  resolveWorkspaceBrandProfile,
  workspaceBrandProfileCacheKey,
} from '@/app/lib/workspaces/brand-profile-service';
import type { ResolvedWorkspaceBrandProfileState } from '@/app/lib/workspaces/brand-profile';
import fs from 'fs/promises';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;

type CacheEntry = {
  html: string;
  expiresAt: number;
  lastAccessedAt: number;
};

const markdownHtmlCache = new Map<string, CacheEntry>();

async function getCacheKey(
  filePath: string,
  fileOptions: WorkspaceFileOperationOptions | undefined,
  brandState: ResolvedWorkspaceBrandProfileState,
): Promise<string> {
  const fullPath = await resolveExistingWorkspacePath(filePath, fileOptions);
  const stats = await fs.stat(fullPath);

  if (!stats.isFile()) {
    throw new Error('Path must point to a file');
  }

  const workspaceId = fileOptions?.workspace?.workspaceId ?? 'legacy';
  return `${workspaceId}\0${filePath}\0${stats.size}\0${stats.mtimeMs}\0${workspaceBrandProfileCacheKey(brandState)}`;
}

function pruneCache(now: number) {
  for (const [key, entry] of markdownHtmlCache) {
    if (entry.expiresAt <= now) {
      markdownHtmlCache.delete(key);
    }
  }

  if (markdownHtmlCache.size <= MAX_CACHE_ENTRIES) {
    return;
  }

  const entries = Array.from(markdownHtmlCache.entries())
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt);

  for (const [key] of entries.slice(0, markdownHtmlCache.size - MAX_CACHE_ENTRIES)) {
    markdownHtmlCache.delete(key);
  }
}

export async function getCachedMarkdownHtmlDocument(
  filePath: string,
  fileOptions?: WorkspaceFileOperationOptions,
  providedBrandState?: ResolvedWorkspaceBrandProfileState,
): Promise<string> {
  const now = Date.now();
  pruneCache(now);

  const brandState = providedBrandState ?? await resolveMarkdownExportBrandState(fileOptions);
  const cacheKey = await getCacheKey(filePath, fileOptions, brandState);
  const cached = markdownHtmlCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    cached.lastAccessedAt = now;
    return cached.html;
  }

  const html = await markdownFileToHtmlDocument(filePath, fileOptions, brandState.profile);
  markdownHtmlCache.set(cacheKey, {
    html,
    expiresAt: now + CACHE_TTL_MS,
    lastAccessedAt: now,
  });

  return html;
}

export async function resolveMarkdownExportBrandState(
  fileOptions?: WorkspaceFileOperationOptions,
): Promise<ResolvedWorkspaceBrandProfileState> {
  const workspaceId = fileOptions?.workspace?.workspaceId;
  if (!workspaceId) {
    return resolveWorkspaceBrandProfile('__legacy_workspace__', null);
  }
  return resolveWorkspaceBrandProfile(
    workspaceId,
    fileOptions.workspace?.organizationId,
  );
}
