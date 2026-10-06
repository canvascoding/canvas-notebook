import type {
  IntegrationExecutionContext,
  IntegrationOperation,
  IntegrationPolicy,
  IntegrationProviderDescriptor,
  IntegrationSource,
} from './contracts';
import { getIntegrationProviderAuthorization } from './connections/provider-authorization';

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
  const authorization = getIntegrationProviderAuthorization(context, provider);
  if (/^(mcp|composio):v1:shared:/u.test(provider.providerRef) && !authorization) return false;
  if (scope.type === 'user' && scope.ownerUserId !== context.actorUserId) return false;
  if (scope.type !== 'user' && (!context.organizationId || scope.organizationId !== context.organizationId)) return false;
  if (scope.type === 'workspace' && (!context.workspaceId || scope.workspaceId !== context.workspaceId) && !authorization) return false;
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
  const authorization = getIntegrationProviderAuthorization(context, provider);
  return isIntegrationProviderVisible(context, policy, provider)
    && isIntegrationOperationAllowed(policy, provider.source, operation)
    && includesOrUnrestricted(policy.allowedToolNames, toolName)
    && (!authorization || authorization.access.canUse && includesOrUnrestricted(authorization.allowedToolNames, toolName));
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

/** The actual operation names in the legacy registry, never guessed provider tool names. */
export const INTEGRATION_LEGACY_CAPABILITY_NAMES = Object.freeze([
  'mcp',
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'composio_execute',
  'COMPOSIO_MANAGE_CONNECTIONS',
] as const);

const LEGACY_INTEGRATION_OPERATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.assign(Object.create(null) as Record<string, readonly string[]>, {
  mcp: ['mcp.list_providers', 'mcp.search_providers', 'mcp.list_tools', 'mcp.search_tools', 'mcp.describe', 'mcp.call'],
  COMPOSIO_SEARCH_TOOLS: ['composio.list_providers', 'composio.search_providers', 'composio.list_tools', 'composio.search_tools'],
  COMPOSIO_GET_TOOL_SCHEMAS: ['composio.describe'],
  composio_execute: ['composio.call'],
  COMPOSIO_MANAGE_CONNECTIONS: ['composio.list_providers', 'composio.search_providers'],
}));

/** Adapt already effective legacy permissions; group names and direct MCP names grant nothing. */
export function createIntegrationPolicyFromLegacyTools(input: {
  legacyToolNames: Iterable<string>;
  planningMode?: boolean;
  emailEventAutomation?: boolean;
  restrictions?: readonly IntegrationPolicy[];
}): IntegrationPolicy {
  const names = new Set(Array.from(input.legacyToolNames, (name) => name.trim()));
  const deny = input.planningMode === true || input.emailEventAutomation === true || names.has('__none__');
  const operations = deny ? [] : [...new Set([...names].flatMap((name) => LEGACY_INTEGRATION_OPERATIONS[name] ?? []))].sort();
  const sources = (['mcp', 'composio'] as const).filter((source) => operations.some((operation) => operation.startsWith(`${source}.`)));
  return intersectIntegrationPolicies({
    allowedSources: sources,
    allowedProviderRefs: null,
    allowedApplications: null,
    allowedToolNames: null,
    allowedOperations: operations,
  }, ...(input.restrictions ?? []));
}
