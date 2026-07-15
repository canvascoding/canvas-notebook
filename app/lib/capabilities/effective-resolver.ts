import { createHash } from 'node:crypto';

import type {
  CapabilityCandidate,
  CapabilityConflict,
  CapabilityPolicy,
  CapabilityPolicyEffect,
  CapabilityPolicyTargetType,
  CapabilityResolutionContext,
  EffectiveCapability,
  EffectiveCapabilitySnapshot,
} from './types';

const TARGET_PRIORITY: Record<CapabilityPolicyTargetType, number> = {
  organization: 0,
  role: 1,
  workspace: 2,
  project: 3,
  user: 4,
};

function matchesTarget(policy: CapabilityPolicy, context: CapabilityResolutionContext): boolean {
  const expectedTarget: Partial<Record<CapabilityPolicyTargetType, string | null | undefined>> = {
    organization: context.organizationId,
    role: context.role,
    workspace: context.workspaceId,
    project: context.projectId,
    user: context.userId,
  };
  return expectedTarget[policy.targetType] === policy.targetId;
}

function effectivePolicyForCandidate(
  candidate: CapabilityCandidate,
  policies: CapabilityPolicy[],
  context: CapabilityResolutionContext,
): { effect: CapabilityPolicyEffect; matched: CapabilityPolicy[] } {
  const matched = policies.filter((policy) => (
      policy.organizationId === context.organizationId
      && policy.resourceType === candidate.ref.resourceType
      && policy.resourceId === candidate.ref.resourceId
      && matchesTarget(policy, context)
    ));
  const sorted = [...matched].sort((left, right) => {
      if (left.effect === 'blocked' && right.effect !== 'blocked') return -1;
      if (right.effect === 'blocked' && left.effect !== 'blocked') return 1;
      if (left.effect === 'required' && right.effect !== 'required') return -1;
      if (right.effect === 'required' && left.effect !== 'required') return 1;
      const targetDelta = TARGET_PRIORITY[right.targetType] - TARGET_PRIORITY[left.targetType];
      if (targetDelta !== 0) return targetDelta;
      return right.revision - left.revision;
    });
  const blocked = sorted.find((policy) => policy.effect === 'blocked');
  const required = sorted.find((policy) => policy.effect === 'required');
  const effective = blocked
    || required
    || sorted.find((policy) => policy.effect === 'optional' || policy.effect === 'default-enabled');
  return { effect: effective?.effect || 'optional', matched: sorted };
}

function scopeRank(candidate: CapabilityCandidate): number {
  if (candidate.ref.scopeType === 'system') return 0;
  if (candidate.ref.scopeType === 'organization') return 1;
  return 2;
}

function resolveNameConflicts(candidates: CapabilityCandidate[]): {
  blockedByConflict: Map<string, { reason: string; resourceIds: string[] }>;
  conflicts: CapabilityConflict[];
} {
  const blockedByConflict = new Map<string, { reason: string; resourceIds: string[] }>();
  const conflicts: CapabilityConflict[] = [];
  const byName = new Map<string, CapabilityCandidate[]>();

  for (const candidate of candidates) {
    const key = `${candidate.ref.resourceType}:${candidate.ref.name.toLowerCase()}`;
    const current = byName.get(key) || [];
    if (!current.some((entry) => entry.ref.resourceId === candidate.ref.resourceId)) {
      current.push(candidate);
    }
    byName.set(key, current);
  }

  for (const entries of byName.values()) {
    if (entries.length < 2) continue;
    const bestRank = Math.min(...entries.map(scopeRank));
    const protectedEntries = entries.filter((entry) => scopeRank(entry) === bestRank);
    const lowerEntries = entries.filter((entry) => scopeRank(entry) > bestRank);
    const allIds = entries.map((entry) => entry.ref.resourceId).sort();

    if (protectedEntries.length > 1) {
      const reason = `Conflicting ${entries[0].ref.resourceType} resources named "${entries[0].ref.name}" exist in the same effective scope.`;
      for (const entry of entries) {
        blockedByConflict.set(entry.ref.resourceId, { reason, resourceIds: allIds });
      }
      conflicts.push({
        resourceType: entries[0].ref.resourceType,
        name: entries[0].ref.name,
        protectedResourceId: null,
        resourceIds: allIds,
        reason,
      });
      continue;
    }

    const protectedEntry = protectedEntries[0];
    const reason = `The ${protectedEntry.ref.scopeType}-scoped resource "${protectedEntry.ref.name}" protects its name from lower scopes.`;
    for (const entry of lowerEntries) {
      blockedByConflict.set(entry.ref.resourceId, { reason, resourceIds: allIds });
    }
    conflicts.push({
      resourceType: protectedEntry.ref.resourceType,
      name: protectedEntry.ref.name,
      protectedResourceId: protectedEntry.ref.resourceId,
      resourceIds: allIds,
      reason,
    });
  }

  return { blockedByConflict, conflicts };
}

function stableSnapshotId(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function resolveEffectiveCapabilities(input: {
  context: CapabilityResolutionContext;
  candidates: CapabilityCandidate[];
  policies: CapabilityPolicy[];
  createdAt?: Date;
}): EffectiveCapabilitySnapshot {
  const deduplicatedCandidates = Array.from(new Map(
    input.candidates.map((candidate) => [candidate.ref.resourceId, candidate]),
  ).values());
  const conflictResolution = resolveNameConflicts(deduplicatedCandidates);

  const preliminary = deduplicatedCandidates.map((candidate): EffectiveCapability => {
    const policy = effectivePolicyForCandidate(candidate, input.policies, input.context);
    const conflict = conflictResolution.blockedByConflict.get(candidate.ref.resourceId);
    const blockedByPolicy = policy.effect === 'blocked';
    const effectiveEnabled = !conflict && !blockedByPolicy && (
      candidate.ref.scopeType === 'system'
      || policy.effect === 'required'
      || (candidate.ref.scopeType === 'organization'
        ? policy.effect === 'default-enabled'
          ? candidate.enabled && candidate.userPreference !== 'disabled'
          : candidate.enabled && candidate.userPreference === 'enabled'
        : candidate.enabled)
    );
    const needsConnection = candidate.ref.resourceType === 'plugin'
      && effectiveEnabled
      && (candidate.connectionRequirementCount || 0) > 0
      && candidate.connectionReady === false;

    return {
      ...candidate,
      effectivePolicy: policy.effect,
      matchedPolicies: policy.matched,
      effectiveEnabled,
      readiness: conflict
        ? 'conflict'
        : blockedByPolicy
          ? 'blocked'
          : !effectiveEnabled
            ? 'disabled'
            : needsConnection
              ? 'personal-connection-required'
              : 'available',
      blockedReason: conflict?.reason || (blockedByPolicy ? 'Blocked by organization policy.' : null),
      conflictResourceIds: conflict?.resourceIds || [],
    };
  });

  const pluginState = new Map(
    preliminary
      .filter((entry) => entry.ref.resourceType === 'plugin')
      .map((entry) => [entry.ref.resourceId, entry]),
  );
  const capabilities = preliminary.map((entry): EffectiveCapability => {
    if (!entry.pluginResourceId) return entry;
    if (entry.readiness === 'conflict') return entry;
    const plugin = pluginState.get(entry.pluginResourceId);
    if (plugin?.effectiveEnabled) {
      if (plugin.readiness === 'personal-connection-required') {
        return {
          ...entry,
          effectiveEnabled: false,
          readiness: 'personal-connection-required',
          blockedReason: `Source plugin "${plugin.ref.name}" requires a personal connection.`,
        };
      }
      if (
        entry.ref.scopeType === 'organization'
        && entry.matchedPolicies.length === 0
        && entry.userPreference !== 'disabled'
      ) {
        return {
          ...entry,
          effectiveEnabled: true,
          readiness: 'available',
          blockedReason: null,
        };
      }
      return entry;
    }
    if (!plugin) return entry;
    return {
      ...entry,
      effectiveEnabled: false,
      readiness: plugin.readiness === 'conflict' ? 'conflict' : 'blocked',
      blockedReason: plugin.blockedReason || `Source plugin "${plugin.ref.name}" is not available.`,
    };
  }).sort((left, right) => {
    const typeDelta = left.ref.resourceType.localeCompare(right.ref.resourceType);
    if (typeDelta !== 0) return typeDelta;
    const nameDelta = left.ref.name.localeCompare(right.ref.name);
    if (nameDelta !== 0) return nameDelta;
    return left.ref.resourceId.localeCompare(right.ref.resourceId);
  });

  const snapshotInput = capabilities.map((entry) => ({
    resourceId: entry.ref.resourceId,
    version: entry.ref.version,
    revision: entry.ref.revision,
    checksum: entry.ref.checksum,
    policy: entry.effectivePolicy,
    readiness: entry.readiness,
  }));

  return {
    schemaVersion: 1,
    snapshotId: stableSnapshotId(snapshotInput),
    organizationId: input.context.organizationId,
    userId: input.context.userId,
    workspaceId: input.context.workspaceId || null,
    projectId: input.context.projectId || null,
    createdAt: (input.createdAt || new Date()).toISOString(),
    capabilities,
    conflicts: conflictResolution.conflicts,
  };
}
