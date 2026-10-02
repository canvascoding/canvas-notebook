export const PLUGIN_VIEWS = ['discover', 'installed', 'updates', 'advanced'] as const;
export const SKILL_VIEWS = ['installed', 'library', 'updates'] as const;

export type PluginArea = 'plugins' | 'skills';
export type PluginView = typeof PLUGIN_VIEWS[number];
export type SkillView = typeof SKILL_VIEWS[number];
export type PluginManagementScope = 'user' | 'organization';

export type PluginNavigation = {
  area: PluginArea;
  view: PluginView | SkillView;
  scope: PluginManagementScope;
  plugin?: string;
  source?: 'store' | 'installed';
  resourceId?: string;
  workspaceId?: string;
};

export function readPluginNavigation(params: Pick<URLSearchParams, 'get'>): PluginNavigation {
  const area = params.get('area') === 'skills' ? 'skills' : 'plugins';
  const requestedView = params.get('view');
  const allowedViews: readonly string[] = area === 'skills' ? SKILL_VIEWS : PLUGIN_VIEWS;
  const view = requestedView && allowedViews.includes(requestedView)
    ? requestedView as PluginNavigation['view']
    : area === 'skills' ? 'installed' : 'discover';
  const navigation: PluginNavigation = { area, view, scope: params.get('scope') === 'organization' ? 'organization' : 'user' };
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
  if ((patch.area && patch.area !== current.area) || (patch.view && patch.view !== current.view) || (patch.scope && patch.scope !== current.scope)) {
    for (const key of ['plugin', 'source', 'resourceId']) params.delete(key);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const next = readPluginNavigation(params);
  if (next.area === 'plugins') params.delete('area');
  else params.set('area', next.area);
  params.set('view', next.view);
  if (next.scope === 'user') params.delete('scope');
  else params.set('scope', next.scope);
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
  for (const key of ['view', 'scope', 'q'] as const) {
    const value = params[key];
    if (typeof value === 'string') query.set(key, value);
  }
  query.set('area', tab === 'skills' ? 'skills' : 'plugins');
  return updatePluginNavigation(query.toString(), {});
}
