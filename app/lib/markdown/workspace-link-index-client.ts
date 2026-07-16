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
    for (const key of markdownEmbedCache.keys()) {
      if (key.startsWith(`${normalizedWorkspaceId}\0`)) markdownEmbedCache.delete(key);
    }
  } else {
    linkIndexCache.clear();
    markdownEmbedCache.clear();
  }
  notifyInvalidation(normalizedWorkspaceId);
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
    const index = {
      ...payload.index,
      omittedDocuments: payload.index.omittedDocuments ?? [],
    };
    linkIndexCache.set(normalizedWorkspaceId, {
      expiresAt: Date.now() + LINK_INDEX_CACHE_TTL_MS,
      value: index,
    });
    return index;
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
