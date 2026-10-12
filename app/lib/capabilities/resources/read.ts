import 'server-only';

import { loadCapabilityCandidates } from '../catalog';
import { resolveCapabilityExecutionContextForUser } from '../request-scope';
import { selectVisibleCapabilities } from '../visible-capabilities';
import type { CapabilityCandidate, CapabilityResourceType } from '../types';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { readExactInstalledPlugin } from '@/app/lib/plugins/installed-plugin-read';
import type { CapabilityResourceActor } from './contracts';
import { CapabilityResourceError } from './contracts';
import { assertCapabilityCandidateAccess } from './catalog-access';

/** Return internal namespace stubs too; callers must select before exposing metadata. */
export async function loadCapabilityCandidatesForResourceActor(actor: CapabilityResourceActor): Promise<CapabilityCandidate[]> {
  const state = await readOrganizationPermissionForUser(actor.userId);
  if (state.configured && state.permission?.status !== 'active') {
    throw new CapabilityResourceError('CAPABILITY_RESOURCE_UNAVAILABLE', 'Resource is unavailable.', 403);
  }
  const context = state.organizationId && state.permission?.status === 'active'
    ? await resolveCapabilityExecutionContextForUser({ userId: actor.userId, organizationId: state.organizationId,
      role: state.permission.role, requestedWorkspaceId: actor.workspaceId }).catch(() => {
      throw new CapabilityResourceError('CAPABILITY_RESOURCE_UNAVAILABLE', 'Resource is unavailable.', 404);
    })
    : { userId: actor.userId, organizationId: '' };
  return loadCapabilityCandidates(context, { resolveConnections: false });
}

export async function resolveReadableCapabilityCandidate(actor: CapabilityResourceActor, input: {
  resourceType: CapabilityResourceType; resourceId?: string; name?: string; scope?: 'user' | 'organization';
}): Promise<{ candidate: CapabilityCandidate; candidates: CapabilityCandidate[] }> {
  const candidates = await loadCapabilityCandidatesForResourceActor(actor);
  const visible = input.scope === 'organization' ? candidates.filter(entry => entry.ref.scopeType === 'organization')
    : selectVisibleCapabilities(candidates);
  const matching = visible.filter(entry => entry.ref.resourceType === input.resourceType
    && entry.resourceAccess?.canRead !== false
    && (!input.name || entry.ref.name === input.name)
    && (input.resourceId ? entry.ref.resourceId === input.resourceId || entry.resourceMetadata?.resourceRef === input.resourceId
      : input.scope === 'organization' || entry.ref.ownerUserId === actor.userId || entry.ref.scopeType === 'system'));
  if (matching.length !== 1) throw new CapabilityResourceError('CAPABILITY_RESOURCE_NOT_FOUND', 'Resource not found.', 404);
  await assertReadableCapabilityCandidate(actor, matching[0], candidates);
  return { candidate: matching[0], candidates };
}

export async function assertReadableCapabilityCandidate(actor: CapabilityResourceActor, candidate: CapabilityCandidate,
  candidates: readonly CapabilityCandidate[]): Promise<void> {
  try {
    await assertCapabilityCandidateAccess(actor, candidate, 'canRead', candidates.find(parent => parent.ref.resourceId === candidate.pluginResourceId));
  } catch {
    throw new CapabilityResourceError('CAPABILITY_RESOURCE_NOT_FOUND', 'Resource not found.', 404);
  }
}

export async function readReadableCapabilityPlugin(actor: CapabilityResourceActor, input: {
  resourceId?: string; name?: string; scope?: 'user' | 'organization';
}) {
  const resolved = await resolveReadableCapabilityCandidate(actor, { ...input, resourceType: 'plugin' });
  const { candidate } = resolved;
  const plugin = await readExactInstalledPlugin({ name: candidate.ref.name, resourceId: candidate.ref.resourceId,
    scope: candidate.ref.scopeType === 'organization'
      ? { scopeType: 'organization', organizationId: candidate.ref.organizationId! }
      : { scopeType: 'user', userId: candidate.ref.scopeType === 'system' ? actor.userId : candidate.ref.ownerUserId! } });
  if (!plugin) throw new CapabilityResourceError('CAPABILITY_RESOURCE_NOT_FOUND', 'Resource not found.', 404);
  await assertReadableCapabilityCandidate(actor, candidate, resolved.candidates);
  return { ...resolved, plugin };
}
