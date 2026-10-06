import type {
  IntegrationExecutionContext,
  IntegrationOperation,
  IntegrationPolicy,
  IntegrationProviderDescriptor,
  IntegrationSource,
} from './contracts';

/** The default preserves existing access; it never bypasses an adapter's ownership checks. */
export const UNRESTRICTED_INTEGRATION_POLICY: IntegrationPolicy = Object.freeze({
  allowedSources: null,
  allowedProviderRefs: null,
  allowedApplications: null,
  allowedToolNames: null,
  allowedOperations: null,
});

function includesOrUnrestricted<T>(allowed: readonly T[] | null, value: T): boolean {
  return allowed === null || allowed.includes(value);
}

export function isIntegrationOperationAllowed(
  policy: IntegrationPolicy,
  source: IntegrationSource,
  operation: IntegrationOperation,
): boolean {
  return includesOrUnrestricted(policy.allowedSources, source)
    && includesOrUnrestricted(policy.allowedOperations, `${source}.${operation}`);
}

/** Scope checks are additional guards, not grants. Adapters must first authorize each resource. */
export function isIntegrationProviderVisible(
  context: IntegrationExecutionContext,
  policy: IntegrationPolicy,
  provider: IntegrationProviderDescriptor,
): boolean {
  if (!context.actorUserId.trim() || !context.policyRevision.trim()) return false;
  const scope = provider.scope;
  if (scope.type === 'user' && scope.ownerUserId !== context.actorUserId) return false;
  if (scope.type !== 'user' && (!context.organizationId || scope.organizationId !== context.organizationId)) return false;
  if (scope.type === 'workspace' && (!context.workspaceId || scope.workspaceId !== context.workspaceId)) return false;
  return includesOrUnrestricted(policy.allowedSources, provider.source)
    && includesOrUnrestricted(policy.allowedProviderRefs, provider.providerRef)
    && (policy.allowedApplications === null
      || (provider.application !== undefined && policy.allowedApplications.includes(provider.application)));
}

export function isIntegrationToolAllowed(
  context: IntegrationExecutionContext,
  policy: IntegrationPolicy,
  provider: IntegrationProviderDescriptor,
  toolName: string,
  operation: IntegrationOperation,
): boolean {
  return isIntegrationProviderVisible(context, policy, provider)
    && isIntegrationOperationAllowed(policy, provider.source, operation)
    && includesOrUnrestricted(policy.allowedToolNames, toolName);
}

/** Restrictions compose monotonically. An empty set cannot be restored by a later policy. */
export function intersectIntegrationPolicies(...policies: readonly IntegrationPolicy[]): IntegrationPolicy {
  function intersect<T>(values: Array<readonly T[] | null>): readonly T[] | null {
    const restricted = values.filter((value): value is readonly T[] => value !== null);
    if (!restricted.length) return null;
    return [...new Set(restricted[0])].filter((value) => restricted.every((allowed) => allowed.includes(value)));
  }
  return {
    allowedSources: intersect(policies.map((policy) => policy.allowedSources)),
    allowedProviderRefs: intersect(policies.map((policy) => policy.allowedProviderRefs)),
    allowedApplications: intersect(policies.map((policy) => policy.allowedApplications)),
    allowedToolNames: intersect(policies.map((policy) => policy.allowedToolNames)),
    allowedOperations: intersect(policies.map((policy) => policy.allowedOperations)),
  };
}
