import 'server-only';

import type { CapabilityResourceActor, CapabilityResourceDescriptor } from '@/app/lib/capabilities/resources/contracts';
import { assertActorCanvasSkillStoreContext, projectSafeInstalledStoreResource, publicStoreUrl, type SafeActorSkillStoreResource } from '@/app/lib/skills/actor-skill-store-state';
import { normalizeComposioConnectors, normalizeEmailConnectors, normalizeMcpConnectors } from './plugin-connection-readiness';
import { capabilityStoreComparison, compareInstalledStoreResource, installedStoreResourceObservation, readInstalledStoreResources,
  storeOriginMatchesOffering, type PrivateInstalledStoreResource } from './store-installed-resource';
import type { CanvasPluginStoreList, CanvasPluginStoreListOptions, CanvasPluginStoreRegistry, CanvasPluginStorePlugin,
  CanvasPluginStorePluginWithState, CanvasPluginStoreConnectionType } from './canvas-plugin-store';

function scopedPlugins(resources: readonly CapabilityResourceDescriptor[], options: CanvasPluginStoreListOptions): CapabilityResourceDescriptor[] {
  return resources.filter(resource => resource.access.canRead && resource.artifact.resourceType === 'plugin' && resource.metadata.status === 'active'
    && (options.scope?.scopeType !== 'organization' || resource.artifact.scopeType === 'organization'
      && (resource.metadata.ownership.type === 'organization' || resource.metadata.ownership.type === 'team')
      && resource.metadata.ownership.organizationId === options.scope.organizationId));
}

function connections(plugin: CanvasPluginStorePlugin): CanvasPluginStoreConnectionType[] {
  const result: CanvasPluginStoreConnectionType[] = [];
  if (normalizeComposioConnectors(plugin.connectors).length) result.push('composio');
  if (normalizeEmailConnectors(plugin.connectors).length) result.push('email');
  if (normalizeMcpConnectors(plugin.connectors).length) result.push('mcp');
  return result.length ? result : ['none'];
}

function safeOffering(plugin: CanvasPluginStorePlugin): CanvasPluginStorePlugin {
  return { name: plugin.name, displayName: plugin.displayName, description: plugin.description, category: plugin.category,
    latestVersion: plugin.latestVersion, brandColor: plugin.brandColor, skills: plugin.skills ? [...plugin.skills] : undefined,
    iconUrl: publicStoreUrl(plugin.iconUrl), publisher: plugin.publisher ? { name: plugin.publisher.name, url: publicStoreUrl(plugin.publisher.url) } : undefined,
    versions: Object.fromEntries(Object.entries(plugin.versions).map(([key, version]) => [key, { version: version.version,
      downloadUrl: publicStoreUrl(version.downloadUrl) || '', checksum: version.checksum, packagePath: version.packagePath,
      manifestPath: version.manifestPath, releasedAt: version.releasedAt, minCanvasVersion: version.minCanvasVersion, notes: version.notes }])) };
}

export function projectActorCanvasPluginStoreState(source: CanvasPluginStoreRegistry | null,
  descriptors: readonly CapabilityResourceDescriptor[], options: CanvasPluginStoreListOptions,
  observations: ReadonlyMap<string, PrivateInstalledStoreResource> = new Map()): CanvasPluginStoreList {
  const registry = source ?? { schemaVersion: 1 as const, id: '', name: '', updatedAt: '', registryUrl: '', plugins: [] };
  const installedResources: SafeActorSkillStoreResource[] = [], privateByRef = new Map<string, PrivateInstalledStoreResource>();
  for (const descriptor of scopedPlugins(descriptors, options)) {
    const previous = observations.get(descriptor.metadata.resourceRef);
    const current = previous?.observation === installedStoreResourceObservation(descriptor) ? previous : undefined;
    if (current) privateByRef.set(descriptor.metadata.resourceRef, current);
    const offering = current?.origin?.kind === 'plugin' ? registry.plugins.find(plugin => plugin.name === current.origin?.entryKey) : undefined;
    installedResources.push({ ...projectSafeInstalledStoreResource(descriptor), storeState: compareInstalledStoreResource(current, source, offering, 'plugin') });
  }
  installedResources.sort((a, b) => a.metadata.resourceRef.localeCompare(b.metadata.resourceRef));
  const plugins: CanvasPluginStorePluginWithState[] = registry.plugins.map(plugin => {
    const resources = installedResources.filter(resource => storeOriginMatchesOffering(privateByRef.get(resource.metadata.resourceRef)?.origin ?? null, registry, 'plugin', plugin.name));
    const single = resources.length === 1 ? resources[0] : undefined;
    return { ...safeOffering(plugin), installed: { installed: resources.some(resource => resource.storeState?.origin === 'verified'),
      enabled: single?.activation?.enabled === true, ...(single ? { version: single.artifact.version } : {}),
      updateAvailable: resources.some(resource => resource.storeState?.upstream === 'update-available'), resources,
      comparison: capabilityStoreComparison(resources.map(resource => resource.storeState!), Boolean(source)),
      skills: [], skillSummary: { total: 0, installed: 0, missing: 0, updateAvailable: 0, modified: 0, repairable: 0 } } };
  });
  const query = (options.query || '').trim().toLowerCase(), category = options.category?.trim().toLowerCase();
  const filtered = plugins.filter(plugin => (!options.name || plugin.name === options.name)
    && (!category || plugin.category?.trim().toLowerCase() === category)
    && (!options.connection || connections(registry.plugins.find(item => item.name === plugin.name)!).includes(options.connection))
    && (options.state !== 'installed' || plugin.installed.installed) && (options.state !== 'available' || !plugin.installed.installed)
    && (options.state !== 'updates' || plugin.installed.updateAvailable)
    && (!query || [plugin.name, plugin.displayName, plugin.description, plugin.category || '', ...(plugin.skills || [])].join(' ').toLowerCase().includes(query)));
  const integer = (value: number | undefined, fallback: number, max: number) => Number.isFinite(value) && value! > 0 ? Math.min(Math.floor(value!), max) : fallback;
  const pageSize = integer(options.pageSize, 12, 50), totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(integer(options.page, 1, 100000), totalPages);
  return { registry: { schemaVersion: registry.schemaVersion, id: registry.id, name: registry.name, updatedAt: registry.updatedAt,
    registryUrl: publicStoreUrl(registry.registryUrl) || '', homepage: publicStoreUrl(registry.homepage),
    publisher: registry.publisher ? { name: registry.publisher.name, url: publicStoreUrl(registry.publisher.url) } : undefined },
    plugins: filtered.slice((page - 1) * pageSize, page * pageSize), installedPlugins: plugins.filter(plugin => plugin.installed.installed),
    installedResources, availability: source ? 'available' : 'unavailable', comparison: capabilityStoreComparison(installedResources.map(resource => resource.storeState!), Boolean(source)),
    facets: { categories: [...new Set(plugins.map(plugin => plugin.category).filter((value): value is string => Boolean(value)))].sort(),
      connectionTypes: [...new Set(registry.plugins.flatMap(connections))].sort() },
    stats: { total: plugins.length, installed: plugins.filter(plugin => plugin.installed.installed).length,
      available: plugins.filter(plugin => !plugin.installed.installed).length, updates: plugins.filter(plugin => plugin.installed.updateAvailable).length, filteredTotal: filtered.length },
    pagination: { page, pageSize, totalItems: filtered.length, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 } };
}

export async function listActorCanvasPluginStore(options: CanvasPluginStoreListOptions & { actor: CapabilityResourceActor },
  readRegistry: () => Promise<CanvasPluginStoreRegistry>): Promise<CanvasPluginStoreList> {
  const actor = { userId: options.actor.userId, workspaceId: options.actor.workspaceId };
  await assertActorCanvasSkillStoreContext(actor);
  const { listCapabilityResources } = await import('@/app/lib/capabilities/resources/actions');
  const initial = await listCapabilityResources(actor);
  let registry: CanvasPluginStoreRegistry | null = null;
  try { registry = await readRegistry(); } catch { /* A store outage never removes currently readable installed metadata. */ }
  const observations = await readInstalledStoreResources(actor, scopedPlugins(initial, options));
  await assertActorCanvasSkillStoreContext(actor);
  return projectActorCanvasPluginStoreState(registry, await listCapabilityResources(actor), options, observations);
}
