import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import type { AuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/contracts';
import { isAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { IntegrationContractError } from '@/app/lib/integration-tools/contracts';
import { schemaFingerprint } from '@/app/lib/integration-tools/schema';
import { readExistingConfig } from '@/app/lib/mcp/read-only-config';
import { resolveMcpConfigPath } from '@/app/lib/mcp/config';
import { sharedMcpScope } from '@/app/lib/mcp/shared-access';
import { hashMcpAuthConfig } from '@/app/lib/mcp/connection-identity';
import { readMcpOAuthLifecycle } from '@/app/lib/mcp/oauth-lifecycle';
import { listMcpServerDefinitions } from '@/app/lib/mcp/server-definitions';
import { assertUnifiedEnvReadable, readUnifiedEnvState } from '@/app/lib/secrets/unified-env-store';

/** A local stamp of a genuine selected source. It issues no runtime or configuration authority. */
export async function readAgentWorkflowSharedSourceMetadata(authorization: AuthorizedIntegrationConnection,
  database?: SqlConnection): Promise<string> {
  if (!isAuthorizedIntegrationConnection(authorization) || !authorization.access.canUse) {
    throw new IntegrationContractError('provider_denied', 'A genuine selected source is required.');
  }
  const { resource, backend } = authorization;
  const environment = await readUnifiedEnvState({ secretScope: 'organization', organizationId: resource.ownership.organizationId });
  assertUnifiedEnvReadable(environment);
  if (backend.source === 'composio') {
    const connection = database ?? await openDb();
    try {
      const profile = await connection.get(`SELECT * FROM composio_connection_profiles WHERE id=$1${database ? ' FOR SHARE' : ''}`, [backend.profileId]);
      return schemaFingerprint([backend, profile ?? null, environment.revision]);
    } finally { if (!database) await connection.close(); }
  }
  const scope = sharedMcpScope(authorization);
  const config = await readExistingConfig(resolveMcpConfigPath(scope));
  const servers = Object.values(config.mcpServers), current = servers[0];
  if (servers.length !== 1 || !current || current.connectionId !== backend.connectionId || current.ownerUserId
    || current.organizationId !== resource.ownership.organizationId) {
    throw new IntegrationContractError('binding_changed', 'The selected MCP backend changed.');
  }
  const lifecycle = await readMcpOAuthLifecycle(backend.connectionId, scope);
  const definition = current.serverDefinitionId
    ? (await listMcpServerDefinitions(resource.ownership.organizationId)).find(row => row.id === current.serverDefinitionId) : null;
  return schemaFingerprint([backend, hashMcpAuthConfig(current), current.enabled !== false, current.authVersion || 1,
    current.serverDefinitionId ?? null, lifecycle.generation, lifecycle.lastCompletedState ?? null, environment.revision,
    definition?.enabled ?? null, definition?.revision ?? null, definition?.config ?? null]);
}
