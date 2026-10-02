export const PLUGIN_VIEWS = ['discover', 'installed', 'updates', 'advanced'] as const;
export const SKILL_VIEWS = ['installed', 'library', 'updates'] as const;

export type PluginArea = 'plugins' | 'skills';
export type PluginView = typeof PLUGIN_VIEWS[number];
export type SkillView = typeof SKILL_VIEWS[number];
export type PluginManagementScope = 'user' | 'organization';
export const PLUGIN_CONNECTION_FILTERS = ['composio', 'email', 'mcp', 'none'] as const;
export const PLUGIN_READINESS_FILTERS = ['available', 'disabled', 'blocked', 'conflict', 'personal-connection-required'] as const;
const FILTER_KEYS = ['q', 'page', 'category', 'connection', 'readiness', 'enabled'] as const;

export type PluginNavigation = {
  area: PluginArea;
  view: PluginView | SkillView;
  scope: PluginManagementScope;
  plugin?: string;
  source?: 'store' | 'installed';
  resourceId?: string;
  workspaceId?: string;
  q?: string;
  page?: number;
  category?: string;
  connection?: typeof PLUGIN_CONNECTION_FILTERS[number];
  readiness?: typeof PLUGIN_READINESS_FILTERS[number];
  enabled?: 'enabled' | 'disabled';
};

export function readPluginNavigation(params: Pick<URLSearchParams, 'get'>): PluginNavigation {
  const area = params.get('area') === 'skills' ? 'skills' : 'plugins';
  const requestedView = params.get('view');
  const allowedViews: readonly string[] = area === 'skills' ? SKILL_VIEWS : PLUGIN_VIEWS;
  const view = requestedView && allowedViews.includes(requestedView)
    ? requestedView as PluginNavigation['view']
    : area === 'skills' ? 'installed' : 'discover';
  const navigation: PluginNavigation = { area, view, scope: params.get('scope') === 'organization' ? 'organization' : 'user' };
  const q = params.get('q');
  if (q) navigation.q = q.slice(0, 512);
  const page = Number(params.get('page'));
  if (Number.isInteger(page) && page > 1 && page <= 100000) navigation.page = page;
  const category = params.get('category')?.trim();
  if (category && category.length <= 128) navigation.category = category;
  const connection = params.get('connection');
  if (connection && (PLUGIN_CONNECTION_FILTERS as readonly string[]).includes(connection)) navigation.connection = connection as PluginNavigation['connection'];
  const readiness = params.get('readiness');
  if (readiness && (PLUGIN_READINESS_FILTERS as readonly string[]).includes(readiness)) navigation.readiness = readiness as PluginNavigation['readiness'];
  const enabled = params.get('enabled');
  if (enabled === 'enabled' || enabled === 'disabled') navigation.enabled = enabled;
  const plugin = params.get('plugin');
  if (area === 'plugins' && plugin && /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(plugin)) {
    navigation.plugin = plugin;
    navigation.source = params.get('source') === 'installed' ? 'installed' : 'store';
    const resourceId = params.get('resourceId');
    if (navigation.source === 'installed' && resourceId && resourceId.length <= 512) navigation.resourceId = resourceId;
  }
  const workspaceId = params.get('workspaceId');
  if (workspaceId && workspaceId.length <= 256) navigation.workspaceId = workspaceId;
  return navigation;
}

export function updatePluginNavigation(search: string, patch: Partial<PluginNavigation>): string {
  const params = new URLSearchParams(search);
  const current = readPluginNavigation(params);
  if (patch.area && patch.area !== current.area) params.delete('view');
  if (patch.scope && patch.scope !== current.scope) {
    for (const key of FILTER_KEYS) params.delete(key);
  } else if ((patch.area && patch.area !== current.area) || (patch.view && patch.view !== current.view)) {
    params.delete('page');
    const nextView = patch.view || (patch.area === 'skills' ? 'installed' : 'discover');
    if (patch.area && patch.area !== current.area) {
      for (const key of ['category', 'connection', 'readiness', 'enabled']) params.delete(key);
    } else if (nextView === 'installed') {
      params.delete('category'); params.delete('connection');
    } else if (nextView === 'discover' || nextView === 'updates') {
      params.delete('readiness'); params.delete('enabled');
    } else if (nextView === 'advanced') {
      for (const key of FILTER_KEYS) params.delete(key);
    }
  }
  if (FILTER_KEYS.some((key) => key !== 'page' && key in patch)) params.delete('page');
  if ((patch.area && patch.area !== current.area) || (patch.view && patch.view !== current.view) || (patch.scope && patch.scope !== current.scope)) {
    for (const key of ['plugin', 'source', 'resourceId']) params.delete(key);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) params.delete(key);
    else params.set(key, String(value));
  }
  const next = readPluginNavigation(params);
  if (next.area === 'plugins') params.delete('area');
  else params.set('area', next.area);
  params.set('view', next.view);
  if (next.scope === 'user') params.delete('scope');
  else params.set('scope', next.scope);
  for (const key of FILTER_KEYS) {
    const value = next[key];
    if (value === undefined) params.delete(key);
    else params.set(key, String(value));
  }
  if (!next.plugin) {
    for (const key of ['plugin', 'source', 'resourceId']) params.delete(key);
  } else {
    params.set('plugin', next.plugin);
    params.set('source', next.source!);
    if (next.source !== 'installed') params.delete('resourceId');
  }
  return `/plugins?${params}`;
}

export function legacyPluginSettingsHref(params: Record<string, string | string[] | undefined>): string | null {
  const tab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  if (tab !== 'plugins' && tab !== 'skills') return null;
  const query = new URLSearchParams();
  for (const key of ['view', 'scope', ...FILTER_KEYS] as const) {
    const value = params[key];
    if (typeof value === 'string') query.set(key, value);
  }
  query.set('area', tab === 'skills' ? 'skills' : 'plugins');
  return updatePluginNavigation(query.toString(), {});
}
