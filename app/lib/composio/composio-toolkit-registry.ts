import 'server-only';

import { getComposio } from './composio-client';
import { getConnectedAccounts } from './composio-auth';

export interface ToolkitInfo {
  slug: string;
  name: string;
  logo: string;
  description: string;
  toolsCount: number;
  isNoAuth: boolean;
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
const toolsCache = new Map<string, { data: ToolkitToolInfo[]; expires: number }>();

export async function getAvailableToolkits(): Promise<ToolkitInfo[]> {
  const now = Date.now();
  if (toolkitCache && toolkitCache.expires > now) {
    return toolkitCache.data;
  }

  const composio = await getComposio();
  if (!composio) return [];

  try {
    const response = await composio.toolkits.get({});
    const rawItems = 'items' in response ? (response as { items: unknown[] }).items : Array.isArray(response) ? response : [];
    const connectedAccounts = await getConnectedAccounts();
    const connectedBySlug = new Map(
      connectedAccounts.map((a) => [a.toolkit?.slug ?? '', a])
    );

    const toolkits: ToolkitInfo[] = rawItems
      .map((item) => {
        const t = item as Record<string, unknown>;
        const meta = (t.meta ?? {}) as Record<string, unknown>;
        const slug = String(t.slug ?? '');
        const account = connectedBySlug.get(slug);
        return {
          slug,
          name: String(t.name ?? slug),
          logo: String(meta.logo ?? t.logo ?? ''),
          description: String(meta.description ?? t.description ?? ''),
          toolsCount: Number(meta.toolsCount ?? 0),
          isNoAuth: Boolean(t.noAuth ?? t.isNoAuth ?? false),
          connected: account?.status === 'ACTIVE',
          connectedAccountId: account?.id,
          connectedAccountStatus: account?.status,
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
  toolsCache.clear();
}