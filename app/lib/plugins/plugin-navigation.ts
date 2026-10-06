export const PLUGIN_VIEWS = ['discover', 'installed', 'updates', 'drafts', 'advanced'] as const;
export const SKILL_VIEWS = ['installed', 'library', 'updates', 'drafts'] as const;
export const PLUGIN_DETAIL_TASKS = ['overview', 'connections', 'sharing', 'content', 'versions', 'advanced'] as const;

export type PluginArea = 'plugins' | 'skills';
export type PluginView = typeof PLUGIN_VIEWS[number];
export type SkillView = typeof SKILL_VIEWS[number];
/** Browsing ownership is independent from the physical storage or creation permission. */
export type PluginManagementScope = 'user' | 'team' | 'organization';
export const PLUGIN_CONNECTION_FILTERS = ['composio', 'email', 'mcp', 'none'] as const;
export const PLUGIN_READINESS_FILTERS = ['available', 'disabled', 'blocked', 'conflict', 'personal-connection-required'] as const;
const FILTER_KEYS = ['q', 'page', 'category', 'connection', 'readiness', 'enabled'] as const;

export type PluginNavigation = {
  area: PluginArea;
  view: PluginView | SkillView;
  scope: PluginManagementScope;
  teamId?: string;
  audience?: 'own' | 'shared';
  plugin?: string;
  skill?: string;
  source?: 'store' | 'installed';
  resourceId?: string;
  resourceRef?: string;
  draftRef?: string;
  task?: typeof PLUGIN_DETAIL_TASKS[number];
  file?: string;
  workspaceId?: string;
  q?: string;
  page?: number;
  category?: string;
  connection?: typeof PLUGIN_CONNECTION_FILTERS[number];
  readiness?: typeof PLUGIN_READINESS_FILTERS[number];
  enabled?: 'enabled' | 'disabled';
};

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const RESOURCE_REF = new RegExp(`^canvas-resource:${UUID}$`, 'u');
const DRAFT_REF = new RegExp(`^canvas-package-draft:${UUID}$`, 'u');
const LEGACY_RESOURCE_REF = /^canvas-capability:v1:(?:plugin|skill):(?:system|(?:org|user):[a-z0-9_.%~-]+):(?:core|standalone|plugin:[a-z0-9_.%~-]+):[a-z0-9_.%~-]+$/iu;
const DETAIL_KEYS = ['plugin', 'skill', 'source', 'resourceId', 'resourceRef', 'draftRef', 'task', 'file'] as const;

/** URL identity is a selection only; the server resolves current access for every read/write. */
export function isPluginNavigationResourceRef(value: string): boolean {
  return value.length <= 2_048 && (RESOURCE_REF.test(value) || LEGACY_RESOURCE_REF.test(value))
    && !/%(?![a-f0-9]{2})/iu.test(value);
}

export function readPluginNavigation(params: Pick<URLSearchParams, 'get'>): PluginNavigation {
  const area = params.get('area') === 'skills' ? 'skills' : 'plugins';
  const requestedView = params.get('view');
  const allowedViews: readonly string[] = area === 'skills' ? SKILL_VIEWS : PLUGIN_VIEWS;
  const view = requestedView && allowedViews.includes(requestedView)
    ? requestedView as PluginNavigation['view']
    : area === 'skills' ? 'installed' : 'discover';
  const requestedScope = params.get('scope');
  const scope = requestedScope === 'organization' || requestedScope === 'team' ? requestedScope : 'user';
  const navigation: PluginNavigation = { area, view, scope };
  const teamId = params.get('teamId');
  if (scope === 'team' && teamId && teamId.length <= 256 && teamId === teamId.trim() && !/[\u0000-\u001f\u007f]/u.test(teamId)) navigation.teamId = teamId;
  const audience = params.get('audience');
  if (scope === 'user' && (audience === 'own' || audience === 'shared')) navigation.audience = audience;
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
    if (navigation.source === 'installed' && resourceId && resourceId.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(resourceId)) navigation.resourceId = resourceId;
  }
  const skill = params.get('skill');
  if (area === 'skills' && skill && Array.from(skill).length <= 64 && skill === skill.trim().normalize('NFKC').toLowerCase()
    && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(skill)) navigation.skill = skill;
  const resourceRef = params.get('resourceRef');
  if (resourceRef && isPluginNavigationResourceRef(resourceRef) && navigation.source !== 'store') navigation.resourceRef = resourceRef;
  const draftRef = params.get('draftRef');
  if (view === 'drafts' && draftRef && DRAFT_REF.test(draftRef)) navigation.draftRef = draftRef;
  if (navigation.plugin || navigation.skill || navigation.resourceRef || navigation.draftRef) {
    const task = params.get('task');
    if (task && (PLUGIN_DETAIL_TASKS as readonly string[]).includes(task)) navigation.task = task as PluginNavigation['task'];
    const file = params.get('file');
    if (navigation.task === 'content' && file && file.length <= 1_024 && !/^[A-Za-z]:|[\\\u0000-\u001f\u007f]/u.test(file)
      && file.split('/').every(part => part && part !== '.' && part !== '..')) navigation.file = file;
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
    params.delete('audience');
    params.delete('teamId');
  } else if ((patch.area && patch.area !== current.area) || (patch.view && patch.view !== current.view)) {
    params.delete('page');
    const nextView = patch.view || (patch.area === 'skills' ? 'installed' : 'discover');
    if (patch.area && patch.area !== current.area) {
      for (const key of ['category', 'connection', 'readiness', 'enabled']) params.delete(key);
    } else if (nextView === 'installed') {
      params.delete('category'); params.delete('connection');
    } else if (nextView === 'discover' || nextView === 'updates') {
      params.delete('readiness'); params.delete('enabled');
    } else if (nextView === 'advanced' || nextView === 'drafts') {
      for (const key of FILTER_KEYS) params.delete(key);
    }
  }
  if (FILTER_KEYS.some((key) => key !== 'page' && key in patch)) params.delete('page');
  if ((patch.area && patch.area !== current.area) || (patch.view && patch.view !== current.view) || (patch.scope && patch.scope !== current.scope)
    || ('teamId' in patch && patch.teamId !== current.teamId) || ('audience' in patch && patch.audience !== current.audience)) {
    for (const key of DETAIL_KEYS) params.delete(key);
  }
  if (('resourceRef' in patch && patch.resourceRef !== current.resourceRef) || ('plugin' in patch && patch.plugin !== current.plugin)
    || ('skill' in patch && patch.skill !== current.skill) || ('draftRef' in patch && patch.draftRef !== current.draftRef)) {
    for (const key of ['task', 'file']) params.delete(key);
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
  for (const key of ['teamId', 'audience', 'skill', 'resourceRef', 'draftRef', 'task', 'file'] as const) {
    if (next[key] === undefined) params.delete(key);
    else params.set(key, next[key]);
  }
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
  for (const key of ['view', 'scope', 'teamId', 'audience', 'plugin', 'skill', 'source', 'resourceId', 'resourceRef', 'draftRef', 'task', 'file', 'workspaceId', ...FILTER_KEYS] as const) {
    const value = params[key];
    if (typeof value === 'string') query.set(key, value);
  }
  query.set('area', tab === 'skills' ? 'skills' : 'plugins');
  return updatePluginNavigation(query.toString(), {});
}
