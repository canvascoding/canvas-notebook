import 'server-only';

import { createHash } from 'node:crypto';
import { CapabilityResourceError, type CapabilityResourceActor, type CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import type { PluginWorkspaceCatalogResponse, PluginWorkspaceCatalogScopeContext } from './plugin-workspace-catalog-contracts';
import type { PluginExtensionCoverage, PluginExtensionItem, PluginExtensionKind, PluginExtensionQuery, PluginExtensionSearchResponse } from './plugin-extension-contracts';
import type { PluginExtensionSourceResult } from './plugin-extension-integrations';

const kinds: PluginExtensionKind[] = ['plugin', 'skill', 'integration', 'mcp'];
const invalid = (code = 'PLUGIN_SEARCH_QUERY_INVALID', message = 'The extension search request is invalid.'): never => {
  throw new CapabilityResourceError(code, message, 400);
};

export function parsePluginExtensionQuery(parameters: URLSearchParams): PluginExtensionQuery {
  const permitted = new Set(['q', 'types', 'stock', 'source', 'scope', 'audience', 'teamId', 'workspaceId', 'cursor', 'limit', 'selected']);
  for (const key of parameters.keys()) if (!permitted.has(key) || parameters.getAll(key).length !== 1) invalid();
  const q = parameters.get('q') ?? '', scope = parameters.get('scope') ?? 'all', source = parameters.get('source') ?? 'all', stock = parameters.get('stock') ?? 'all';
  const types = parameters.has('types') ? parameters.get('types')!.split(',') : kinds;
  const audience = parameters.get('audience'), teamId = parameters.get('teamId'), workspaceId = parameters.get('workspaceId'), selected = parameters.get('selected');
  const identity = (value: string | null, max = 200) => value === null || value.length > 0 && value.length <= max && value.trim() === value && !/[\p{Cc}]/u.test(value);
  if (q.length > 512 || /[\p{Cc}]/u.test(q) || !['all', 'user', 'team', 'organization', 'system'].includes(scope)
    || !['all', 'store', 'composio', 'mcp'].includes(source) || !['all', 'installed', 'available'].includes(stock)
    || !types.length || types.some(type => !kinds.includes(type as PluginExtensionKind)) || new Set(types).size !== types.length
    || audience !== null && (scope !== 'user' || !['own', 'shared'].includes(audience))
    || teamId !== null && scope !== 'team' || !identity(teamId) || !identity(workspaceId) || !identity(selected, 4096)) invalid();
  const rawLimit = parameters.get('limit') ?? '20', cursor = parameters.get('cursor');
  if (!/^[1-9]\d?$/u.test(rawLimit) || Number(rawLimit) > 50 || cursor !== null && (!/^[a-zA-Z0-9_-]{1,8192}$/u.test(cursor))) invalid();
  return { q: q.trim(), types: kinds.filter(type => types.includes(type)), stock: stock as PluginExtensionQuery['stock'], source: source as PluginExtensionQuery['source'],
    scope: scope as PluginExtensionQuery['scope'], audience: audience as PluginExtensionQuery['audience'], teamId, cursor, selected, limit: Number(rawLimit) };
}

export function pluginExtensionOwnershipMatches(owner: CapabilityResourceOwnerScope | undefined, actor: CapabilityResourceActor, query: PluginExtensionQuery): boolean {
  if (!owner || query.scope === 'all') return true;
  if (query.scope === 'user') {
    const own = owner.type === 'user' && owner.ownerUserId === actor.userId;
    return query.audience === 'own' ? own : query.audience === 'shared' ? !own && owner.type !== 'system' : own || owner.type !== 'system';
  }
  if (query.scope === 'team') return owner.type === 'team' && owner.workspaceId === query.teamId;
  return owner.type === query.scope;
}

export function selectPluginExtensionItems(items: readonly PluginExtensionItem[], actor: CapabilityResourceActor, query: PluginExtensionQuery): PluginExtensionItem[] {
  const search = query.q.toLocaleLowerCase('en-US'), selected: PluginExtensionItem[] = [];
  const packages = new Map(items.filter(item => (item.kind === 'plugin' || item.kind === 'skill') && item.package
    && item.access.canRead && pluginExtensionOwnershipMatches(item.ownership, actor, query)).map(item => [item.id, item]));
  const offerings = new Map<string, NonNullable<Extract<PluginExtensionItem, { kind: 'plugin' | 'skill' }>['offering']>>();
  for (const item of items) if ((item.kind === 'plugin' || item.kind === 'skill') && item.offering) {
    for (const ref of item.offering.installedResourceRefs) if (packages.has(ref)) offerings.set(ref, item.offering);
  }
  for (const original of items) {
    if (!original.access.canRead || !query.types.includes(original.kind)) continue;
    const item = structuredClone(original);
    if ((item.kind === 'plugin' || item.kind === 'skill') && item.package && offerings.has(item.id)) {
      item.offering = structuredClone(offerings.get(item.id)!); item.source = 'store';
    } else if ((item.kind === 'plugin' || item.kind === 'skill') && item.offering) {
      // A Store offering points at the exact readable installed instances instead
      // of presenting another "installed" row for the same package.
      const installed = item.offering.installedResourceRefs.filter(ref => packages.has(ref));
      if (installed.length && item.id !== query.selected) continue;
      item.offering.installedResourceRefs = installed;
      item.stock = installed.length ? 'installed' : 'available';
    }
    if (query.source !== 'all' && item.source !== query.source) continue;
    if (item.kind === 'integration' || item.kind === 'mcp') {
      item.connections = item.connections.filter(connection => connection.access.canRead && pluginExtensionOwnershipMatches(connection.ownership, actor, query));
      if (item.kind === 'mcp' && !pluginExtensionOwnershipMatches(item.ownership, actor, query)) continue;
      if (item.kind === 'integration') {
        item.stock = item.connections.length ? 'installed' : 'available';
        item.access.canUse = item.connections.some(connection => connection.access.canUse);
        item.access.canManage = item.connections.some(connection => connection.access.canManage);
      }
    } else if (!pluginExtensionOwnershipMatches(item.ownership, actor, query)) continue;
    if (query.stock !== 'all' && item.stock !== query.stock) continue;
    const offering = (item.kind === 'plugin' || item.kind === 'skill') ? item.offering : undefined;
    if (search && ![item.name, item.displayName, item.description, item.ownershipLabel ?? '', offering?.displayName ?? '', offering?.description ?? '']
      .some(value => value.toLocaleLowerCase('en-US').includes(search))) continue;
    selected.push(item);
  }
  const score = (item: PluginExtensionItem) => {
    if (!search) return item.kind === 'plugin' ? 0 : item.kind === 'skill' ? 1 : 2;
    const name = item.displayName.toLocaleLowerCase('en-US'), id = item.name.toLocaleLowerCase('en-US');
    return name === search || id === search ? 0 : name.startsWith(search) || id.startsWith(search) ? 1 : name.includes(search) || id.includes(search) ? 2 : 3;
  };
  return selected.sort((a, b) => score(a) - score(b) || (a.kind === 'plugin' ? 0 : 1) - (b.kind === 'plugin' ? 0 : 1)
    || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
}

type SourceContinuations = Partial<Record<'store' | 'composio', string>>;
function extensionCursorState(actor: CapabilityResourceActor, query: PluginExtensionQuery) {
  const { cursor: _cursor, selected: _selected, ...selection } = query;
  const binding = createHash('sha256').update(JSON.stringify([actor.userId, actor.workspaceId ?? null, selection])).digest('base64url');
  let offset = 0, sources: SourceContinuations = {};
  if (query.cursor) {
    try {
      const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (value.v !== 1 || value.binding !== binding || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 100000) invalid('PLUGIN_SEARCH_CURSOR_INVALID', 'The extension search selection changed. Start the search again.');
      offset = value.offset;
      if (value.sources !== undefined) {
        if (!value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)
          || Object.keys(value.sources).some(key => !['store', 'composio'].includes(key))
          || Object.values(value.sources).some(cursor => typeof cursor !== 'string' || cursor.length > 4096 || !cursor)) invalid('PLUGIN_SEARCH_CURSOR_INVALID');
        sources = value.sources;
      }
    } catch { invalid('PLUGIN_SEARCH_CURSOR_INVALID', 'The extension search cursor is invalid.'); }
  }
  return { binding, offset, sources };
}

/** Cursors carry positions, never authority. Current actor and selection are checked on every page. */
export function projectPluginExtensionPage(actor: CapabilityResourceActor, query: PluginExtensionQuery, items: readonly PluginExtensionItem[],
  scopes: PluginWorkspaceCatalogResponse['scopes'], coverage: PluginExtensionCoverage[], continuations: SourceContinuations = {}): PluginExtensionSearchResponse {
  const { binding, offset, sources } = extensionCursorState(actor, query);
  const selected = selectPluginExtensionItems(items, actor, { ...query, selected: null }), page = selected.slice(offset, offset + query.limit), next = offset + page.length;
  // The list's ownership filters must not hide a just-created, separately authorized exact selection.
  const selectedItem = query.selected ? selectPluginExtensionItems(items, actor, { ...query, q: '', types: kinds, stock: 'all', source: 'all',
    scope: 'all', audience: null, teamId: null }).find(item => item.id === query.selected) ?? null : null;
  const uniquePage = [...new Map(page.map(item => [item.id, item])).values()];
  const complete = !Object.keys(sources).length && !Object.keys(continuations).length && coverage.every(source => source.status === 'complete' || source.status === 'not_configured');
  const hasMoreLoaded = next < selected.length, hasMoreSources = Object.keys(continuations).length > 0;
  const nextCursor = hasMoreLoaded ? { v: 1, binding, offset: next, sources }
    : hasMoreSources ? { v: 1, binding, offset: 0, sources: continuations } : null;
  return { schemaVersion: 1, query, items: uniquePage, selectedItem, scopes, coverage, pagination: {
    nextCursor: nextCursor ? Buffer.from(JSON.stringify(nextCursor)).toString('base64url') : null,
    hasNextPage: Boolean(nextCursor), loadedItems: selected.length, ...(complete ? { totalItems: selected.length } : {}) } };
}

export type PluginExtensionSearchDependencies = {
  context(actor: CapabilityResourceActor): Promise<PluginWorkspaceCatalogScopeContext>;
  packages(actor: CapabilityResourceActor): Promise<PluginExtensionSourceResult & { scopes: PluginWorkspaceCatalogResponse['scopes'] }>;
  store(actor: CapabilityResourceActor, options?: { search?: string; continuation?: string; selected?: string | null }): Promise<PluginExtensionSourceResult>;
  composio(actor: CapabilityResourceActor, signal: AbortSignal, options?: { search?: string; continuation?: string; selectedSlug?: string }): Promise<PluginExtensionSourceResult>;
  mcp(actor: CapabilityResourceActor): Promise<PluginExtensionSourceResult>;
  /** Fresh authority after remote metadata IO; successful sources are not a cached authorization. */
  revalidate(actor: CapabilityResourceActor, items: PluginExtensionItem[]): Promise<PluginExtensionItem[] | { items: PluginExtensionItem[]; coverage: PluginExtensionCoverage[] }>;
};

async function defaultDependencies(): Promise<PluginExtensionSearchDependencies> {
  const { resolvePluginWorkspaceCatalogScopeContext } = await import('./plugin-workspace-selection');
  const { readComposioExtensions, readMcpExtensions } = await import('./plugin-extension-integrations');
  return { context: resolvePluginWorkspaceCatalogScopeContext, packages: readInstalledExtensions, store: readStoreExtensions,
    composio: readComposioExtensions, mcp: readMcpExtensions, revalidate: revalidateExtensions };
}

async function readInstalledExtensions(actor: CapabilityResourceActor) {
  const [{ listCapabilityResources }, { projectPluginWorkspaceCatalog }, { resolvePluginWorkspaceCatalogScopeContext }] = await Promise.all([
    import('@/app/lib/capabilities/resources/actions'), import('./plugin-workspace-catalog'), import('./plugin-workspace-selection')]);
  const resources = await listCapabilityResources(actor), context = await resolvePluginWorkspaceCatalogScopeContext(actor);
  const items: PluginExtensionItem[] = [];
  let page = 1, catalog;
  do {
    catalog = projectPluginWorkspaceCatalog(resources, context, { kind: null, scope: 'all', audience: null, teamId: null, q: '', page, limit: 50 });
    for (const item of catalog.items) items.push({ id: item.resourceRef, kind: item.kind, name: item.name, displayName: item.displayName, description: item.description,
      source: 'local', stock: 'installed', access: { canRead: item.access.canRead, canUse: item.access.canUse, canManage: item.access.canManage },
      ownership: item.ownership, ownershipLabel: item.ownershipLabel, package: item });
    page += 1;
  } while (catalog.pagination.hasNextPage && page <= 2000);
  return { items, scopes: catalog.scopes, coverage: { source: 'packages' as const, status: catalog.pagination.hasNextPage ? 'partial' as const : 'complete' as const } };
}

async function readStoreExtensions(actor: CapabilityResourceActor, options: { search?: string; continuation?: string; selected?: string | null } = {}): Promise<PluginExtensionSourceResult> {
  const { listCapabilityPackageStoreAction } = await import('@/app/lib/capabilities/packages/store-actions');
  const items: PluginExtensionItem[] = [], seen = new Set<string>();
  let partial = false, hasNext = true;
  const initialPage = options.continuation ? Number(options.continuation) : 1;
  if (!Number.isSafeInteger(initialPage) || initialPage < 1 || initialPage > 100000) invalid('PLUGIN_SEARCH_CURSOR_INVALID');
  let page = initialPage;
  for (; hasNext && page < initialPage + 20; page += 1) {
    let result;
    try { result = await listCapabilityPackageStoreAction(actor, { scope: 'all', q: options.search ?? '', page, limit: 50, installedLimit: 1 }); }
    catch { partial = true; break; }
    hasNext = false;
    for (const store of result.stores) {
      partial ||= store.availability === 'unavailable';
      hasNext ||= store.pagination.hasNextPage;
      for (const offering of store.offerings) {
        const id = `store:${offering.kind}:${offering.registryId}:${offering.entryKey}`;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, kind: offering.kind, name: offering.entryKey, displayName: offering.displayName, description: offering.description,
          source: 'store', stock: offering.installedResourceRefs.length ? 'installed' : 'available',
          access: { canRead: true, canUse: false, canManage: false }, offering });
      }
    }
  }
  partial ||= hasNext;
  if (options.selected?.startsWith('store:') && !items.some(item => item.id === options.selected)) {
    // Registry/entry values are checked against current public offerings, never
    // decoded into an installation source or a caller-provided archive URL.
    const { readCanvasPluginStoreRegistry } = await import('./canvas-plugin-store');
    const { readCanvasSkillStoreRegistry } = await import('@/app/lib/skills/canvas-skill-store');
    for (const kind of ['plugin', 'skill'] as const) {
      try {
        const registry = kind === 'plugin' ? await readCanvasPluginStoreRegistry() : await readCanvasSkillStoreRegistry();
        const entries = 'plugins' in registry ? registry.plugins : registry.skills;
        const entry = entries.find(value => `store:${kind}:${registry.id}:${value.name}` === options.selected);
        if (!entry) continue;
        const exact = await listCapabilityPackageStoreAction(actor, { scope: 'all', kind, q: entry.name, page: 1, limit: 50, installedLimit: 1 });
        const offering = exact.stores.flatMap(store => store.offerings).find(value => value.registryId === registry.id && value.entryKey === entry.name);
        if (offering) items.push({ id: options.selected, kind, name: offering.entryKey, displayName: offering.displayName, description: offering.description,
          source: 'store', stock: offering.installedResourceRefs.length ? 'installed' : 'available', access: { canRead: true, canUse: false, canManage: false }, offering });
      } catch { partial = true; }
    }
  }
  return { items, ...(hasNext && page <= 100000 ? { continuation: String(page) } : {}), coverage: { source: 'store', status: partial ? items.length ? 'partial' : 'unavailable' : 'complete',
    ...(partial ? { error: { code: 'PLUGIN_STORE_PARTIAL', message: 'Some package Store metadata could not be fully loaded.', retryable: true } } : {}) } };
}

export async function revalidateExtensions(actor: CapabilityResourceActor, items: PluginExtensionItem[]): Promise<{ items: PluginExtensionItem[]; coverage: PluginExtensionCoverage[] }> {
  const [{ listSharedIntegrationConnections }, { resolvePluginWorkspaceCatalogScopeContext },
    { revalidatePersonalComposioExtensionConnection, readMcpExtensions }] = await Promise.all([
    import('@/app/lib/integration-tools/connections/store'), import('./plugin-workspace-selection'), import('./plugin-extension-integrations')]);
  await resolvePluginWorkspaceCatalogScopeContext(actor);
  const failures: PluginExtensionCoverage[] = [];
  const unavailable = (source: PluginExtensionCoverage['source']) => failures.push({ source, status: 'partial',
    error: { code: 'PLUGIN_SEARCH_REVALIDATION_UNAVAILABLE', message: 'Some current extension permissions could not be checked.', retryable: true } });
  let packageItems: PluginExtensionItem[] = [], sharedItems: Awaited<ReturnType<typeof listSharedIntegrationConnections>> = [], packagesUnavailable = false;
  if (items.some(item => item.kind === 'plugin' || item.kind === 'skill')) {
    try { packageItems = (await readInstalledExtensions(actor)).items; } catch { packagesUnavailable = true; unavailable('packages'); }
  }
  if (items.some(item => item.kind === 'integration')) {
    try { sharedItems = await listSharedIntegrationConnections(actor, 'composio'); } catch { unavailable('composio'); }
  }
  const currentPackages = new Map(packageItems.map(item => [item.id, item]));
  const shared = new Map(sharedItems.filter(item => item.access.canRead && item.resource.status === 'active').map(item => [item.resource.connectionRef, item]));
  let currentMcp: PluginExtensionSourceResult | null = null;
  if (items.some(item => item.kind === 'mcp')) { try { currentMcp = await readMcpExtensions(actor); } catch { unavailable('mcp'); } }
  const mcpItems = new Map((currentMcp?.items ?? []).map(item => [item.id, item]));
  let composioChanged = false;
  const { publicSharedExtensionConnection } = await import('./plugin-extension-integrations');
  const result: PluginExtensionItem[] = [];
  for (const item of items) {
    if (item.kind === 'mcp') { const current = mcpItems.get(item.id); if (current) result.push(current); continue; }
    if ((item.kind === 'plugin' || item.kind === 'skill') && item.package) {
      const current = currentPackages.get(item.id); if (current) result.push(current); continue;
    }
    if (item.kind === 'integration') {
      const connections = [];
      for (const connection of item.connections) {
        if (connection.connectionRef.startsWith('canvas-connection:')) {
          const current = shared.get(connection.connectionRef);
          if (current && current.resource.source === 'composio' && current.resource.application === item.toolkit.slug) connections.push(publicSharedExtensionConnection(current));
        } else {
          if (connection.ownership.type === 'user' && connection.ownership.ownerUserId === actor.userId
            && await revalidatePersonalComposioExtensionConnection(actor, connection)) connections.push(connection);
          else composioChanged = true;
        }
      }
      item.connections = connections;
      item.stock = connections.length ? 'installed' : 'available';
      item.access = { canRead: true, canUse: connections.some(value => value.access.canUse), canManage: connections.some(value => value.access.canManage) };
    }
    if ((item.kind === 'plugin' || item.kind === 'skill') && item.offering) {
      if (packagesUnavailable && item.offering.installedResourceRefs.length) {
        // Failure to check an installed resource is not proof that the package
        // became available for another installation. Keep unrelated offerings.
        if (!failures.some(failure => failure.source === 'store')) unavailable('store');
        continue;
      }
      item.offering.installedResourceRefs = item.offering.installedResourceRefs.filter(ref => currentPackages.has(ref));
      item.stock = item.offering.installedResourceRefs.length ? 'installed' : 'available';
      // A continued Store batch need not contain the initial package rows. Its
      // verified references still resolve to current readable installed items.
      for (const ref of item.offering.installedResourceRefs) {
        const installed = currentPackages.get(ref);
        if (installed && !result.some(current => current.id === ref)) result.push(installed);
      }
    }
    result.push(item);
  }
  await resolvePluginWorkspaceCatalogScopeContext(actor);
  return { items: [...new Map(result.map(item => [item.id, item])).values()], coverage: [...failures, ...(currentMcp && currentMcp.coverage.status !== 'complete' ? [currentMcp.coverage] : []),
    ...(composioChanged ? [{ source: 'composio' as const, status: 'partial' as const,
      error: { code: 'COMPOSIO_BINDING_CHANGED', message: 'A connection profile changed while loading. Reload the catalogue.', retryable: true } }] : [])] };
}

export async function searchPluginExtensions(actorInput: CapabilityResourceActor, query: PluginExtensionQuery,
  options: { dependencies?: PluginExtensionSearchDependencies; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PluginExtensionSearchResponse> {
  const actor = { userId: actorInput.userId, workspaceId: actorInput.workspaceId?.trim() || null }, dependencies = options.dependencies ?? await defaultDependencies();
  const context = await dependencies.context(actor);
  const cursorState = extensionCursorState(actor, query);
  options.signal?.throwIfAborted();
  if (query.scope === 'team' && query.teamId && !context.readableTeamIds.has(query.teamId)) throw new CapabilityResourceError('PLUGIN_CATALOG_TEAM_NOT_FOUND', 'The selected team is unavailable in this context.', 404);
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) invalid();
  const load = async (source: PluginExtensionCoverage['source'], callback: (signal: AbortSignal) => Promise<PluginExtensionSourceResult>) => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      return await Promise.race([callback(controller.signal), new Promise<PluginExtensionSourceResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          // The shared Composio collector preserves successful pages when its
          // signal aborts. Give that bounded cleanup a chance to return them.
          grace = setTimeout(() => resolve({ items: [], coverage: { source, status: 'unavailable',
            error: { code: 'PLUGIN_SEARCH_SOURCE_TIMEOUT', message: 'An extension catalogue did not respond in time.', retryable: true } } }), source === 'composio' ? 100 : 0);
        }, timeoutMs);
      })]);
    } catch { return { items: [], coverage: { source, status: 'unavailable' as const,
      error: { code: 'PLUGIN_SEARCH_SOURCE_UNAVAILABLE', message: 'An extension catalogue is currently unavailable.', retryable: true } } }; }
    finally { if (timer) clearTimeout(timer); if (grace) clearTimeout(grace); options.signal?.removeEventListener('abort', abort); }
  };
  let scopes: PluginWorkspaceCatalogResponse['scopes'] = { choices: ['all', 'user', ...(context.readableTeamIds.size ? ['team' as const] : []), ...(context.organizationAvailable ? ['organization' as const] : [])], teams: [...context.teams] };
  const selected = query.selected ?? '', selectedShared = selected.startsWith('canvas-connection:');
  const laterBatch = Object.keys(cursorState.sources).length > 0;
  const packagesRequested = !laterBatch && (query.source === 'all' || query.source === 'store') && query.types.some(type => type === 'plugin' || type === 'skill')
    || selected.startsWith('canvas-resource:') || selected.startsWith('store:');
  const composioRequested = (!laterBatch || cursorState.sources.composio !== undefined) && (query.source === 'all' || query.source === 'composio') && query.types.includes('integration')
    || selected.startsWith('composio:') || selectedShared;
  const mcpRequested = !laterBatch && (query.source === 'all' || query.source === 'mcp') && query.types.includes('mcp')
    || selected.startsWith('mcp-') || selectedShared;
  const loads = [];
  if (packagesRequested) {
    loads.push(load('packages', async () => { const result = await dependencies.packages(actor); scopes = result.scopes; return result; }));
  }
  if (packagesRequested || cursorState.sources.store !== undefined) loads.push(load('store', () => dependencies.store(actor, { search: query.q, continuation: cursorState.sources.store, selected: query.selected })));
  if (composioRequested) loads.push(load('composio', signal => dependencies.composio(actor, signal, { search: query.q, continuation: cursorState.sources.composio,
    selectedSlug: selected.startsWith('composio:') ? selected.slice('composio:'.length) : undefined })));
  if (mcpRequested) loads.push(load('mcp', () => dependencies.mcp(actor)));
  const results = await Promise.all(loads);
  options.signal?.throwIfAborted();
  const currentContext = await dependencies.context(actor);
  if (query.scope === 'team' && query.teamId && !currentContext.readableTeamIds.has(query.teamId)) throw new CapabilityResourceError('PLUGIN_CATALOG_TEAM_NOT_FOUND', 'The selected team is unavailable in this context.', 404);
  scopes.teams = currentContext.teams.filter(team => currentContext.readableTeamIds.has(team.teamId));
  scopes.choices = scopes.choices.filter(scope => scope !== 'team' || currentContext.readableTeamIds.size > 0).filter(scope => scope !== 'organization' || currentContext.organizationAvailable);
  const revalidated = await dependencies.revalidate(actor, [...new Map(results.flatMap(result => result.items).map(item => [item.id, item])).values()]);
  const current = Array.isArray(revalidated) ? revalidated : revalidated.items;
  const updates = Array.isArray(revalidated) ? [] : revalidated.coverage;
  const continuations: SourceContinuations = {};
  for (const result of results) if (result.continuation && (result.coverage.source === 'composio' || result.coverage.source === 'store')) continuations[result.coverage.source] = result.continuation;
  return projectPluginExtensionPage(actor, query, current, scopes, results.map(result => updates.find(update => update.source === result.coverage.source) ?? result.coverage), continuations);
}
