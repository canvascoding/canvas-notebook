import 'server-only';

import { ToolKitListResponseSchema, type ToolKitItem } from '@composio/core';

import { getComposio } from './composio-client';
import { getConnectedAccounts } from './composio-auth';
import { composioContextCacheKey, type ResolvedComposioContext } from './composio-context';
import { classifyComposioFailure, ComposioProviderError } from './composio-provider-error';
import { resolveComposioToolkitAccess } from './composio-toolkit-access';

export interface ToolkitInfo {
  slug: string;
  name: string;
  logo: string;
  description: string;
  toolsCount: number;
  noAuth: boolean;
  connected: boolean;
  connectedAccountId?: string;
  connectedAccountStatus?: string;
}

export interface ToolkitToolInfo {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const TOOLKIT_PAGE_LIMIT = 1000;
const MAX_TOOLKIT_PAGES = 20;
const MAX_TOOLKIT_CURSOR_LENGTH = 8192;

const HIDDEN_TOOLKIT_SLUGS = new Set([
  'gemini',
  'google_veo',
  'nano_banana',
  'openai',
  'anthropic',
  'google',
]);

const toolkitCache = new Map<string, { data: ToolkitInfo[]; expires: number }>();
const rawToolkitCache = new Map<string, { data: unknown[]; expires: number }>();
const toolsCache = new Map<string, { data: ToolkitToolInfo[]; expires: number }>();

const MAX_TOOLS_CACHE_SIZE = 50;

function cleanupExpiredToolsEntries() {
  const now = Date.now();
  for (const [key, entry] of toolsCache) {
    if (entry.expires <= now) {
      toolsCache.delete(key);
    }
  }
  if (toolsCache.size > MAX_TOOLS_CACHE_SIZE) {
    const entries = [...toolsCache.entries()].sort((a, b) => a[1].expires - b[1].expires);
    const excess = entries.length - MAX_TOOLS_CACHE_SIZE;
    for (let i = 0; i < excess; i++) {
      toolsCache.delete(entries[i][0]);
    }
  }
}

function storageScopeCacheKey(context: ResolvedComposioContext): string {
  const storageScope = context.storageScope;
  const userId = storageScope.userId?.trim() || '';
  const organizationId = storageScope.organizationId?.trim() || '';
  const secretScope = storageScope.secretScope || (userId ? 'user' : organizationId ? 'organization' : 'legacy');
  return `${secretScope}:${userId}:${organizationId}`;
}

export async function getAvailableToolkitsRaw(context: ResolvedComposioContext): Promise<unknown[]> {
  const now = Date.now();
  const cacheKey = storageScopeCacheKey(context);
  const cached = rawToolkitCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.data;
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const invalidCatalogue = () => new ComposioProviderError('The Composio toolkit catalogue response is incomplete.', { code: 'COMPOSIO_BAD_RESPONSE', retryable: false });
  try {
    const items = new Map<string, ToolKitItem>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    let expectedItems = 0;
    for (let page = 0; page < MAX_TOOLKIT_PAGES; page += 1) {
      controller.signal.throwIfAborted();
      // core.toolkits.get() transforms to an array and discards next_cursor.
      // The existing SDK client retains the same project credentials and pagination.
      const response = await composio.getClient().toolkits.list({ limit: TOOLKIT_PAGE_LIMIT, ...(cursor ? { cursor } : {}) }, { signal: controller.signal, maxRetries: 0 });
      controller.signal.throwIfAborted();
      if (!response || !Array.isArray(response.items) || response.items.length > TOOLKIT_PAGE_LIMIT) throw invalidCatalogue();
      if (response.total_items !== undefined) {
        if (!Number.isSafeInteger(response.total_items) || response.total_items < 0) throw invalidCatalogue();
        expectedItems = Math.max(expectedItems, response.total_items);
      }
      let normalized: ToolKitItem[];
      try {
        // Preserve the public core SDK's camelCase metadata/auth contract while
        // retaining the low-level cursor outside its array-only transformation.
        normalized = ToolKitListResponseSchema.parse(response.items.map(item => ({
          name: item.name, slug: item.slug, isLocalToolkit: item.is_local_toolkit,
          authSchemes: item.auth_schemes, composioManagedAuthSchemes: item.composio_managed_auth_schemes, noAuth: item.no_auth,
          meta: { ...item.meta, categories: item.meta.categories?.map(category => ({ slug: category.id, name: category.name })),
            createdAt: item.meta.created_at, updatedAt: item.meta.updated_at, description: item.meta.description, logo: item.meta.logo,
            toolsCount: item.meta.tools_count, triggersCount: item.meta.triggers_count, appUrl: item.meta.app_url ?? undefined },
        })));
      } catch { throw invalidCatalogue(); }
      for (const item of normalized) {
        if (!item.slug.trim()) throw invalidCatalogue();
        items.set(item.slug, item);
      }
      const next = response.next_cursor;
      if (next === undefined || next === null || next === '') {
        if (response.total_pages !== undefined && (!Number.isSafeInteger(response.total_pages) || response.total_pages < 0 || response.total_pages > page + 1)) throw invalidCatalogue();
        if (expectedItems > items.size) throw invalidCatalogue();
        const rawItems = [...items.values()];
        console.log(`[Composio] Fetched ${rawItems.length} raw toolkits`);
        rawToolkitCache.set(cacheKey, { data: rawItems, expires: now + CACHE_TTL_MS });
        return rawItems;
      }
      if (typeof next !== 'string' || !next.trim() || next.length > MAX_TOOLKIT_CURSOR_LENGTH || /[\p{Cc}\p{Cf}]/u.test(next) || seen.has(next)) throw invalidCatalogue();
      seen.add(next); cursor = next;
    }
    throw invalidCatalogue();
  } catch (error) {
    console.error('[Composio] Failed to fetch raw toolkits', { operation: 'toolkits.list', errorType: error instanceof Error ? error.name : typeof error });
    const failure = error instanceof ComposioProviderError ? error : classifyComposioFailure({ error, timeout: controller.signal.aborted });
    // Never return/cache a successful empty catalogue on a failed later page,
    // and never expose an upstream response body through API error logging.
    throw new ComposioProviderError('The Composio toolkit catalogue could not be fully loaded.', { code: failure.code, retryable: failure.retryable,
      ...(failure.upstreamStatus !== undefined ? { upstreamStatus: failure.upstreamStatus } : {}),
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) });
  } finally { clearTimeout(timer); }

}

export async function getAvailableToolkits(context: ResolvedComposioContext): Promise<ToolkitInfo[]> {
  const now = Date.now();
  const cacheKey = `local:${composioContextCacheKey(context)}`;
  const cachedToolkits = toolkitCache.get(cacheKey);
  if (cachedToolkits && cachedToolkits.expires > now) {
    return cachedToolkits.data;
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) return [];

  try {
    const [rawItems, connectedAccounts] = await Promise.all([
      getAvailableToolkitsRaw(context),
      getConnectedAccounts({}, context),
    ]);

    console.log('[Composio] Processed toolkit catalog', {
      operation: 'connectedAccounts.list',
      toolkitCount: rawItems.length,
      connectedAccountCount: connectedAccounts.length,
    });

    const connectedBySlug = new Map<string, Record<string, unknown>>();
    for (const a of connectedAccounts) {
      const acc = a as Record<string, unknown>;
      const slug = (acc.toolkit as Record<string, unknown> | undefined)?.slug;
      if (typeof slug === 'string') {
        const existing = connectedBySlug.get(slug);
        const statusPriority: Record<string, number> = { ACTIVE: 3, INITIATED: 2, INITIALIZING: 1, EXPIRED: 0 };
        const existingPriority = statusPriority[String(existing?.status)] ?? -1;
        const newPriority = statusPriority[String(acc.status)] ?? -1;
        if (!existing || newPriority > existingPriority) {
          connectedBySlug.set(slug, acc);
        }
      }
    }

    const toolkits: ToolkitInfo[] = rawItems
      .map((item) => {
        const t = item as Record<string, unknown>;
        const meta = (t.meta ?? {}) as Record<string, unknown>;
        const slug = String(t.slug ?? '');
        const account = connectedBySlug.get(slug);

        const access = resolveComposioToolkitAccess(t, account?.status === 'ACTIVE');

        return {
          slug,
          name: String(t.name ?? slug),
          logo: String(meta.logo ?? t.logo ?? ''),
          description: String(meta.description ?? t.description ?? ''),
          toolsCount: Number(meta.toolsCount ?? 0),
          noAuth: access.noAuth,
          connected: access.ready,
          connectedAccountId: typeof account?.id === 'string' ? account.id : undefined,
          connectedAccountStatus: typeof account?.status === 'string' ? account.status : undefined,
        };
      })
      .filter((tk) => !HIDDEN_TOOLKIT_SLUGS.has(tk.slug));

    toolkitCache.set(cacheKey, { data: toolkits, expires: now + CACHE_TTL_MS });
    return toolkits;
  } catch (error) {
    console.error('[Composio] Failed to fetch toolkits', { operation: 'toolkits.list', errorType: error instanceof Error ? error.name : typeof error });
    const failure = error instanceof ComposioProviderError ? error : classifyComposioFailure({ error });
    throw new ComposioProviderError('The Composio toolkit catalogue could not be fully loaded.', { code: failure.code, retryable: failure.retryable,
      ...(failure.upstreamStatus !== undefined ? { upstreamStatus: failure.upstreamStatus } : {}),
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) });
  }
}

export async function getToolkitTools(toolkitSlug: string, context: ResolvedComposioContext): Promise<ToolkitToolInfo[]> {
  cleanupExpiredToolsEntries();

  const now = Date.now();
  const cacheKey = `${storageScopeCacheKey(context)}:${toolkitSlug}`;
  const cached = toolsCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.data;
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const results = await composio.tools.getRawComposioTools({
      search: '',
      toolkits: [toolkitSlug],
    } as Parameters<typeof composio.tools.getRawComposioTools>[0], undefined, { signal: controller.signal }).finally(() => clearTimeout(timer));

    const toolList = Array.isArray(results) ? results : [];
    const tools: ToolkitToolInfo[] = toolList.map((tool: Record<string, unknown>) => {
      const toolkit = (tool.toolkit ?? {}) as Record<string, unknown>;
      return {
        slug: String(tool.slug ?? tool.name ?? ''),
        name: String(tool.name ?? tool.slug ?? ''),
        description: typeof tool.description === 'string' ? tool.description : '',
        toolkit: String(toolkit.slug ?? tool.toolkitSlug ?? ''),
      };
    });

    toolsCache.set(cacheKey, { data: tools, expires: now + CACHE_TTL_MS });
    return tools;
  } catch (error) {
    console.error('[Composio] Failed to fetch tools for toolkit', { operation: 'tools.getRawComposioTools', toolkit: toolkitSlug, errorType: error instanceof Error ? error.name : typeof error });
    return [];
  }
}

export function clearToolkitCache(): void {
  toolkitCache.clear();
  rawToolkitCache.clear();
  toolsCache.clear();
}
