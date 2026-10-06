import 'server-only';

import type { AuthorizedIntegrationConnection, IntegrationConnectionOperation } from '@/app/lib/integration-tools/connections/contracts';
import { IntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { IntegrationContractError } from '@/app/lib/integration-tools/contracts';
import type { McpScope } from './scope';
import { requireMcpCredentialScope } from './scope';

function assertBinding(scope: McpScope, authorization: AuthorizedIntegrationConnection): void {
  const shared = scope.shared!;
  const { resource, backend } = authorization;
  if (backend.source !== 'mcp' || resource.source !== 'mcp' || resource.connectionRef !== shared.connectionRef
    || backend.connectionId !== shared.connectionId || resource.ownership.type !== shared.ownership.type
    || resource.ownership.organizationId !== shared.ownership.organizationId
    || (resource.ownership.type === 'team' ? resource.ownership.workspaceId : null) !== (shared.ownership.type === 'team' ? shared.ownership.workspaceId : null)
    || resource.metadataRevision !== shared.revisions.metadataRevision || resource.grantsRevision !== shared.revisions.grantsRevision
    || resource.bindingRevision !== shared.revisions.bindingRevision || authorization.authorizationRevision !== shared.authorizationRevision) {
    throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'The shared MCP connection or its permissions changed. Reload its connection and tools.', 409);
  }
}

function guardError(error: unknown): IntegrationContractError {
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  if (status === 409 || code === 'CONNECTION_BINDING_CHANGED') return Object.assign(new IntegrationContractError('binding_changed', 'The shared MCP connection or its permissions changed. Reload its tools.'), { status: 409 });
  if (status === 403 || status === 404) return Object.assign(new IntegrationContractError('provider_denied', 'The shared MCP connection is not available to this caller.'), { status });
  return Object.assign(new IntegrationContractError('provider_unavailable', 'The shared MCP authorization could not be checked.'), { status: 503 });
}

export function sharedMcpScope(authorization: AuthorizedIntegrationConnection, toolName?: string): McpScope {
  if (authorization.backend.source !== 'mcp' || authorization.resource.source !== 'mcp') throw new Error('An MCP authorization is required.');
  return requireMcpCredentialScope({ shared: {
    connectionRef: authorization.resource.connectionRef, connectionId: authorization.backend.connectionId,
    ownership: authorization.resource.ownership, actor: authorization.actor, operation: authorization.operation,
    revisions: { metadataRevision: authorization.resource.metadataRevision, grantsRevision: authorization.resource.grantsRevision,
      bindingRevision: authorization.resource.bindingRevision }, authorizationRevision: authorization.authorizationRevision,
    ...(toolName ? { toolName } : {}),
  } });
}

/** Public scope objects carry routing only; current SQL authority is always checked again. */
export async function authorizeSharedMcpScope(scopeInput: McpScope, operation?: IntegrationConnectionOperation, toolName?: string): Promise<AuthorizedIntegrationConnection> {
  const scope = requireMcpCredentialScope(scopeInput);
  if (!scope.shared) throw new Error('An explicit shared MCP scope is required.');
  const { authorizeIntegrationConnection } = await import('@/app/lib/integration-tools/connections/store');
  try {
    const authorization = await authorizeIntegrationConnection(scope.shared.actor, scope.shared.connectionRef,
      operation ?? scope.shared.operation, toolName ?? scope.shared.toolName);
    assertBinding(scope, authorization);
    return authorization;
  } catch (error) { throw guardError(error); }
}

/** Hold fresh resource/actor/grant authority through credential publication. */
export async function withSharedMcpAuthority<T>(scopeInput: McpScope, operation: IntegrationConnectionOperation,
  task: (authorization: AuthorizedIntegrationConnection) => Promise<T>): Promise<T> {
  const scope = requireMcpCredentialScope(scopeInput);
  if (!scope.shared) throw new Error('An explicit shared MCP scope is required.');
  const { withAuthorizedIntegrationConnection } = await import('@/app/lib/integration-tools/connections/store');
  let entered = false;
  try { return await withAuthorizedIntegrationConnection(scope.shared.actor, scope.shared.connectionRef, operation, scope.shared.revisions,
    async authorization => {
      try { assertBinding(scope, authorization); } catch (error) { throw guardError(error); }
      entered = true;
      return task(authorization);
    }, scope.shared.toolName); } catch (error) {
    if (entered) throw error;
    throw guardError(error);
  }
}
