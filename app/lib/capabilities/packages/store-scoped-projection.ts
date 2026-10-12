import 'server-only';

import type { CapabilityResourceDescriptor } from '../resources/contracts';
import type { PluginWorkspaceCatalogQuery, PluginWorkspaceCatalogScopeContext } from '@/app/lib/plugins/plugin-workspace-catalog-contracts';
import { parsePluginWorkspaceCatalogQuery, projectPluginWorkspaceCatalog, selectPluginWorkspaceCatalogResources } from '@/app/lib/plugins/plugin-workspace-catalog';
import { projectActorCanvasPluginStoreState } from '@/app/lib/plugins/actor-plugin-store-state';
import { projectActorCanvasSkillStoreState, type SafeActorSkillStoreResource } from '@/app/lib/skills/actor-skill-store-state';
import type { CanvasPluginStoreRegistry } from '@/app/lib/plugins/canvas-plugin-store';
import type { CanvasSkillStoreRegistry } from '@/app/lib/skills/canvas-skill-store';
import { capabilityStoreComparison, installedStoreResourceObservation, type PrivateInstalledStoreResource } from '@/app/lib/plugins/store-installed-resource';
import { projectCapabilityPackageStoreVersions } from './store-offerings';
import type { CapabilityPackageStoreListRequest, CapabilityPackageStoreListResponse } from './store-contracts';

export type CapabilityPackageStoreSources = { plugin: CanvasPluginStoreRegistry | null; skill: CanvasSkillStoreRegistry | null };

export function capabilityPackageStoreCatalogQuery(input: CapabilityPackageStoreListRequest): PluginWorkspaceCatalogQuery {
  const parameters = new URLSearchParams({ scope: input.scope ?? 'all', q: input.q ?? '', page: String(input.installedPage ?? 1), limit: String(input.installedLimit ?? 20) });
  if (input.kind) parameters.set('kind', input.kind);
  if (input.audience) parameters.set('audience', input.audience);
  if (input.teamId) parameters.set('teamId', input.teamId);
  return parsePluginWorkspaceCatalogQuery(parameters);
}

/** The one shared 32-byte-observation budget prioritizes the selected metadata page. */
export function prioritizeScopedStoreResources(resources: readonly CapabilityResourceDescriptor[], query: PluginWorkspaceCatalogQuery,
  visibleResources: readonly CapabilityResourceDescriptor[] = resources): CapabilityResourceDescriptor[] {
  const start = (query.page - 1) * query.limit, visible = visibleResources.slice(start, start + query.limit);
  const refs = new Set(visible.map(resource => resource.metadata.resourceRef));
  const eligible = [...visible, ...resources.filter(resource => !refs.has(resource.metadata.resourceRef))]
    .filter(resource => resource.artifact.sourceType !== 'core' && resource.artifact.scopeType !== 'system');
  return [...eligible.filter(resource => resource.artifact.sourceType === 'standalone'), ...eligible.filter(resource => resource.artifact.sourceType !== 'standalone')];
}

/** Final metadata/grant/ownership checks invalidate earlier comparisons without hiding current readable rows. */
export function retainCurrentScopedStoreObservations(initial: readonly CapabilityResourceDescriptor[], current: readonly CapabilityResourceDescriptor[],
  observations: ReadonlyMap<string, PrivateInstalledStoreResource>): Map<string, PrivateInstalledStoreResource> {
  const before = new Map(initial.map(resource => [resource.metadata.resourceRef, resource]));
  const retained = new Map<string, PrivateInstalledStoreResource>();
  for (const resource of current) {
    const previous = before.get(resource.metadata.resourceRef), observed = observations.get(resource.metadata.resourceRef);
    const observation = installedStoreResourceObservation(resource);
    if (previous && observed && observed.resourceRef === resource.metadata.resourceRef
      && installedStoreResourceObservation(previous) === observation
      && (observed.observation === observation || observed.observation === undefined && observed.origin === null)
      && previous.metadata.metadataRevision === resource.metadata.metadataRevision
      && previous.metadata.grantsRevision === resource.metadata.grantsRevision) retained.set(resource.metadata.resourceRef, { ...observed, observation });
  }
  return retained;
}

function safeText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, maximum) || undefined : undefined;
}
function attention(resource: SafeActorSkillStoreResource): boolean {
  const state = resource.storeState;
  return !state || state.localChanges === 'modified' || state.localChanges === 'unknown' || state.upstream === 'conflict'
    || state.upstream === 'unknown' || state.origin === 'unknown';
}

/** Pure projection over current ACL rows and private exact provenance, never names guessed from installed metadata. */
export function projectScopedCapabilityPackageStore(resources: readonly CapabilityResourceDescriptor[], context: PluginWorkspaceCatalogScopeContext,
  input: CapabilityPackageStoreListRequest, sources: CapabilityPackageStoreSources,
  observations: ReadonlyMap<string, PrivateInstalledStoreResource>): CapabilityPackageStoreListResponse {
  const query = capabilityPackageStoreCatalogQuery(input), catalog = projectPluginWorkspaceCatalog(resources, context, query);
  const selected = selectPluginWorkspaceCatalogResources(resources, context, { ...query, q: '' });
  const matching = new Set(selectPluginWorkspaceCatalogResources(resources, context, query).map(resource => resource.metadata.resourceRef));
  const selectedOrder = new Map(selected.map((resource, index) => [resource.metadata.resourceRef, index]));
  const installedResources: SafeActorSkillStoreResource[] = [];
  const stores: CapabilityPackageStoreListResponse['stores'] = [];
  for (const kind of input.kind ? [input.kind] : ['plugin', 'skill'] as const) {
    // Both legacy pure projectors retain their exact origin matching, without their global read pipelines.
    const enriched = kind === 'plugin' ? projectActorCanvasPluginStoreState(sources.plugin, selected,
      { query: input.q, page: input.page, pageSize: input.limit }, observations)
      : projectActorCanvasSkillStoreState(sources.skill, selected, undefined, observations);
    const allOfferings = 'plugins' in enriched ? enriched.plugins : enriched.skills;
    const filtered = allOfferings.filter(offering => !input.q || [offering.name, offering.displayName, offering.description, offering.category ?? '']
      .some(value => value.toLocaleLowerCase('en-US').includes(input.q!.trim().toLocaleLowerCase('en-US'))));
    const pageSize = input.limit ?? 12, totalItems = 'pagination' in enriched ? enriched.pagination!.totalItems : filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize)), page = Math.min(input.page ?? 1, totalPages);
    const offerings = kind === 'plugin' ? allOfferings : filtered.slice((page - 1) * pageSize, page * pageSize);
    const kindResources = (enriched.installedResources ?? []).sort((left, right) => selectedOrder.get(left.metadata.resourceRef)! - selectedOrder.get(right.metadata.resourceRef)!);
    installedResources.push(...kindResources);
    stores.push({ kind, registry: { id: enriched.registry.id, name: safeText(enriched.registry.name, 200) ?? '', updatedAt: safeText(enriched.registry.updatedAt, 200) ?? '' },
      availability: enriched.availability ?? 'available', pagination: { page, pageSize, totalItems, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 },
      installedResources: kindResources.slice(0, 50),
      offerings: offerings.map(offering => {
        const refs = offering.installed.resources?.filter(resource => resource.storeState?.origin === 'verified').map(resource => resource.metadata.resourceRef) ?? [];
        const publisherName = safeText(offering.publisher?.name, 200);
        return { kind, registryId: enriched.registry.id, entryKey: offering.name, displayName: safeText(offering.displayName, 200) ?? offering.name,
          description: safeText(offering.description, 4096) ?? '', latestVersion: offering.latestVersion,
          ...(publisherName ? { publisher: { name: publisherName } } : {}),
          versions: projectCapabilityPackageStoreVersions(offering.versions, offering.latestVersion).map(version => {
            const metadata = offering.versions[version.version];
            const releasedAt = safeText(metadata?.releasedAt, 200), notes = safeText(metadata?.notes, 4096);
            return { ...version, ...(releasedAt ? { releasedAt } : {}), ...(notes ? { notes } : {}) };
          }), installedResourceRefs: refs.slice(0, 50), installedRefsTruncated: refs.length > 50 };
      }) });
  }
  installedResources.sort((left, right) => selectedOrder.get(left.metadata.resourceRef)! - selectedOrder.get(right.metadata.resourceRef)!);
  const states = installedResources.map(resource => resource.storeState!);
  const unknown = installedResources.filter(resource => !resource.storeState || resource.storeState.origin === 'unknown'
    || resource.storeState.localChanges === 'unknown' || resource.storeState.upstream === 'unknown').length;
  const state = input.installedState ?? 'all';
  const filteredResources = installedResources.filter(resource => matching.has(resource.metadata.resourceRef)
    && (state === 'all' || (state === 'updates' ? resource.storeState?.upstream === 'update-available' : attention(resource))));
  const totalItems = filteredResources.length, totalPages = Math.ceil(totalItems / query.limit), start = (query.page - 1) * query.limit;
  return { schemaVersion: 1, selection: { ...catalog.selection, installedState: state }, scopes: catalog.scopes, stores,
    installed: { resources: filteredResources.slice(start, start + query.limit),
      pagination: { page: query.page, limit: query.limit, totalItems, totalPages, hasNextPage: query.page < totalPages, hasPreviousPage: query.page > 1 && totalItems > 0 },
      summary: { total: installedResources.length, updates: installedResources.filter(resource => resource.storeState?.upstream === 'update-available').length,
        modified: installedResources.filter(resource => resource.storeState?.localChanges === 'modified').length, unknown,
        observed: installedResources.filter(resource => observations.get(resource.metadata.resourceRef)?.observation === installedStoreResourceObservation(selected[selectedOrder.get(resource.metadata.resourceRef)!])).length,
        comparison: capabilityStoreComparison(states, states.length > 0 || stores.every(store => store.availability === 'available')) } } };
}
