import 'server-only';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { refreshOrganizationCapabilityRuntime } from '@/app/lib/capabilities/activation-actions';
import { loadCapabilityCandidates } from '@/app/lib/capabilities/catalog';
import { openDb } from '@/app/lib/db';
import type { OrganizationPermissionSnapshot } from '@/app/lib/organization/bootstrap';
import { assertOrganizationPermission } from '@/app/lib/organization/permissions';
import {
  CapabilityPolicyStore,
  withCapabilityPolicyStore,
} from './policy-store';
import type {
  CapabilityPolicy,
  CapabilityPolicyEffect,
  CapabilityPolicyTargetType,
  CapabilityCandidate,
  CapabilityResourceType,
} from './types';

const RESOURCE_TYPES = new Set<CapabilityResourceType>(['skill', 'plugin']);
const TARGET_TYPES = new Set<CapabilityPolicyTargetType>(['organization', 'role', 'workspace', 'project', 'user']);
const EFFECTS = new Set<CapabilityPolicyEffect>(['optional', 'default-enabled', 'required', 'blocked']);

function requireValue(value: string, label: string, maxLength = 500): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  return normalized;
}

function assertActiveOrganizationMember(permission: OrganizationPermissionSnapshot): void {
  if (permission.status !== 'active') {
    throw new Error('An active organization membership is required.');
  }
}

async function assertOrganizationPolicyResource(input: {
  organizationId: string;
  actorUserId: string;
  permission: OrganizationPermissionSnapshot;
  resourceType: CapabilityResourceType;
  resourceId: string;
}): Promise<CapabilityCandidate> {
  const candidates = await loadCapabilityCandidates({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    role: input.permission.role,
  }, { resolveConnections: false });
  const resource = candidates.find((candidate) => (
    candidate.ref.resourceType === input.resourceType
    && candidate.ref.resourceId === input.resourceId
    && candidate.ref.scopeType === 'organization'
  ));
  if (!resource) {
    throw new Error('Capability policy resource is not an installed organization resource.');
  }
  return resource;
}

async function assertOrganizationPolicyTarget(input: {
  organizationId: string;
  targetType: CapabilityPolicyTargetType;
  targetId: string;
}): Promise<void> {
  if (input.targetType === 'organization') return;
  if (input.targetType === 'role') {
    if (!['owner', 'admin', 'member', 'external'].includes(input.targetId)) {
      throw new Error('Unknown organization role target.');
    }
    return;
  }

  const connection = await openDb();
  try {
    const row = input.targetType === 'user'
      ? await connection.get(
        `SELECT 1 FROM organization_user_permissions
         WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
        [input.organizationId, input.targetId],
      )
      : input.targetType === 'workspace'
        ? await connection.get(
          `SELECT 1 FROM canvas_workspaces WHERE organization_id = ? AND id = ? AND status = 'active'`,
          [input.organizationId, input.targetId],
        )
        : await connection.get(
          `SELECT 1 FROM canvas_projects WHERE organization_id = ? AND id = ? AND status = 'active'`,
          [input.organizationId, input.targetId],
        );
    if (!row) throw new Error(`Capability policy ${input.targetType} target is not active in this organization.`);
  } finally {
    await connection.close();
  }
}

export async function listOrganizationCapabilityPolicies(input: {
  organizationId: string;
  permission: OrganizationPermissionSnapshot;
  store?: CapabilityPolicyStore;
}): Promise<CapabilityPolicy[]> {
  assertActiveOrganizationMember(input.permission);
  assertOrganizationPermission(input.permission, 'canSharePluginsAndSkills');
  if (input.store) return input.store.listOrganizationPolicies(input.organizationId);
  return withCapabilityPolicyStore((store) => store.listOrganizationPolicies(input.organizationId));
}

export async function setOrganizationCapabilityPolicy(input: {
  organizationId: string;
  actorUserId: string;
  permission: OrganizationPermissionSnapshot;
  resourceType: CapabilityResourceType;
  resourceId: string;
  targetType: CapabilityPolicyTargetType;
  targetId: string;
  effect: CapabilityPolicyEffect;
  expectedRevision?: number | null;
  store?: CapabilityPolicyStore;
}): Promise<CapabilityPolicy> {
  assertOrganizationPermission(input.permission, 'canSharePluginsAndSkills');
  if (!RESOURCE_TYPES.has(input.resourceType)) throw new Error('Invalid capability resource type.');
  if (!TARGET_TYPES.has(input.targetType)) throw new Error('Invalid capability policy target type.');
  if (!EFFECTS.has(input.effect)) throw new Error('Invalid capability policy effect.');
  const resourceId = requireValue(input.resourceId, 'resourceId');
  const targetId = requireValue(input.targetId, 'targetId', 200);
  if (input.targetType === 'organization' && targetId !== input.organizationId) {
    throw new Error('Organization policies must target the active organization.');
  }
  const [resource] = await Promise.all([
    assertOrganizationPolicyResource({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      permission: input.permission,
      resourceType: input.resourceType,
      resourceId,
    }),
    assertOrganizationPolicyTarget({
      organizationId: input.organizationId,
      targetType: input.targetType,
      targetId,
    }),
  ]);

  const mutation = (store: CapabilityPolicyStore) => store.upsertPolicy({
    organizationId: input.organizationId,
    resourceType: input.resourceType,
    resourceId,
    targetType: input.targetType,
    targetId,
    effect: input.effect,
    actorUserId: input.actorUserId,
    expectedRevision: input.expectedRevision,
  });
  const policy = input.store ? await mutation(input.store) : await withCapabilityPolicyStore(mutation);

  await recordAuditEvent({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    source: 'capabilities',
    eventType: 'policy',
    entityType: 'capability_policy',
    entityId: policy.id,
    action: 'capability.policy.set',
    status: 'success',
    summary: `Capability policy ${policy.id} set to ${policy.effect}.`,
    metadata: {
      resourceType: policy.resourceType,
      resourceId: policy.resourceId,
      targetType: policy.targetType,
      targetId: policy.targetId,
      effect: policy.effect,
      policy: policy.effect,
      policyRevision: policy.revision,
      scopeType: resource.ref.scopeType,
      sourceType: resource.ref.sourceType,
      version: resource.ref.version,
      checksum: resource.ref.checksum,
      resourceRevision: resource.ref.revision,
    },
  });
  await refreshOrganizationCapabilityRuntime(input.organizationId);
  return policy;
}

export async function removeOrganizationCapabilityPolicy(input: {
  organizationId: string;
  actorUserId: string;
  permission: OrganizationPermissionSnapshot;
  policyId: string;
  expectedRevision: number;
  store?: CapabilityPolicyStore;
}): Promise<CapabilityPolicy> {
  assertOrganizationPermission(input.permission, 'canSharePluginsAndSkills');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error('expectedRevision must be a positive integer.');
  }
  const policyId = requireValue(input.policyId, 'policyId', 200);
  const mutation = (store: CapabilityPolicyStore) => store.deletePolicy({
    id: policyId,
    organizationId: input.organizationId,
    expectedRevision: input.expectedRevision,
  });
  const policy = input.store ? await mutation(input.store) : await withCapabilityPolicyStore(mutation);
  const resource = await assertOrganizationPolicyResource({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    permission: input.permission,
    resourceType: policy.resourceType,
    resourceId: policy.resourceId,
  }).catch(() => null);

  await recordAuditEvent({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    source: 'capabilities',
    eventType: 'policy',
    entityType: 'capability_policy',
    entityId: policy.id,
    action: 'capability.policy.remove',
    status: 'success',
    summary: `Capability policy ${policy.id} removed.`,
    metadata: {
      resourceType: policy.resourceType,
      resourceId: policy.resourceId,
      targetType: policy.targetType,
      targetId: policy.targetId,
      effect: policy.effect,
      policy: policy.effect,
      policyRevision: policy.revision,
      scopeType: resource?.ref.scopeType || 'organization',
      sourceType: resource?.ref.sourceType || null,
      version: resource?.ref.version || null,
      checksum: resource?.ref.checksum || null,
      resourceRevision: resource?.ref.revision || null,
    },
  });
  await refreshOrganizationCapabilityRuntime(input.organizationId);
  return policy;
}
