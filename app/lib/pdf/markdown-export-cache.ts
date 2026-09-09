import { markdownFileToHtmlDocument, markdownTextToHtmlDocument } from '@/app/lib/pdf/markdown-to-html';
import { createHash } from 'node:crypto';
import path from 'node:path';
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
  markdown?: string,
): Promise<string> {
  const workspaceId = fileOptions?.workspace?.workspaceId ?? 'legacy';
  if (markdown !== undefined) {
    return `${workspaceId}\0${filePath}\0content:${createHash('sha256').update(markdown).digest('hex')}\0${workspaceBrandProfileCacheKey(brandState)}`;
  }
  const fullPath = await resolveExistingWorkspacePath(filePath, fileOptions);
  const stats = await fs.stat(fullPath);

  if (!stats.isFile()) {
    throw new Error('Path must point to a file');
  }

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
  providedMarkdown?: string,
): Promise<string> {
  const now = Date.now();
  pruneCache(now);

  const brandState = providedBrandState ?? await resolveMarkdownExportBrandState(fileOptions);
  const cacheKey = await getCacheKey(filePath, fileOptions, brandState, providedMarkdown);
  const cached = markdownHtmlCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    cached.lastAccessedAt = now;
    return cached.html;
  }

  const html = providedMarkdown === undefined
    ? await markdownFileToHtmlDocument(filePath, fileOptions, brandState.profile)
    : await markdownTextToHtmlDocument(providedMarkdown, {
      title: path.basename(filePath, path.extname(filePath)), assetBasePath: path.dirname(filePath),
      fileOptions, brandProfile: brandState.profile,
    });
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
