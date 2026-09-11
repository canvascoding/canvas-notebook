import {
  readApiError,
  readApiJson,
  readWorkspaceFile,
  workspaceHeaders,
  withWorkspaceQuery,
} from '@/app/lib/files/client';

import {
  getObsidianWikiCompletionInsertPath,
  resolveObsidianWikiLink,
  type ObsidianLinkResolution,
  type ObsidianWikiCompletionContext,
} from './obsidian-link-resolver';
import type { WorkspaceLinkDocument, WorkspaceLinkIndex } from './workspace-link-index-core';
import {
  workspaceDocumentTitleFromPath,
  type WorkspaceDocumentReference,
} from './workspace-document-preview';

const LINK_INDEX_CACHE_TTL_MS = 30_000;
// Background saves can invalidate every open tab. Leave room within the
// per-user endpoint budget for multiple tabs and explicit navigation.
const LINK_INDEX_MIN_REQUEST_INTERVAL_MS = 10_000;
const LINK_INDEX_INVALIDATION_BATCH_MS = 250;

type LinkIndexResponse = {
  error?: string;
  index?: WorkspaceLinkIndex;
  success?: boolean;
};

type LinkIndexCacheEntry = {
  expiresAt: number;
  generation: number;
  nextRequestAt: number;
  requestGeneration: number | null;
  promise?: Promise<WorkspaceLinkIndex>;
  followupPromise?: Promise<WorkspaceLinkIndex>;
  value?: WorkspaceLinkIndex;
};

type MarkdownEmbedCacheEntry = {
  expiresAt: number;
  promise: Promise<WorkspaceMarkdownEmbedDocument>;
};

export type WorkspaceLinkIndexInvalidation = {
  workspaceId: string | null;
};

export type WorkspaceWikiCompletionItem = {
  detail: string;
  displayLabel: string;
  kind: 'document' | 'heading' | 'block';
  target: string;
};

export type WorkspaceMarkdownEmbedDocument = {
  content: string;
  path: string;
};

export type WorkspaceDocumentReferenceLookup = {
  document: WorkspaceLinkDocument | null;
  reference: WorkspaceDocumentReference | null;
  resolution: ObsidianLinkResolution | null;
};

const linkIndexCache = new Map<string, LinkIndexCacheEntry>();
const markdownEmbedCache = new Map<string, MarkdownEmbedCacheEntry>();
const invalidationListeners = new Set<(event: WorkspaceLinkIndexInvalidation) => void>();
const pendingInvalidations = new Set<string | null>();
let invalidationTimer: ReturnType<typeof setTimeout> | null = null;

function linkIndexEntry(workspaceId: string): LinkIndexCacheEntry {
  let entry = linkIndexCache.get(workspaceId);
  if (!entry) {
    entry = { expiresAt: 0, generation: 0, nextRequestAt: 0, requestGeneration: null };
    linkIndexCache.set(workspaceId, entry);
  }
  return entry;
}

function scheduleInvalidation(workspaceId: string | null): void {
  pendingInvalidations.add(workspaceId);
  if (invalidationTimer) return;
  invalidationTimer = setTimeout(() => {
    invalidationTimer = null;
    const workspaces = [...pendingInvalidations];
    pendingInvalidations.clear();
    if (workspaces.includes(null)) notifyInvalidation(null);
    else for (const id of workspaces) notifyInvalidation(id);
  }, LINK_INDEX_INVALIDATION_BATCH_MS);
}

function invalidateLinkIndexEntry(entry: LinkIndexCacheEntry): void {
  entry.generation++;
  entry.expiresAt = 0;
  // Keep the promise: invalidation cannot create a second in-flight fetch.
}

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
    invalidateLinkIndexEntry(linkIndexEntry(normalizedWorkspaceId));
    for (const key of markdownEmbedCache.keys()) {
      if (key.startsWith(`${normalizedWorkspaceId}\0`)) markdownEmbedCache.delete(key);
    }
  } else {
    for (const entry of linkIndexCache.values()) invalidateLinkIndexEntry(entry);
    markdownEmbedCache.clear();
  }
  scheduleInvalidation(normalizedWorkspaceId);
}

export async function loadWorkspaceMarkdownEmbed(
  workspaceId: string,
  rawTarget: string,
  sourcePath?: string | null,
): Promise<WorkspaceMarkdownEmbedDocument> {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const cacheKey = `${normalizedWorkspaceId}\0${sourcePath ?? ''}\0${rawTarget}`;
  const now = Date.now();
  const cached = markdownEmbedCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = loadWorkspaceLinkIndex(normalizedWorkspaceId)
    .then(async (index) => {
      const resolution = resolveWorkspaceLinkFromIndex(rawTarget, index, sourcePath);
      if (resolution?.status !== 'resolved' || !resolution.path) {
        throw new Error(resolution?.status === 'ambiguous'
          ? `Ambiguous document link: ${resolution.candidates.join(', ')}`
          : `Document not found: ${rawTarget}`);
      }
      const file = await readWorkspaceFile(resolution.path, {
        fallbackMessage: 'Failed to load embedded document',
        workspaceId: normalizedWorkspaceId,
      });
      return { content: file.content, path: resolution.path };
    })
    .catch((error) => {
      markdownEmbedCache.delete(cacheKey);
      if (error instanceof Response) {
        throw new Error(`Embedded document could not be loaded (${error.status})`);
      }
      throw error;
    });
  markdownEmbedCache.set(cacheKey, {
    expiresAt: now + LINK_INDEX_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

export async function loadWorkspaceLinkIndex(
  workspaceId: string,
  options: { force?: boolean } = {},
): Promise<WorkspaceLinkIndex> {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const now = Date.now();
  const entry = linkIndexEntry(normalizedWorkspaceId);
  if (entry.promise) {
    if (entry.requestGeneration === null || entry.requestGeneration === entry.generation) return entry.promise;
    // A reader arriving after invalidation needs a request begun after its
    // read. Queue exactly one successor, without delaying existing readers
    // until the workspace becomes quiet or opening concurrent fetches.
    entry.followupPromise ??= entry.promise.catch(() => undefined).then(() => {
      entry.followupPromise = undefined;
      return loadWorkspaceLinkIndex(normalizedWorkspaceId);
    });
    return entry.followupPromise;
  }
  if (!options.force && entry.expiresAt > now && entry.value) return entry.value;
  if (options.force) entry.expiresAt = 0;

  const url = withWorkspaceQuery('/api/markdown/link-index', normalizedWorkspaceId);
  const promise = (async () => {
    const delay = entry.nextRequestAt - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const generation = entry.generation;
    entry.requestGeneration = generation;
    entry.nextRequestAt = Date.now() + LINK_INDEX_MIN_REQUEST_INTERVAL_MS;
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      headers: workspaceHeaders(normalizedWorkspaceId),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryAt = Number.isFinite(seconds)
          ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter ?? '');
        if (Number.isFinite(retryAt)) entry.nextRequestAt = Math.max(entry.nextRequestAt, retryAt);
      }
      throw new Error(await readApiError(response, 'Failed to load workspace link index'));
    }
    const payload = await readApiJson<LinkIndexResponse>(response, 'Failed to load workspace link index');
    if (!payload.success || !payload.index) {
      throw new Error(payload.error || 'Failed to load workspace link index');
    }
    const index = {
      ...payload.index,
      omittedDocuments: payload.index.omittedDocuments ?? [],
    };
    entry.value = index;
    entry.expiresAt = generation === entry.generation ? Date.now() + LINK_INDEX_CACHE_TTL_MS : 0;
    // Deliver this completed snapshot without waiting for a quiet workspace.
    // If it was invalidated in flight, it remains stale and subscribers get
    // one coalesced follow-up. A later load must fetch, never reuse it as fresh.
    if (generation !== entry.generation) scheduleInvalidation(normalizedWorkspaceId);
    return index;
  })().finally(() => {
    if (entry.promise === promise) {
      entry.promise = undefined;
      entry.requestGeneration = null;
    }
  });

  entry.promise = promise;
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

export function resolveWorkspaceDocumentReferenceFromIndex(
  rawTarget: string,
  index: WorkspaceLinkIndex,
  sourcePath?: string | null,
): WorkspaceDocumentReferenceLookup {
  const resolution = resolveWorkspaceLinkFromIndex(rawTarget, index, sourcePath);
  const document = resolution?.status === 'resolved' && resolution.path
    ? index.documents.find((candidate) => candidate.path === resolution.path) ?? null
    : null;
  const reference = resolution?.status === 'resolved' && resolution.path
    ? {
        blockId: resolution.blockId,
        heading: resolution.heading,
        path: resolution.path,
        title: document?.title || workspaceDocumentTitleFromPath(resolution.path),
      }
    : null;
  return { document, reference, resolution };
}

export async function loadWorkspaceDocumentReference(
  workspaceId: string,
  rawTarget: string,
  sourcePath?: string | null,
): Promise<WorkspaceDocumentReferenceLookup> {
  const index = await loadWorkspaceLinkIndex(workspaceId);
  return resolveWorkspaceDocumentReferenceFromIndex(rawTarget, index, sourcePath);
}

function normalizedSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function completionScore(document: WorkspaceLinkDocument, query: string): number {
  if (!query) return 1;
  const path = getObsidianWikiCompletionInsertPath(document.path).toLocaleLowerCase();
  const basename = path.split('/').pop() || path;
  const title = document.title.toLocaleLowerCase();
  const aliases = document.aliases.map((alias) => alias.toLocaleLowerCase());
  if (basename === query || title === query || aliases.includes(query)) return 0;
  if (basename.startsWith(query) || title.startsWith(query) || aliases.some((alias) => alias.startsWith(query))) {
    return 1;
  }
  if (path.includes(query) || title.includes(query) || aliases.some((alias) => alias.includes(query))) return 2;
  return Number.POSITIVE_INFINITY;
}

function findCompletionDocument(
  index: WorkspaceLinkIndex,
  pathQuery: string,
  sourcePath?: string | null,
): WorkspaceLinkDocument | null {
  const resolution = resolveWorkspaceLinkFromIndex(pathQuery, index, sourcePath);
  if (resolution?.status !== 'resolved' || !resolution.path) return null;
  return index.documents.find((document) => document.path === resolution.path) ?? null;
}

export function getWorkspaceWikiCompletionItems(
  index: WorkspaceLinkIndex,
  context: Pick<ObsidianWikiCompletionContext, 'fragmentQuery' | 'kind' | 'pathQuery'>,
  sourcePath?: string | null,
  limit = 100,
): WorkspaceWikiCompletionItem[] {
  const safeLimit = Math.max(1, limit);
  if (context.kind === 'document') {
    const query = normalizedSearchValue(context.pathQuery);
    return index.documents
      .map((document) => ({ document, score: completionScore(document, query) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => (
        left.score - right.score || left.document.path.localeCompare(right.document.path)
      ))
      .slice(0, safeLimit)
      .map(({ document }) => ({
        detail: document.aliases.length > 0
          ? `${document.path} · ${document.aliases.join(', ')}`
          : document.path,
        displayLabel: document.title,
        kind: 'document' as const,
        target: getObsidianWikiCompletionInsertPath(document.path),
      }));
  }

  const document = findCompletionDocument(index, context.pathQuery, sourcePath);
  if (!document) return [];
  const canonicalPath = context.pathQuery
    ? getObsidianWikiCompletionInsertPath(document.path)
    : '';
  const fragmentQuery = normalizedSearchValue(context.fragmentQuery ?? '');
  const blockQuery = fragmentQuery.replace(/^\^/u, '');
  const headings = context.kind === 'block'
    ? []
    : document.headings
      .filter((heading) => normalizedSearchValue(heading.text).includes(fragmentQuery))
      .map((heading) => ({
        detail: `${document.path} · H${heading.depth}`,
        displayLabel: heading.text,
        kind: 'heading' as const,
        target: `${canonicalPath}#${heading.text}`,
      }));
  const blocks = document.blockIds
    .filter((blockId) => normalizedSearchValue(blockId).includes(blockQuery))
    .map((blockId) => ({
      detail: `${document.path} · ^${blockId}`,
      displayLabel: `^${blockId}`,
      kind: 'block' as const,
      target: `${canonicalPath}#^${blockId}`,
    }));

  return [...headings, ...blocks].slice(0, safeLimit);
}
