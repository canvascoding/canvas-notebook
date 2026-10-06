import type {
  IntegrationExecutionContext,
  IntegrationOperation,
  IntegrationPolicy,
  IntegrationProviderDescriptor,
  IntegrationProviderToolRule,
  IntegrationSource,
} from './contracts';
import { getIntegrationProviderAuthorization } from './connections/provider-authorization';
import { getAttachedPersonalWorkflowProviderDescriptor } from './workflow-personal-provenance';

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

const PROVIDER_OPERATIONS: readonly IntegrationOperation[] = [
  'list_providers', 'search_providers', 'list_tools', 'search_tools', 'describe', 'call',
];

/** Invalid or duplicate routing rules are never interpreted as unrestricted. */
export function isIntegrationProviderToolRulesValid(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value) || value.length > 2048) return false;
  const seen = new Set<string>();
  const names = (entry: unknown) => entry === null || Array.isArray(entry) && entry.length <= 2048
    && entry.every(name => typeof name === 'string' && name.trim().length > 0 && name.length <= 256);
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['source', 'providerRef', 'allowedToolNames', 'allowedOperations'].includes(key))) return false;
    const rule = entry as Record<string, unknown>;
    if (rule.source !== 'mcp' && rule.source !== 'composio'
      || typeof rule.providerRef !== 'string' || !rule.providerRef.startsWith(`${rule.source}:v1:`)
      || rule.providerRef.length > 256 || !rule.providerRef.trim()
      || !names(rule.allowedToolNames) || !names(rule.allowedOperations)
      || Array.isArray(rule.allowedOperations) && rule.allowedOperations.some(operation => !PROVIDER_OPERATIONS.includes(operation))) return false;
    const key = `${rule.source}:${rule.providerRef}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function providerRule(policy: IntegrationPolicy, source: IntegrationSource, providerRef: string): IntegrationProviderToolRule | null | undefined {
  if (!isIntegrationProviderToolRulesValid(policy.providerToolRules)) return undefined;
  if (policy.providerToolRules == null) return null;
  return policy.providerToolRules.find(rule => rule.source === source && rule.providerRef === providerRef);
}

export function isIntegrationProviderReferenceAllowed(policy: IntegrationPolicy, source: IntegrationSource, providerRef: string): boolean {
  return providerRule(policy, source, providerRef) !== undefined
    && includesOrUnrestricted(policy.allowedSources, source)
    && includesOrUnrestricted(policy.allowedProviderRefs, providerRef);
}

/** Apply the concrete provider's tool set before provider pagination or schema lookup. */
export function integrationPolicyAllowedToolNames(policy: IntegrationPolicy, source: IntegrationSource, providerRef: string): readonly string[] | null {
  const rule = providerRule(policy, source, providerRef);
  if (rule === undefined) return [];
  if (rule === null || rule.allowedToolNames === null) return policy.allowedToolNames;
  return policy.allowedToolNames === null ? rule.allowedToolNames : policy.allowedToolNames.filter(name => rule.allowedToolNames!.includes(name));
}

export function isIntegrationProviderOperationAllowed(policy: IntegrationPolicy, source: IntegrationSource,
  providerRef: string, operation: IntegrationOperation): boolean {
  const rule = providerRule(policy, source, providerRef);
  return rule !== undefined && isIntegrationOperationAllowed(policy, source, operation)
    && (rule === null || includesOrUnrestricted(rule.allowedOperations, operation));
}

export function isIntegrationOperationAllowed(
  policy: IntegrationPolicy,
  source: IntegrationSource,
  operation: IntegrationOperation,
): boolean {
  return isIntegrationProviderToolRulesValid(policy.providerToolRules)
    && (policy.providerToolRules == null || policy.providerToolRules.some(rule => rule.source === source
      && includesOrUnrestricted(rule.allowedOperations, operation)))
    && includesOrUnrestricted(policy.allowedSources, source)
    && includesOrUnrestricted(policy.allowedOperations, `${source}.${operation}`);
}

/** Scope checks are additional guards, not grants. Adapters must first authorize each resource. */
export function isIntegrationProviderVisible(
  context: IntegrationExecutionContext,
  policy: IntegrationPolicy,
  provider: IntegrationProviderDescriptor,
): boolean {
  if (!context.actorUserId.trim() || !context.policyRevision.trim()) return false;
  if (!isIntegrationProviderReferenceAllowed(policy, provider.source, provider.providerRef)) return false;
  if (/^(mcp|composio):v1:personal:/u.test(provider.providerRef) && !getAttachedPersonalWorkflowProviderDescriptor(context, provider.providerRef)) return false;
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
    && isIntegrationProviderOperationAllowed(policy, provider.source, provider.providerRef, operation)
    && includesOrUnrestricted(integrationPolicyAllowedToolNames(policy, provider.source, provider.providerRef), toolName)
    && (!authorization || authorization.access.canUse && includesOrUnrestricted(authorization.allowedToolNames, toolName));
}

/** Restrictions compose monotonically. An empty set cannot be restored by a later policy. */
export function intersectIntegrationPolicies(...policies: readonly IntegrationPolicy[]): IntegrationPolicy {
  function intersect<T>(values: Array<readonly T[] | null>): readonly T[] | null {
    const restricted = values.filter((value): value is readonly T[] => value !== null);
    if (!restricted.length) return null;
    return [...new Set(restricted[0])].filter((value) => restricted.every((allowed) => allowed.includes(value)));
  }
  const matrices = policies.flatMap(policy => !isIntegrationProviderToolRulesValid(policy.providerToolRules)
    ? [[] as readonly IntegrationProviderToolRule[]] : policy.providerToolRules == null ? [] : [policy.providerToolRules]);
  const providerToolRules = matrices.length ? matrices[0].flatMap(rule => {
    const matching = matrices.map(matrix => matrix.find(candidate => candidate.source === rule.source && candidate.providerRef === rule.providerRef));
    if (matching.some(candidate => !candidate)) return [];
    const entries = matching as IntegrationProviderToolRule[];
    return [{ source: rule.source, providerRef: rule.providerRef,
      allowedToolNames: intersect(entries.map(entry => entry.allowedToolNames)),
      allowedOperations: intersect(entries.map(entry => entry.allowedOperations)) }];
  }).sort((a, b) => `${a.source}:${a.providerRef}`.localeCompare(`${b.source}:${b.providerRef}`, 'en')) : undefined;
  return {
    allowedSources: intersect(policies.map((policy) => policy.allowedSources)),
    allowedProviderRefs: intersect(policies.map((policy) => policy.allowedProviderRefs)),
    allowedApplications: intersect(policies.map((policy) => policy.allowedApplications)),
    allowedToolNames: intersect(policies.map((policy) => policy.allowedToolNames)),
    allowedOperations: intersect(policies.map((policy) => policy.allowedOperations)),
    ...(providerToolRules === undefined ? {} : { providerToolRules }),
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
