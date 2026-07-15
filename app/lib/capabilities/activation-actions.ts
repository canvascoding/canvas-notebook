import 'server-only';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import {
  setCapabilityPreference,
  type CapabilityPreferenceRecord,
} from '@/app/lib/capabilities/preference-store';
import type {
  CapabilityResolutionContext,
  EffectiveCapability,
  EffectiveCapabilitySnapshot,
} from '@/app/lib/capabilities/types';
import {
  invalidatePiSystemPromptSnapshotsForOrganization,
  invalidatePiSystemPromptSnapshotsForUser,
} from '@/app/lib/pi/system-prompt-snapshot';
import type { CapabilityDataStorageScope } from '@/app/lib/runtime-data-paths';

function assertPersonalActivationAllowed(capability: EffectiveCapability, enabled: boolean): void {
  if (capability.ref.scopeType !== 'organization') {
    throw new Error('Organization capability not found.');
  }
  if (!enabled && capability.effectivePolicy === 'required') {
    const error = new Error('Required organization capabilities cannot be disabled.');
    Object.assign(error, { code: 'CAPABILITY_REQUIRED', status: 409 });
    throw error;
  }
  if (enabled && (capability.effectivePolicy === 'blocked' || capability.readiness === 'conflict')) {
    const error = new Error('Blocked or conflicting organization capabilities cannot be enabled.');
    Object.assign(error, { code: 'CAPABILITY_BLOCKED', status: 409 });
    throw error;
  }
}

export async function refreshPersonalCapabilityRuntime(userId: string): Promise<void> {
  try {
    const { requestPiRuntimePromptRefreshForUser } = await import('@/app/lib/pi/live-runtime');
    await invalidatePiSystemPromptSnapshotsForUser(userId);
    await requestPiRuntimePromptRefreshForUser(userId);
  } catch (error) {
    console.warn('[Capabilities] Failed to refresh personal capability runtime:', error);
  }
}

export async function refreshOrganizationCapabilityRuntime(organizationId: string): Promise<void> {
  try {
    const { requestPiRuntimePromptRefreshForUser } = await import('@/app/lib/pi/live-runtime');
    const affectedUserIds = await invalidatePiSystemPromptSnapshotsForOrganization(organizationId);
    await Promise.all(affectedUserIds.map((userId) => requestPiRuntimePromptRefreshForUser(userId)));
  } catch (error) {
    console.warn('[Capabilities] Failed to refresh organization capability runtimes:', error);
  }
}

export async function refreshCapabilityRuntimeForScope(input: {
  scope: CapabilityDataStorageScope;
  actorUserId: string;
}): Promise<void> {
  if (input.scope.scopeType === 'organization') {
    await refreshOrganizationCapabilityRuntime(input.scope.organizationId!);
    return;
  }
  await refreshPersonalCapabilityRuntime(input.actorUserId);
}

async function auditActivation(input: {
  organizationId: string;
  actorUserId: string;
  capability: EffectiveCapability;
  enabled: boolean;
  revision: number;
}): Promise<void> {
  await recordAuditEvent({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    source: 'capabilities',
    eventType: 'preference',
    entityType: input.capability.ref.resourceType,
    entityId: input.capability.ref.resourceId,
    action: 'capability.preference.set',
    status: 'success',
    summary: `${input.capability.ref.name} personal activation set to ${input.enabled}.`,
    metadata: {
      resourceType: input.capability.ref.resourceType,
      resourceId: input.capability.ref.resourceId,
      scopeType: input.capability.ref.scopeType,
      sourceType: input.capability.ref.sourceType,
      version: input.capability.ref.version,
      checksum: input.capability.ref.checksum,
      resourceRevision: input.capability.ref.revision,
      policy: input.capability.effectivePolicy,
      enabled: input.enabled,
      preferenceRevision: input.revision,
    },
  });
}

export async function setPersonalCapabilityActivation(input: {
  context: CapabilityResolutionContext;
  actorUserId: string;
  resourceId: string;
  enabled: boolean;
  expectedRevision?: number | null;
  snapshot?: EffectiveCapabilitySnapshot;
}): Promise<{ preference: CapabilityPreferenceRecord; capability: EffectiveCapability }> {
  const snapshot = input.snapshot || await resolveEffectiveCapabilitySnapshot(input.context);
  const capability = snapshot.capabilities.find((entry) => entry.ref.resourceId === input.resourceId);
  if (!capability) throw new Error('Organization capability not found.');
  assertPersonalActivationAllowed(capability, input.enabled);

  const preference = await setCapabilityPreference({
    userId: input.actorUserId,
    resourceId: capability.ref.resourceId,
    enabled: input.enabled,
    expectedRevision: input.expectedRevision,
  });
  await refreshPersonalCapabilityRuntime(input.actorUserId);
  await auditActivation({
    organizationId: input.context.organizationId,
    actorUserId: input.actorUserId,
    capability,
    enabled: input.enabled,
    revision: preference.revision,
  });
  return { preference, capability };
}

export async function setAllPersonalOrganizationCapabilityActivations(input: {
  context: CapabilityResolutionContext;
  actorUserId: string;
  enabled: boolean;
}): Promise<number> {
  const snapshot = await resolveEffectiveCapabilitySnapshot(input.context);
  const capabilities = snapshot.capabilities.filter((capability) => {
    if (capability.ref.scopeType !== 'organization') return false;
    if (!input.enabled && capability.effectivePolicy === 'required') return false;
    if (input.enabled && (capability.effectivePolicy === 'blocked' || capability.readiness === 'conflict')) return false;
    return true;
  });

  for (const capability of capabilities) {
    await setCapabilityPreference({
      userId: input.actorUserId,
      resourceId: capability.ref.resourceId,
      enabled: input.enabled,
    });
  }
  await refreshPersonalCapabilityRuntime(input.actorUserId);
  await recordAuditEvent({
    organizationId: input.context.organizationId,
    userId: input.actorUserId,
    source: 'capabilities',
    eventType: 'preference',
    entityType: 'capability_set',
    action: input.enabled ? 'capabilities.enable_all' : 'capabilities.disable_all',
    status: 'success',
    summary: `${capabilities.length} organization capabilities set to ${input.enabled}.`,
    metadata: {
      enabled: input.enabled,
      resources: capabilities.slice(0, 50).map((capability) => ({
        resourceType: capability.ref.resourceType,
        resourceId: capability.ref.resourceId,
        sourceType: capability.ref.sourceType,
        version: capability.ref.version,
        checksum: capability.ref.checksum,
        resourceRevision: capability.ref.revision,
        policy: capability.effectivePolicy,
      })),
      resourceCount: capabilities.length,
      resourcesTruncated: capabilities.length > 50,
    },
  });
  return capabilities.length;
}
