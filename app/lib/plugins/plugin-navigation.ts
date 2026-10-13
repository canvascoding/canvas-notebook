export const PLUGIN_VIEWS = ['browse', 'discover', 'installed', 'updates', 'drafts', 'advanced'] as const;
export const SKILL_VIEWS = ['browse', 'installed', 'library', 'updates', 'drafts'] as const;
export const PLUGIN_DETAIL_TASKS = ['overview', 'connections', 'sharing', 'content', 'versions', 'advanced'] as const;

export type PluginArea = 'plugins' | 'skills';
export type PluginView = typeof PLUGIN_VIEWS[number];
export type SkillView = typeof SKILL_VIEWS[number];
/** Browsing ownership is independent from the physical storage or creation permission. */
export type PluginManagementScope = 'user' | 'team' | 'organization' | 'system' | 'all';
export const PLUGIN_CONNECTION_FILTERS = ['composio', 'email', 'mcp', 'none'] as const;
export const PLUGIN_READINESS_FILTERS = ['available', 'disabled', 'blocked', 'conflict', 'personal-connection-required'] as const;
const FILTER_KEYS = ['q', 'page', 'category', 'connection', 'readiness', 'enabled'] as const;

export type PluginNavigation = {
  area: PluginArea;
  view: PluginView | SkillView;
  scope: PluginManagementScope;
  kind?: 'all' | 'plugin' | 'skill' | 'integration' | 'mcp';
  stock?: 'all' | 'installed' | 'available';
  extensionSource?: 'all' | 'store' | 'composio' | 'mcp';
  extensionId?: string;
  extensionCursor?: string;
  setup?: 'mcp';
  teamId?: string;
  audience?: 'own' | 'shared';
  plugin?: string;
  skill?: string;
  source?: 'store' | 'installed';
  storeRegistryId?: string;
  storeVersion?: string;
  storeChecksum?: string;
  resourceId?: string;
  resourceRef?: string;
  draftRef?: string;
  task?: typeof PLUGIN_DETAIL_TASKS[number];
  file?: string;
  workspaceId?: string;
  connectionRef?: string;
  sharedOAuth?: 'connected' | 'cancelled' | 'failed';
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
const DETAIL_KEYS = ['plugin', 'skill', 'source', 'storeRegistryId', 'storeVersion', 'storeChecksum', 'resourceId', 'resourceRef', 'draftRef', 'task', 'file', 'connectionRef', 'sharedOAuth', 'extensionId', 'setup'] as const;

/** URL identity is a selection only; the server resolves current access for every read/write. */
export function isPluginNavigationResourceRef(value: string): boolean {
  return value.length <= 2_048 && (RESOURCE_REF.test(value) || LEGACY_RESOURCE_REF.test(value))
    && !/%(?![a-f0-9]{2})/iu.test(value);
}

export function readPluginNavigation(params: Pick<URLSearchParams, 'get'>): PluginNavigation {
  const area = params.get('area') === 'skills' ? 'skills' : 'plugins';
  const requestedView = params.get('view');
  const legacyStoreDetail = area === 'plugins' ? Boolean(params.get('plugin') && params.get('source') !== 'installed' && !params.get('resourceRef'))
    : Boolean(params.get('skill') && params.get('source') === 'store');
  const allowedViews: readonly string[] = area === 'skills' ? SKILL_VIEWS : PLUGIN_VIEWS;
  const view = requestedView && allowedViews.includes(requestedView)
    ? requestedView as PluginNavigation['view']
    : legacyStoreDetail ? area === 'skills' ? 'library' : 'discover'
      : requestedView || area === 'skills' || params.get('source') === 'installed' ? 'installed' : 'browse';
  const requestedScope = params.get('scope');
  const scope = requestedScope === 'user' || requestedScope === 'organization' || requestedScope === 'team' || requestedScope === 'system' || requestedScope === 'all' ? requestedScope : view === 'browse' ? 'all' : 'user';
  const navigation: PluginNavigation = { area, view, scope };
  const kind = params.get('kind');
  if (kind === 'all' || kind === 'plugin' || kind === 'skill' || kind === 'integration' || kind === 'mcp') navigation.kind = kind;
  const stock = params.get('stock'), extensionSource = params.get('extensionSource');
  if (stock === 'all' || stock === 'installed' || stock === 'available') navigation.stock = stock;
  if (extensionSource === 'all' || extensionSource === 'store' || extensionSource === 'composio' || extensionSource === 'mcp') navigation.extensionSource = extensionSource;
  const extensionId = params.get('extensionId'), extensionCursor = params.get('extensionCursor');
  // These values select current catalog rows; no personal account or profile may be encoded here.
  if (extensionId && extensionId.length <= 4096 && extensionId === extensionId.trim() && !/[\p{Cc}\\]/u.test(extensionId)
    && /^(?:composio:[a-z0-9][a-z0-9_-]{0,127}|mcp-(?:personal|definition):[^:]+|canvas-connection:[a-f0-9-]+|canvas-resource:[a-f0-9-]+|store:(?:plugin|skill):.+)$/u.test(extensionId)) navigation.extensionId = extensionId;
  if (extensionCursor && /^[a-zA-Z0-9_-]{1,8192}$/u.test(extensionCursor)) navigation.extensionCursor = extensionCursor;
  if (params.get('setup') === 'mcp') navigation.setup = 'mcp';
  const teamId = params.get('teamId');
  if (scope === 'team' && teamId && teamId.length <= 256 && teamId === teamId.trim() && !/[\u0000-\u001f\u007f]/u.test(teamId)) navigation.teamId = teamId;
  const audience = params.get('audience');
  if (scope === 'user' && (audience === 'own' || audience === 'shared')) navigation.audience = audience;
  const q = params.get('q');
  if (q && !/[\p{Cc}]/u.test(q)) navigation.q = q.slice(0, 512);
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
    navigation.source = params.get('source') === 'installed' || params.get('source') !== 'store' && (view === 'installed' || view === 'updates') ? 'installed' : 'store';
    const resourceId = params.get('resourceId');
    if (navigation.source === 'installed' && resourceId && resourceId.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(resourceId)) navigation.resourceId = resourceId;
  }
  const skill = params.get('skill');
  if (area === 'skills' && skill && Array.from(skill).length <= 64 && skill === skill.trim().normalize('NFKC').toLowerCase()
    && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(skill)) {
    navigation.skill = skill;
    navigation.source = params.get('source') === 'store' || params.get('source') !== 'installed' && view === 'library' ? 'store' : 'installed';
  }
  if (navigation.source === 'store') {
    const registry = params.get('storeRegistryId'), version = params.get('storeVersion'), checksum = params.get('storeChecksum');
    if (registry && registry.length <= 256 && registry === registry.trim() && !/[\u0000-\u001f\u007f]/u.test(registry)) navigation.storeRegistryId = registry;
    if (version && version.length <= 200 && version === version.trim() && !/[\u0000-\u001f\u007f]/u.test(version)) navigation.storeVersion = version;
    if (checksum && /^[a-f0-9]{64}$/u.test(checksum)) navigation.storeChecksum = checksum;
  }
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
  if ((view === 'browse' || area === 'plugins' && view === 'advanced') && navigation.workspaceId && navigation.workspaceId === navigation.workspaceId.trim()
    && !/[\\\u0000-\u001f\u007f]/u.test(navigation.workspaceId) && (view === 'browse' || scope === 'organization' || scope === 'team' && navigation.teamId)) {
    const connectionRef = params.get('connectionRef');
    if (connectionRef && new RegExp(`^canvas-connection:${UUID}$`, 'u').test(connectionRef)) {
      navigation.connectionRef = connectionRef;
      const result = params.get('sharedOAuth');
      if (result === 'connected' || result === 'cancelled' || result === 'failed') navigation.sharedOAuth = result;
    }
  }
  return navigation;
}

export function updatePluginNavigation(search: string, patch: Partial<PluginNavigation>): string {
  const params = new URLSearchParams(search);
  const current = readPluginNavigation(params);
  if ('workspaceId' in patch && patch.workspaceId !== current.workspaceId) { params.delete('connectionRef'); params.delete('sharedOAuth'); }
  const browse = current.view === 'browse' || patch.view === 'browse';
  if (patch.area && patch.area !== current.area && !browse) { params.delete('view'); params.delete('kind'); }
  if (patch.scope && patch.scope !== current.scope) {
    for (const key of FILTER_KEYS) if (key !== 'q') params.delete(key);
    params.delete('audience');
    params.delete('teamId');
  } else if ((!browse && patch.area && patch.area !== current.area) || (patch.view && patch.view !== current.view)) {
    params.delete('page');
    const nextView = patch.view || 'installed';
    if (patch.area && patch.area !== current.area) {
      for (const key of ['category', 'connection', 'readiness', 'enabled']) params.delete(key);
    } else if (nextView === 'installed') {
      params.delete('category'); params.delete('connection');
    } else if (nextView === 'discover' || nextView === 'updates') {
      params.delete('readiness'); params.delete('enabled');
    } else if (nextView === 'advanced' || nextView === 'drafts') {
      for (const key of FILTER_KEYS) if (key !== 'q') params.delete(key);
    }
  }
  if (FILTER_KEYS.some((key) => key !== 'page' && key in patch) || ['kind', 'stock', 'extensionSource', 'scope', 'teamId', 'audience'].some(key => key in patch)) {
    params.delete('page'); params.delete('extensionCursor');
  }
  if ((patch.area && patch.area !== current.area) || (patch.view && patch.view !== current.view) || (patch.scope && patch.scope !== current.scope)
    || ('teamId' in patch && patch.teamId !== current.teamId) || ('audience' in patch && patch.audience !== current.audience)
    || ('kind' in patch && patch.kind !== current.kind) || ('q' in patch && patch.q !== current.q)
    || ('stock' in patch && patch.stock !== current.stock) || ('extensionSource' in patch && patch.extensionSource !== current.extensionSource)) {
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
  if (!browse && patch.area && patch.area !== current.area && !params.has('view')) params.set('view', 'installed');
  const next = readPluginNavigation(params);
  if (next.area === 'plugins') params.delete('area');
  else params.set('area', next.area);
  params.set('view', next.view);
  if (next.scope === (next.view === 'browse' ? 'all' : 'user')) params.delete('scope');
  else params.set('scope', next.scope);
  for (const key of ['teamId', 'audience', 'kind', 'skill', 'resourceRef', 'draftRef', 'task', 'file', 'storeRegistryId', 'storeVersion', 'storeChecksum', 'connectionRef', 'sharedOAuth', 'stock', 'extensionSource', 'extensionId', 'extensionCursor', 'setup'] as const) {
    if (next[key] === undefined) params.delete(key);
    else params.set(key, next[key]);
  }
  for (const key of FILTER_KEYS) {
    const value = next[key];
    if (value === undefined) params.delete(key);
    else params.set(key, String(value));
  }
  if (!next.plugin) {
    params.delete('plugin'); params.delete('resourceId');
    if (!next.skill) params.delete('source');
    else params.set('source', next.source!);
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
  for (const key of ['view', 'scope', 'teamId', 'audience', 'kind', 'plugin', 'skill', 'source', 'storeRegistryId', 'storeVersion', 'storeChecksum', 'resourceId', 'resourceRef', 'draftRef', 'task', 'file', 'workspaceId', ...FILTER_KEYS] as const) {
    const value = params[key];
    if (typeof value === 'string') query.set(key, value);
  }
  query.set('area', tab === 'skills' ? 'skills' : 'plugins');
  if (!query.has('view') && !query.has('plugin') && !query.has('skill')) query.set('view', 'installed');
  return updatePluginNavigation(query.toString(), {});
}
