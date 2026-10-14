import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import type { CapabilityCandidate } from '../types';
import type { CapabilityResourceActor } from './contracts';
import { getCapabilityResourceAccess } from './store';
import { capabilityResourceStorageBinding } from './storage-binding';
import { projectCapabilityPluginChildAccess } from './child-access';

/** Namespace identities remain present even when contents cannot be read. */
export async function applyCapabilityCandidateResourceAccess(
  actor: CapabilityResourceActor,
  candidates: readonly CapabilityCandidate[],
  database?: SqlConnection,
): Promise<CapabilityCandidate[]> {
  const entries = await Promise.all(candidates.map(async (candidate) => {
    const entry = await getCapabilityResourceAccess(actor, capabilityResourceStorageBinding(candidate.ref), database);
    return { ...candidate, resourceMetadata: entry.metadata, resourceAccess: entry.access };
  }));
  const parents = new Map(entries.filter(entry => entry.ref.resourceType === 'plugin')
    .map(entry => [entry.ref.resourceId, entry]));
  return entries.map(candidate => {
    const parent = candidate.pluginResourceId ? parents.get(candidate.pluginResourceId) : undefined;
    const ownEntry = { metadata: candidate.resourceMetadata, access: candidate.resourceAccess };
    const resolved = candidate.pluginResourceId ? projectCapabilityPluginChildAccess(ownEntry,
      parent ? { metadata: parent.resourceMetadata, access: parent.resourceAccess } : null) : ownEntry;
    return resolved.access.canRead ? { ...candidate, resourceMetadata: resolved.metadata, resourceAccess: resolved.access } : {
      ...candidate, resourceMetadata: resolved.metadata, resourceAccess: resolved.access, runtimePath: null, description: '',
      connectionReady: false,
    };
  });
}

/** Recheck before opening a file or delivering runtime contents from an earlier snapshot. */
export async function assertCapabilityCandidateAccess(
  actor: CapabilityResourceActor,
  candidate: CapabilityCandidate,
  operation: 'canRead' | 'canUse',
  parent?: CapabilityCandidate,
): Promise<void> {
  if (candidate.resourceAccess?.[operation] === false) throw new Error('Capability resource is unavailable.');
  if (candidate.pluginResourceId) {
    if (!parent || parent.ref.resourceId !== candidate.pluginResourceId) throw new Error('Source plugin is unavailable.');
    const source = await getCapabilityResourceAccess(actor, capabilityResourceStorageBinding(parent.ref));
    if (!source.access[operation] || parent.resourceAccess?.[operation] === false) throw new Error('Source plugin is unavailable.');
    return;
  }
  const entry = await getCapabilityResourceAccess(actor, capabilityResourceStorageBinding(candidate.ref));
  if (!entry.access[operation]) throw new Error('Capability resource is unavailable.');
}
