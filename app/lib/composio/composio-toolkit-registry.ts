import 'server-only';

import { getComposio } from './composio-client';
import { getConnectedAccounts } from './composio-auth';

export interface ToolkitInfo {
  slug: string;
  name: string;
  logo: string;
  description: string;
  toolsCount: number;
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

const HIDDEN_TOOLKIT_SLUGS = new Set([
  'gemini',
  'google_veo',
  'nano_banana',
  'openai',
  'anthropic',
  'google',
]);

let toolkitCache: { data: ToolkitInfo[]; expires: number } | null = null;
let rawToolkitCache: { data: unknown[]; expires: number } | null = null;
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

export async function getAvailableToolkitsRaw(): Promise<unknown[]> {
  const now = Date.now();
  if (rawToolkitCache && rawToolkitCache.expires > now) {
    return rawToolkitCache.data;
  }

  const composio = await getComposio();
  if (!composio) return [];

  try {
    const response = await composio.toolkits.get({});
    const rawItems = 'items' in response ? (response as { items: unknown[] }).items : Array.isArray(response) ? response : [];
    console.log(`[Composio] Fetched ${rawItems.length} raw toolkits`);
    rawToolkitCache = { data: rawItems, expires: now + CACHE_TTL_MS };
    return rawItems;
  } catch (error) {
    console.error('[Composio] Failed to fetch raw toolkits:', error);
    return [];
  }
}

export async function getAvailableToolkits(): Promise<ToolkitInfo[]> {
  const now = Date.now();
  if (toolkitCache && toolkitCache.expires > now) {
    return toolkitCache.data;
  }

  const composio = await getComposio();
  if (!composio) return [];

  try {
    const [rawItems, connectedAccounts] = await Promise.all([
      getAvailableToolkitsRaw(),
      getConnectedAccounts(),
    ]);

    console.log(`[Composio] Processing ${rawItems.length} toolkits, ${connectedAccounts.length} connected accounts`);
    if (connectedAccounts.length > 0) {
      for (const a of connectedAccounts) {
        const acc = a as Record<string, unknown>;
        const slug = (acc.toolkit as Record<string, unknown> | undefined)?.slug;
        console.log(`[Composio] Connected account: slug=${slug}, status=${acc.status}, id=${acc.id}`);
      }
    }

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

        const hasActiveConnection = account?.status === 'ACTIVE';

        return {
          slug,
          name: String(t.name ?? slug),
          logo: String(meta.logo ?? t.logo ?? ''),
          description: String(meta.description ?? t.description ?? ''),
          toolsCount: Number(meta.toolsCount ?? 0),
          connected: hasActiveConnection,
          connectedAccountId: typeof account?.id === 'string' ? account.id : undefined,
          connectedAccountStatus: typeof account?.status === 'string' ? account.status : undefined,
        };
      })
      .filter((tk) => !HIDDEN_TOOLKIT_SLUGS.has(tk.slug));

    toolkitCache = { data: toolkits, expires: now + CACHE_TTL_MS };
    return toolkits;
  } catch (error) {
    console.error('[Composio] Failed to fetch toolkits:', error);
    return [];
  }
}

export async function getToolkitTools(toolkitSlug: string): Promise<ToolkitToolInfo[]> {
  cleanupExpiredToolsEntries();

  const now = Date.now();
  const cached = toolsCache.get(toolkitSlug);
  if (cached && cached.expires > now) {
    return cached.data;
  }

  const composio = await getComposio();
  if (!composio) return [];

  try {
    const results = await composio.tools.getRawComposioTools({
      search: '',
      toolkits: [toolkitSlug],
    } as Parameters<typeof composio.tools.getRawComposioTools>[0]);

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

    toolsCache.set(toolkitSlug, { data: tools, expires: now + CACHE_TTL_MS });
    return tools;
  } catch (error) {
    console.error('[Composio] Failed to fetch tools for toolkit:', toolkitSlug, error);
    return [];
  }
}

export function clearToolkitCache(): void {
  toolkitCache = null;
  rawToolkitCache = null;
  toolsCache.clear();
}