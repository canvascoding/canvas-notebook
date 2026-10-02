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
};

export function readPluginNavigation(params: Pick<URLSearchParams, 'get'>): PluginNavigation {
  const area = params.get('area') === 'skills' ? 'skills' : 'plugins';
  const requestedView = params.get('view');
  const allowedViews: readonly string[] = area === 'skills' ? SKILL_VIEWS : PLUGIN_VIEWS;
  const view = requestedView && allowedViews.includes(requestedView)
    ? requestedView as PluginNavigation['view']
    : area === 'skills' ? 'installed' : 'discover';
  return { area, view, scope: params.get('scope') === 'organization' ? 'organization' : 'user' };
}

export function updatePluginNavigation(search: string, patch: Partial<PluginNavigation>): string {
  const params = new URLSearchParams(search);
  const current = readPluginNavigation(params);
  if (patch.area && patch.area !== current.area) params.delete('view');
  for (const [key, value] of Object.entries(patch)) params.set(key, value);
  const next = readPluginNavigation(params);
  if (next.area === 'plugins') params.delete('area');
  else params.set('area', next.area);
  params.set('view', next.view);
  if (next.scope === 'user') params.delete('scope');
  else params.set('scope', next.scope);
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
