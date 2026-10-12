import 'server-only';

import type { AuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/contracts';
import { IntegrationContractError } from '@/app/lib/integration-tools/contracts';
import { getPublishedIntegrationConnectionBindingRevision } from '@/app/lib/integration-tools/connections/store';
import { readMcpTextFileIfExists, writeMcpTextFileAtomic } from './storage';
import { sharedMcpScope } from './shared-access';

const PUBLICATION_FILE = 'published-binding.json';

/** Stage before filesystem/ENV changes. A failed SQL commit leaves execution fenced. */
export async function stageSharedMcpBindingPublication(authorization: AuthorizedIntegrationConnection): Promise<void> {
  if (authorization.operation !== 'manage' || authorization.backend.source !== 'mcp') throw new Error('Shared MCP management authority is required.');
  const marker = { version: 1, connectionRef: authorization.resource.connectionRef, connectionId: authorization.backend.connectionId,
    ownership: authorization.resource.ownership, bindingRevision: authorization.resource.bindingRevision + 1 };
  await writeMcpTextFileAtomic(PUBLICATION_FILE, JSON.stringify(marker), sharedMcpScope(authorization));
}

/** Status revisions are independent; only a committed provider publication validates a marker. */
export async function assertSharedMcpBindingPublished(authorization: AuthorizedIntegrationConnection): Promise<void> {
  if (authorization.operation === 'manage') return;
  try {
    if (authorization.backend.source !== 'mcp') throw new Error('Invalid MCP backend.');
    const { content } = await readMcpTextFileIfExists(PUBLICATION_FILE, sharedMcpScope(authorization));
    const marker = content === null ? null : JSON.parse(content);
    const owner = authorization.resource.ownership;
    if (!marker || Object.keys(marker).sort().join(',') !== 'bindingRevision,connectionId,connectionRef,ownership,version'
      || marker.version !== 1 || marker.connectionRef !== authorization.resource.connectionRef || marker.connectionId !== authorization.backend.connectionId
      || marker.ownership?.type !== owner.type || marker.ownership?.organizationId !== owner.organizationId
      || (marker.ownership?.workspaceId ?? null) !== (owner.type === 'team' ? owner.workspaceId : null)
      || marker.bindingRevision !== await getPublishedIntegrationConnectionBindingRevision(authorization)) throw new Error('Unpublished shared MCP binding.');
  } catch {
    throw Object.assign(new IntegrationContractError('binding_changed', 'The shared MCP credential change has not been published. An administrator must repair this connection.'), { status: 409 });
  }
}
