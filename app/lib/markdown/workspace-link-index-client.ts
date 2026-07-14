import { readApiError, readApiJson, workspaceHeaders, withWorkspaceQuery } from '@/app/lib/files/client';

import {
  resolveObsidianWikiLink,
  type ObsidianLinkResolution,
} from './obsidian-link-resolver';
import type { WorkspaceLinkIndex } from './workspace-link-index-core';

const LINK_INDEX_CACHE_TTL_MS = 30_000;

type LinkIndexResponse = {
  error?: string;
  index?: WorkspaceLinkIndex;
  success?: boolean;
};

type LinkIndexCacheEntry = {
  expiresAt: number;
  promise?: Promise<WorkspaceLinkIndex>;
  value?: WorkspaceLinkIndex;
};

export type WorkspaceLinkIndexInvalidation = {
  workspaceId: string | null;
};

const linkIndexCache = new Map<string, LinkIndexCacheEntry>();
const invalidationListeners = new Set<(event: WorkspaceLinkIndexInvalidation) => void>();

function normalizeWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!normalized) throw new Error('Workspace context is not ready');
  return normalized;
}

function notifyInvalidation(workspaceId: string | null): void {
  for (const listener of invalidationListeners) listener({ workspaceId });
}

export function subscribeWorkspaceLinkIndexInvalidation(
  listener: (event: WorkspaceLinkIndexInvalidation) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

export function invalidateWorkspaceLinkIndexCache(workspaceId?: string | null): void {
  const normalizedWorkspaceId = workspaceId?.trim() || null;
  if (normalizedWorkspaceId) {
    linkIndexCache.delete(normalizedWorkspaceId);
  } else {
    linkIndexCache.clear();
  }
  notifyInvalidation(normalizedWorkspaceId);
}

export async function loadWorkspaceLinkIndex(
  workspaceId: string,
  options: { force?: boolean } = {},
): Promise<WorkspaceLinkIndex> {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const now = Date.now();
  const cached = linkIndexCache.get(normalizedWorkspaceId);
  if (!options.force && cached && cached.expiresAt > now) {
    if (cached.promise) return cached.promise;
    if (cached.value) return cached.value;
  }

  const url = withWorkspaceQuery('/api/markdown/link-index', normalizedWorkspaceId);
  const promise = fetch(url, {
    cache: 'no-store',
    credentials: 'include',
    headers: workspaceHeaders(normalizedWorkspaceId),
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(await readApiError(response, 'Failed to load workspace link index'));
    }
    const payload = await readApiJson<LinkIndexResponse>(response, 'Failed to load workspace link index');
    if (!payload.success || !payload.index) {
      throw new Error(payload.error || 'Failed to load workspace link index');
    }
    linkIndexCache.set(normalizedWorkspaceId, {
      expiresAt: Date.now() + LINK_INDEX_CACHE_TTL_MS,
      value: payload.index,
    });
    return payload.index;
  }).catch((error) => {
    const current = linkIndexCache.get(normalizedWorkspaceId);
    if (current?.promise === promise) linkIndexCache.delete(normalizedWorkspaceId);
    throw error;
  });

  linkIndexCache.set(normalizedWorkspaceId, {
    expiresAt: now + LINK_INDEX_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

export function resolveWorkspaceLinkFromIndex(
  rawTarget: string,
  index: WorkspaceLinkIndex,
  sourcePath?: string | null,
): ObsidianLinkResolution | null {
  return resolveObsidianWikiLink(
    rawTarget,
    index.documents.map((document) => ({
      aliases: document.aliases,
      extension: document.path.split('.').pop()?.toLowerCase(),
      path: document.path,
      type: 'file' as const,
    })),
    sourcePath,
  );
}
