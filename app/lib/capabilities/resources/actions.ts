import 'server-only';

import { Value } from 'typebox/value';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { refreshCapabilityRuntimeForScope } from '../activation-actions';
import { loadCapabilityCandidates } from '../catalog';
import { resolveEffectiveCapabilities } from '../effective-resolver';
import { withCapabilityPolicyStore } from '../policy-store';
import type { CapabilityCandidate, CapabilityResolutionContext, EffectiveCapability } from '../types';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import type { OrganizationPolicyTargetCatalog } from '@/app/lib/organization/policy-targets';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import {
  CapabilityResourceError,
  type CapabilityResourceAccessEntry, type CapabilityResourceActor,
  type CapabilityResourceConfiguration, type CapabilityResourceDescriptor,
  type CapabilityResourceMutation, type CapabilityResourceOwnerScope,
  type CapabilityResourceStorageBinding,
} from './contracts';
import { CapabilityResourceConfigurationSchema, CapabilityResourceMutationSchema, CapabilityResourceReferenceSchema } from './schemas';
import { readCapabilityResourceLabels } from './labels';
import { capabilityResourceStorageBinding } from './storage-binding';
import { projectCapabilityPluginChildAccess } from './child-access';
import {
  adoptCapabilityResource, findCapabilityResourceRecord, getCapabilityResourceAccess,
  listCapabilityResourceGrants, listCapabilityResourceGrantTargets, mutateCapabilityResource,
} from './store';

function invalidRequest(): never {
  throw new CapabilityResourceError('CAPABILITY_RESOURCE_REQUEST_INVALID', 'The resource request does not match the supported fields.');
}

export function parseCapabilityResourceMutation(value: unknown): CapabilityResourceMutation {
  let captured: unknown;
  try { captured = structuredClone(value); } catch { return invalidRequest(); }
  if (!Value.Check(CapabilityResourceMutationSchema, captured)) return invalidRequest();
  const input = captured as CapabilityResourceMutation;
  if (input.metadata === undefined && input.grants === undefined && input.accessMode === undefined) return invalidRequest();
  if (input.metadata && Object.keys(input.metadata).length === 0) return invalidRequest();
  return input;
}

export function parseCapabilityResourceConfiguration(value: unknown): CapabilityResourceConfiguration {
  let captured: unknown;
  try { captured = structuredClone(value); } catch { return invalidRequest(); }
  if (!Value.Check(CapabilityResourceConfigurationSchema, captured)) return invalidRequest();
  const input = captured as CapabilityResourceConfiguration;
  if (input.expectedMetadataRevision !== 0 || input.expectedGrantsRevision !== 0) {
    throw new CapabilityResourceError('CAPABILITY_RESOURCE_REVISION_CONFLICT', 'This resource is already configured. Reload its current revisions.', 409);
  }
  return input;
}

function captureReference(value: unknown): string {
  if (!Value.Check(CapabilityResourceReferenceSchema, value)) return invalidRequest();
  const ref = (value as string).trim();
  if (!ref) return invalidRequest();
  return ref;
}

async function resolveActor(input: CapabilityResourceActor): Promise<{ actor: CapabilityResourceActor; context: CapabilityResolutionContext }> {
  const actor = { userId: input.userId, workspaceId: input.workspaceId?.trim() || null };
  if (!actor.userId || actor.userId.length > 200 || actor.workspaceId && actor.workspaceId.length > 200) return invalidRequest();
  const state = await readOrganizationPermissionForUser(actor.userId);
  if (state.configured && state.permission?.status !== 'active') {
    throw new CapabilityResourceError('CAPABILITY_RESOURCE_ACCESS_DENIED', 'Active organization membership is required.', 403);
  }
  let workspace: Awaited<ReturnType<typeof resolveAgentSessionWorkspaceForUser>> | null = null;
  if (actor.workspaceId) {
    workspace = await resolveAgentSessionWorkspaceForUser({ userId: actor.userId, workspaceId: actor.workspaceId, permissions: ['canRead'] });
    if ((workspace.organizationId ?? null) !== state.organizationId) {
      throw new CapabilityResourceError('CAPABILITY_RESOURCE_ACCESS_DENIED', 'The workspace is outside the active organization.', 403);
    }
    actor.workspaceId = workspace.workspaceId;
  }
  return { actor, context: {
    userId: actor.userId, organizationId: state.organizationId || '', role: state.permission?.role || null,
    workspaceId: workspace?.workspaceId || null, projectId: workspace?.projectId || null,
  } };
}

function binding(candidate: CapabilityCandidate): CapabilityResourceStorageBinding {
  return capabilityResourceStorageBinding(candidate.ref);
}

function sameBinding(left: CapabilityResourceStorageBinding, right: CapabilityResourceStorageBinding): boolean {
  return (Object.keys(left) as Array<keyof CapabilityResourceStorageBinding>).every(key => left[key] === right[key]);
}

function notFound(): never {
  throw new CapabilityResourceError('CAPABILITY_RESOURCE_NOT_FOUND', 'The resource is unavailable in this context.', 404);
}

async function resolveInstalledCandidate(actor: CapabilityResourceActor, context: CapabilityResolutionContext, ref: string): Promise<CapabilityCandidate> {
  const record = await findCapabilityResourceRecord(ref);
  let sourceContext = context;
  if (record) {
    const entry = await getCapabilityResourceAccess(actor, record.storage);
    if (!entry.access.canRead) return notFound();
    if (record.storage.scopeType === 'organization' && record.storage.organizationId !== context.organizationId) return notFound();
    if (record.storage.scopeType === 'user' && record.storage.ownerUserId !== actor.userId) {
      if (!record.storage.ownerUserId || record.metadata.ownership.type !== 'user'
        || record.metadata.ownership.organizationId !== context.organizationId) return notFound();
      sourceContext = { ...context, userId: record.storage.ownerUserId };
    }
  }
  let candidates = await loadCapabilityCandidates(sourceContext, { resolveConnections: false, applyResourceAccess: false });
  let matches = candidates.filter(candidate => candidate.ref.resourceId === (record?.metadata.legacyResourceId ?? ref));
  if (!record && matches.length === 0) {
    // A readonly child has no independent managed row. Resolve only an exact
    // identity exposed by this actor's current ACL catalog, never a foreign
    // owner's directory or a name supplied by the caller.
    candidates = await loadCapabilityCandidates(context, { resolveConnections: false });
    matches = candidates.filter(candidate => candidate.ref.resourceId === ref && candidate.resourceAccess?.canRead !== false);
  }
  if (matches.length !== 1) return notFound();
  const candidate = matches[0];
  if (record && !sameBinding(binding(candidate), record.storage)) return notFound();
  const entry = await candidateAccess(actor, candidate, candidates);
  if (!entry.access.canRead) return notFound();
  return candidate;
}

async function candidateAccess(actor: CapabilityResourceActor, candidate: CapabilityCandidate,
  candidates: readonly CapabilityCandidate[]): Promise<CapabilityResourceAccessEntry> {
  const entry = await getCapabilityResourceAccess(actor, binding(candidate));
  if (!candidate.pluginResourceId) return entry;
  const parent = candidates.find(value => value.ref.resourceType === 'plugin' && value.ref.resourceId === candidate.pluginResourceId);
  if (!parent) return projectCapabilityPluginChildAccess(entry, null);
  const parentEntry = await getCapabilityResourceAccess(actor, binding(parent));
  return projectCapabilityPluginChildAccess(entry, parentEntry);
}

async function effectiveEntries(context: CapabilityResolutionContext, candidates?: CapabilityCandidate[]): Promise<Map<string, EffectiveCapability>> {
  const [entries, policies] = await Promise.all([
    candidates ? Promise.resolve(candidates) : loadCapabilityCandidates(context, { resolveConnections: false }),
    context.organizationId ? withCapabilityPolicyStore(store => store.listOrganizationPolicies(context.organizationId)) : Promise.resolve([]),
  ]);
  return new Map(resolveEffectiveCapabilities({ context, candidates: entries, policies }).capabilities.map(value => [value.ref.resourceId, value]));
}

async function descriptor(actor: CapabilityResourceActor, context: CapabilityResolutionContext, candidate: CapabilityCandidate,
  entry?: CapabilityResourceAccessEntry, effectiveById?: Map<string, EffectiveCapability>): Promise<CapabilityResourceDescriptor> {
  const entries = effectiveById ?? await effectiveEntries(context);
  const resolved = entry ?? await candidateAccess(actor, candidate, [...entries.values()]);
  const ref = candidate.ref;
  // This management action never discovers remote tools or starts OAuth. Connection readiness is unchecked.
  const effective = entries.get(ref.resourceId);
  const result: CapabilityResourceDescriptor = {
    metadata: resolved.metadata, access: resolved.access,
    artifact: { resourceType: ref.resourceType, resourceId: ref.resourceId, scopeType: ref.scopeType, name: ref.name,
      version: ref.version, revision: ref.revision, checksum: ref.checksum, sourceType: ref.sourceType, sourcePluginId: ref.sourcePluginId },
    activation: { effectivePolicy: effective?.effectivePolicy || 'optional', enabled: effective?.effectiveEnabled === true && resolved.access.canUse,
      readiness: !effective || !resolved.access.canUse ? 'blocked'
        : effective.effectiveEnabled && (candidate.connectionRequirementCount || 0) > 0 ? 'unknown' : effective.readiness,
      blockedReason: effective?.blockedReason || (!resolved.access.canUse ? 'Resource use is not granted.' : null) },
  };
  if (resolved.access.canManage) result.grants = resolved.metadata.metadataRevision === 0 ? []
    : await listCapabilityResourceGrants(actor, resolved.metadata.resourceRef);
  return { ...result, ...await readCapabilityResourceLabels(actor, resolved) };
}

export async function listCapabilityResources(input: CapabilityResourceActor): Promise<CapabilityResourceDescriptor[]> {
  const { actor, context } = await resolveActor(input);
  const candidates = await loadCapabilityCandidates(context, { resolveConnections: false });
  const effective = await effectiveEntries(context, candidates);
  const result: CapabilityResourceDescriptor[] = [];
  for (const candidate of candidates) {
    const entry = await candidateAccess(actor, candidate, candidates);
    if (entry.access.canRead) result.push(await descriptor(actor, context, candidate, entry, effective));
  }
  return result;
}

export async function inspectCapabilityResource(input: CapabilityResourceActor, reference: string): Promise<CapabilityResourceDescriptor> {
  const ref = captureReference(reference);
  const { actor, context } = await resolveActor(input);
  const candidate = await resolveInstalledCandidate(actor, context, ref);
  return descriptor(actor, context, candidate);
}

function assertWritableArtifact(candidate: CapabilityCandidate): void {
  if (candidate.ref.scopeType === 'system' || candidate.ref.sourceType !== 'standalone') {
    throw new CapabilityResourceError('CAPABILITY_RESOURCE_READ_ONLY', 'Configure the owning plugin or create a separate editable variant.', 403);
  }
}

function configuredOwnership(candidate: CapabilityCandidate, choice: CapabilityResourceConfiguration['ownership'], organizationId: string): Exclude<CapabilityResourceOwnerScope, { type: 'system' }> | undefined {
  if (!choice) return undefined;
  const ref = candidate.ref;
  if (choice.type === 'user' && ref.scopeType === 'user' && ref.ownerUserId) {
    return { type: 'user', ownerUserId: ref.ownerUserId, organizationId: organizationId || null };
  }
  if (ref.scopeType !== 'organization' || !ref.organizationId || choice.type === 'user') {
    throw new CapabilityResourceError('CAPABILITY_RESOURCE_SCOPE_INVALID', 'Ownership must match the installed artifact. Publish a new shared resource to change its storage scope.');
  }
  return choice.type === 'team' ? { type: 'team', organizationId: ref.organizationId, workspaceId: choice.workspaceId }
    : { type: 'organization', organizationId: ref.organizationId };
}

async function afterMutation(actor: CapabilityResourceActor, candidate: CapabilityCandidate, entry: CapabilityResourceAccessEntry): Promise<void> {
  const owner = entry.metadata.ownership;
  const organizationId = owner.type === 'system' ? null : owner.organizationId;
  await recordAuditEvent({ organizationId, userId: actor.userId, workspaceId: actor.workspaceId,
    source: 'capabilities', eventType: 'policy', entityType: 'capability_resource', entityId: entry.metadata.resourceRef,
    action: 'capability.resource.update', status: 'success', summary: 'Resource metadata and access updated.',
    metadata: { resourceType: candidate.ref.resourceType, legacyResourceId: candidate.ref.resourceId,
      metadataRevision: entry.metadata.metadataRevision, grantsRevision: entry.metadata.grantsRevision } }).catch(() => null);
  await refreshCapabilityRuntimeForScope({ actorUserId: actor.userId, scope: organizationId
    ? { scopeType: 'organization', organizationId } : { scopeType: 'user', userId: actor.userId } });
}

export async function configureCapabilityResource(input: CapabilityResourceActor, reference: string, value: unknown): Promise<CapabilityResourceDescriptor> {
  const ref = captureReference(reference);
  const configuration = parseCapabilityResourceConfiguration(value);
  const { actor, context } = await resolveActor(input);
  const candidate = await resolveInstalledCandidate(actor, context, ref);
  assertWritableArtifact(candidate);
  const { ownership: choice, ...mutation } = configuration;
  const ownership = configuredOwnership(candidate, choice, context.organizationId);
  const entry = await adoptCapabilityResource(actor, binding(candidate), { ...mutation, ...(ownership ? { ownership } : {}) });
  await afterMutation(actor, candidate, entry);
  return descriptor(actor, context, candidate, entry);
}

export async function updateCapabilityResource(input: CapabilityResourceActor, reference: string, value: unknown): Promise<CapabilityResourceDescriptor> {
  const ref = captureReference(reference);
  const mutation = parseCapabilityResourceMutation(value);
  const { actor, context } = await resolveActor(input);
  const candidate = await resolveInstalledCandidate(actor, context, ref);
  assertWritableArtifact(candidate);
  const record = await findCapabilityResourceRecord(ref);
  const entry = record ? await mutateCapabilityResource(actor, record.metadata.resourceRef, mutation)
    : await adoptCapabilityResource(actor, binding(candidate), mutation);
  await afterMutation(actor, candidate, entry);
  // A manager may intentionally revoke their own grant. Return the committed revisions without re-authorizing access to contents.
  return descriptor(actor, context, candidate, entry);
}

export async function listCapabilityResourceTargets(input: CapabilityResourceActor, reference: string): Promise<OrganizationPolicyTargetCatalog> {
  const ref = captureReference(reference);
  const { actor, context } = await resolveActor(input);
  const candidate = await resolveInstalledCandidate(actor, context, ref);
  const access = await getCapabilityResourceAccess(actor, binding(candidate));
  if (!access.access.canManage) throw new CapabilityResourceError('CAPABILITY_RESOURCE_ACCESS_DENIED', 'Resource management permission is required.', 403);
  return listCapabilityResourceGrantTargets(actor, access.metadata.resourceRef, binding(candidate));
}
