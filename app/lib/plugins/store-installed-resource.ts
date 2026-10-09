import 'server-only';

import path from 'node:path';
import type { CapabilityResourceActor, CapabilityResourceDescriptor } from '@/app/lib/capabilities/resources/contracts';
import { normalizeCapabilityStoreOrigin, deriveCapabilityStoreOrigin, capabilityStoreRegistryIdentity, compareCapabilityStoreVersions,
  type CapabilityStoreOrigin } from '@/app/lib/capabilities/packages/store-origin';
import type { CanvasPluginStoreVersion } from './canvas-plugin-store';

export type CapabilityStoreComparison = 'known' | 'partial' | 'unknown';
export type SafeCapabilityStoreState = {
  origin: 'verified' | 'derived' | 'unknown';
  localChanges: 'unchanged' | 'modified' | 'unknown';
  upstream: 'current' | 'update-available' | 'conflict' | 'unknown';
  source?: { registryId: string; entryKey: string; version: string };
};
export type PrivateInstalledStoreResource = { resourceRef: string; origin: CapabilityStoreOrigin | null; checksum: string | null; observation?: string };
export const UNKNOWN_CAPABILITY_STORE_STATE: SafeCapabilityStoreState = { origin: 'unknown', localChanges: 'unknown', upstream: 'unknown' };

function sameObservation(left: CapabilityResourceDescriptor, right: CapabilityResourceDescriptor): boolean {
  return left.metadata.resourceRef === right.metadata.resourceRef && left.artifact.resourceId === right.artifact.resourceId
    && left.artifact.name === right.artifact.name && left.artifact.resourceType === right.artifact.resourceType
    && left.artifact.sourceType === right.artifact.sourceType && left.artifact.scopeType === right.artifact.scopeType
    && left.artifact.version === right.artifact.version && left.artifact.revision === right.artifact.revision && left.artifact.checksum === right.artifact.checksum;
}

export function installedStoreResourceObservation(resource: CapabilityResourceDescriptor): string {
  return JSON.stringify([resource.metadata.resourceRef, resource.artifact, resource.metadata.ownership]);
}

/** Internal exact reader. No name-based visibility selection or caller-supplied filesystem root. */
export async function readInstalledStoreResource(actor: CapabilityResourceActor, descriptor: CapabilityResourceDescriptor): Promise<PrivateInstalledStoreResource> {
  const unknown: PrivateInstalledStoreResource = { resourceRef: descriptor.metadata.resourceRef, origin: null, checksum: null };
  if (!descriptor.access.canRead || descriptor.artifact.sourceType === 'core' || descriptor.artifact.scopeType === 'system') return unknown;
  const [{ inspectCapabilityResource }, { loadCapabilityCandidatesForResourceActor, assertReadableCapabilityCandidate }] = await Promise.all([
    import('@/app/lib/capabilities/resources/actions'), import('@/app/lib/capabilities/resources/read'),
  ]);
  const current = await inspectCapabilityResource(actor, descriptor.metadata.resourceRef);
  if (!sameObservation(descriptor, current) || !current.access.canRead) return unknown;
  const candidates = await loadCapabilityCandidatesForResourceActor(actor);
  const matching = candidates.filter(candidate => candidate.ref.resourceId === current.artifact.resourceId
    && candidate.ref.resourceType === current.artifact.resourceType && candidate.resourceAccess?.canRead !== false);
  if (matching.length !== 1) return unknown;
  const candidate = matching[0];
  await assertReadableCapabilityCandidate(actor, candidate, candidates);
  const scope = candidate.ref.scopeType === 'organization'
    ? { scopeType: 'organization' as const, organizationId: candidate.ref.organizationId! }
    : { scopeType: 'user' as const, userId: candidate.ref.ownerUserId! };
  let origin: CapabilityStoreOrigin | null = null, root: string | null = null;
  if (candidate.ref.resourceType === 'plugin' || candidate.ref.sourceType === 'plugin') {
    const parent = candidate.ref.sourceType === 'plugin'
      ? candidates.find(value => value.ref.resourceType === 'plugin' && value.ref.resourceId === candidate.ref.sourcePluginId) : candidate;
    if (!parent || parent.resourceAccess?.canRead === false) return unknown;
    await assertReadableCapabilityCandidate(actor, parent, candidates);
    const { readExactInstalledPlugin } = await import('./installed-plugin-read');
    const plugin = await readExactInstalledPlugin({ name: parent.ref.name, resourceId: parent.ref.resourceId, scope });
    if (!plugin) return unknown;
    const parentOrigin = normalizeCapabilityStoreOrigin(plugin.storeOrigin, parent.ref.resourceId);
    if (candidate.ref.sourceType === 'plugin') {
      if (!candidate.runtimePath || !parentOrigin) return unknown;
      const relative = path.relative(plugin.installDir, path.dirname(candidate.runtimePath)).split(path.sep).join('/');
      origin = normalizeCapabilityStoreOrigin(deriveCapabilityStoreOrigin(parentOrigin, candidate.ref.resourceId, relative), candidate.ref.resourceId);
    } else { origin = parentOrigin; root = plugin.installDir; }
  } else {
    const { readCanvasSkillRegistry } = await import('@/app/lib/skills/canvas-skill-store');
    const record = (await readCanvasSkillRegistry(scope)).skills[candidate.ref.name];
    if (!record || record.resourceId !== candidate.ref.resourceId || record.name !== candidate.ref.name
      || record.scopeType !== candidate.ref.scopeType || (record.ownerUserId ?? null) !== candidate.ref.ownerUserId
      || (record.organizationId ?? null) !== candidate.ref.organizationId) return unknown;
    origin = normalizeCapabilityStoreOrigin(record.storeOrigin, candidate.ref.resourceId); root = record.installDir;
    if (origin && (record.packageManaged || record.packageResourceRef || record.publishedRevisionRef)) {
      const { assertCapabilityPackageRegistryPointerCurrent } = await import('@/app/lib/capabilities/packages/artifacts');
      await assertCapabilityPackageRegistryPointerCurrent('skill', record, scope);
    }
  }
  if (!origin) return unknown;
  let checksum: string | null = null;
  if (root && candidate.runtimePath) {
    const { readExactPackageInventory } = await import('@/app/lib/capabilities/packages/io');
    checksum = (await readExactPackageInventory(root)).checksum;
  }
  await assertReadableCapabilityCandidate(actor, candidate, candidates);
  const after = await inspectCapabilityResource(actor, descriptor.metadata.resourceRef);
  return sameObservation(current, after) && after.access.canRead
    ? { resourceRef: unknown.resourceRef, origin, checksum, observation: installedStoreResourceObservation(after) } : unknown;
}

/** Budget exhaustion or unavailable package bytes never remove current readable metadata. */
export async function readInstalledStoreResources(actor: CapabilityResourceActor, descriptors: readonly CapabilityResourceDescriptor[],
  options: { preserveInputOrder?: boolean } = {}): Promise<Map<string, PrivateInstalledStoreResource>> {
  const results = new Map<string, PrivateInstalledStoreResource>();
  const ordered = [...descriptors];
  if (!options.preserveInputOrder) ordered.sort((a, b) => a.metadata.resourceRef.localeCompare(b.metadata.resourceRef));
  const selected = ordered.slice(0, 32);
  // This snapshot belongs only to this batch and never authorizes package-byte comparisons.
  let candidateCatalog: ReturnType<typeof import('@/app/lib/capabilities/resources/read').loadCapabilityCandidatesForResourceActor> | undefined;
  let cursor = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < selected.length) {
      const descriptor = selected[cursor++];
      try {
        let preflightUnknown = false;
        const artifact = descriptor.artifact;
        if (descriptor.access.canRead && artifact.resourceType === 'skill' && artifact.sourceType === 'standalone'
          && (artifact.scopeType === 'user' || artifact.scopeType === 'organization')) {
          const { loadCapabilityCandidatesForResourceActor, assertReadableCapabilityCandidate } =
            await import('@/app/lib/capabilities/resources/read');
          const candidates = await (candidateCatalog ??= loadCapabilityCandidatesForResourceActor(actor));
          const matching = candidates.filter(candidate => candidate.resourceAccess?.canRead === true
            && candidate.resourceMetadata?.resourceRef === descriptor.metadata.resourceRef
            && JSON.stringify(candidate.resourceMetadata.ownership) === JSON.stringify(descriptor.metadata.ownership)
            && candidate.ref.resourceId === artifact.resourceId && candidate.ref.resourceType === 'skill'
            && candidate.ref.sourceType === 'standalone' && candidate.ref.scopeType === artifact.scopeType
            && candidate.ref.name === artifact.name && candidate.ref.version === artifact.version
            && candidate.ref.revision === artifact.revision && candidate.ref.checksum === artifact.checksum
            && candidate.ref.sourcePluginId === artifact.sourcePluginId);
          if (matching.length === 1) {
            const candidate = matching[0];
            await assertReadableCapabilityCandidate(actor, candidate, candidates);
            const scope = candidate.ref.scopeType === 'organization' && candidate.ref.organizationId
              ? { scopeType: 'organization' as const, organizationId: candidate.ref.organizationId }
              : candidate.ref.scopeType === 'user' && candidate.ref.ownerUserId
                ? { scopeType: 'user' as const, userId: candidate.ref.ownerUserId } : null;
            if (scope) {
              const { readCanvasSkillRegistry } = await import('@/app/lib/skills/canvas-skill-store');
              const record = (await readCanvasSkillRegistry(scope)).skills[candidate.ref.name];
              if (!record || record.resourceId === candidate.ref.resourceId && record.name === candidate.ref.name
                && record.scopeType === candidate.ref.scopeType && record.sourceType !== 'plugin'
                && (record.ownerUserId ?? null) === candidate.ref.ownerUserId
                && (record.organizationId ?? null) === candidate.ref.organizationId
                && record.version === candidate.ref.version && (record.revision || 1) === candidate.ref.revision
                && record.checksum === candidate.ref.checksum
                && normalizeCapabilityStoreOrigin(record.storeOrigin, candidate.ref.resourceId) === null) {
                await assertReadableCapabilityCandidate(actor, candidate, candidates);
                preflightUnknown = true;
              }
            }
          }
        }
        results.set(descriptor.metadata.resourceRef, preflightUnknown
          ? { resourceRef: descriptor.metadata.resourceRef, origin: null, checksum: null }
          : await readInstalledStoreResource(actor, descriptor));
      }
      catch { results.set(descriptor.metadata.resourceRef, { resourceRef: descriptor.metadata.resourceRef, origin: null, checksum: null }); }
    }
  }));
  return results;
}

export function storeOriginMatchesOffering(origin: CapabilityStoreOrigin | null, registry: { id: string; registryUrl: string }, kind: 'plugin' | 'skill', entryKey: string): boolean {
  return Boolean(origin && origin.registryId === registry.id && origin.registryIdentity === capabilityStoreRegistryIdentity(registry.registryUrl)
    && origin.kind === kind && origin.entryKey === entryKey);
}

export function compareInstalledStoreResource(resource: PrivateInstalledStoreResource | undefined,
  registry: { id: string; registryUrl: string } | null, offering: { name: string; latestVersion: string; versions: Record<string, Pick<CanvasPluginStoreVersion, 'checksum' | 'version'>> } | undefined,
  kind: 'plugin' | 'skill'): SafeCapabilityStoreState {
  const origin = resource?.origin;
  if (!origin) return { ...UNKNOWN_CAPABILITY_STORE_STATE };
  const state: SafeCapabilityStoreState = { origin: origin.relation === 'installed' ? 'verified' : 'derived',
    localChanges: resource.checksum && origin.baselineChecksum ? resource.checksum === origin.baselineChecksum ? 'unchanged' : 'modified' : 'unknown',
    upstream: 'unknown', source: { registryId: origin.registryId, entryKey: origin.entryKey, version: origin.version } };
  if (!registry || !offering || !resource.checksum || origin.relation !== 'installed' || !storeOriginMatchesOffering(origin, registry, kind, offering.name)) return state;
  const baseline = offering.versions[origin.version];
  if (!baseline) return state;
  if (baseline.checksum.replace(/^sha256:/iu, '').toLowerCase() !== origin.upstreamChecksum) { state.upstream = 'conflict'; return state; }
  const compared = compareCapabilityStoreVersions(offering.latestVersion, origin.version);
  if (compared !== null && compared >= 0) state.upstream = compared > 0 ? 'update-available' : 'current';
  return state;
}

export function capabilityStoreComparison(states: readonly SafeCapabilityStoreState[], available: boolean): CapabilityStoreComparison {
  if (!available) return 'unknown';
  if (states.every(state => state.origin === 'verified' && state.localChanges !== 'unknown' && state.upstream !== 'unknown')) return 'known';
  return states.some(state => state.localChanges !== 'unknown' || state.upstream !== 'unknown') ? 'partial' : 'unknown';
}
