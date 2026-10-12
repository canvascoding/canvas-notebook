import { createHash } from 'node:crypto';
import type { IntegrationProviderScope } from './contracts';

export type IntegrationProviderIdentity =
  | { source: 'mcp'; scope: IntegrationProviderScope; connectionId: string }
  | { source: 'composio'; scope: IntegrationProviderScope; profileId: string; toolkit: string };

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

function scopeIdentity(scope: IntegrationProviderScope): readonly string[] {
  switch (scope.type) {
    case 'user': return [scope.type, scope.ownerUserId, scope.resourceId];
    case 'organization': return [scope.type, scope.organizationId, scope.resourceId];
    case 'workspace': return [scope.type, scope.organizationId, scope.workspaceId, scope.resourceId];
  }
}

/** Resolve by matching a currently authorised catalogue entry; references carry no routing authority. */
export function createIntegrationProviderRef(identity: IntegrationProviderIdentity): string {
  const binding = identity.source === 'mcp'
    ? [identity.connectionId]
    : [identity.profileId, identity.toolkit];
  return `${identity.source}:v1:${digest([identity.source, scopeIdentity(identity.scope), binding])}`;
}

/** Exact case-sensitive backend tool names remain distinct. */
export function createIntegrationToolRef(providerRef: string, toolName: string): string {
  return `tool:v1:${digest([providerRef, toolName])}`;
}
