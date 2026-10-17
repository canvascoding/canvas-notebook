import 'server-only';

import { CapabilityResourceError, type CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { resolvePluginWorkspaceCatalogScopeContext } from './plugin-workspace-selection';
import { assertMcpConnectionAccess, requireMcpUserAccess } from '@/app/lib/mcp/access';
import { listMcpServerDefinitions } from '@/app/lib/mcp/server-definitions';
import { resolveSharedMcpBackend } from '@/app/lib/mcp/shared-connections';
import { MCP_SYSTEM_SCOPE, type McpScope } from '@/app/lib/mcp/scope';
import type { McpServerConfig } from '@/app/lib/mcp/config';
import { mcpIconSourceBinding } from '@/app/lib/mcp/icon-source';
import { readSourceBoundMcpServerIcon } from '@/app/lib/mcp/icons';

type McpIconSource = { binding: string; config: McpServerConfig; scope: McpScope };
const selectionPattern = /^(?:mcp-personal:|mcp-definition:|canvas-connection:)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const changed = () => new CapabilityResourceError('MCP_ICON_SOURCE_CHANGED', 'The MCP image source changed. Reload the extension.', 409);

/** Exact current metadata authority; this never opens MCP, OAuth or a business tool. */
async function resolveMcpIconSource(actor: CapabilityResourceActor, selectionId: string): Promise<McpIconSource> {
  await resolvePluginWorkspaceCatalogScopeContext(actor);
  if (selectionId.startsWith('canvas-connection:')) {
    const backend = await resolveSharedMcpBackend(actor, selectionId, 'inspect');
    if (!backend.authorization.access.canRead || backend.authorization.resource.status !== 'active') {
      throw new CapabilityResourceError('MCP_ICON_ACCESS_DENIED', 'This MCP image is unavailable.', 403);
    }
    const resource = backend.authorization.resource;
    const stamp = `${resource.metadataRevision}:${resource.grantsRevision}:${resource.bindingRevision}`;
    return { config: backend.connection, scope: backend.scope, binding: mcpIconSourceBinding(selectionId, backend.connection, stamp) };
  }
  const currentActor = await requireMcpUserAccess({ userId: actor.userId });
  if (!currentActor) throw new CapabilityResourceError('MCP_ICON_ACCESS_DENIED', 'This MCP image is unavailable.', 403);
  if (selectionId.startsWith('mcp-definition:')) {
    const definition = currentActor.organizationId
      ? (await listMcpServerDefinitions(currentActor.organizationId)).find(value => `mcp-definition:${value.id}` === selectionId && value.enabled)
      : undefined;
    if (!definition) throw new CapabilityResourceError('MCP_ICON_NOT_FOUND', 'This MCP image is unavailable.', 404);
    // An approved definition is an offering, never a fabricated personal/shared connection.
    // Its organization/ref/revision are included in the private cache binding.
    const config = { ...definition.config, organizationId: definition.organizationId, serverDefinitionId: definition.id };
    return { config, scope: MCP_SYSTEM_SCOPE, binding: mcpIconSourceBinding(selectionId, config, definition.revision) };
  }
  const connectionId = selectionId.slice('mcp-personal:'.length);
  const { connection } = await assertMcpConnectionAccess(connectionId, { userId: actor.userId }, { actor: currentActor, allowDisabled: true });
  if (connection.connectionId !== connectionId || connection.ownerUserId !== actor.userId) {
    throw new CapabilityResourceError('MCP_ICON_ACCESS_DENIED', 'This MCP image is unavailable.', 403);
  }
  return { config: connection, scope: { userId: actor.userId }, binding: mcpIconSourceBinding(selectionId, connection) };
}

export async function readPluginMcpIconAction(actorInput: CapabilityResourceActor, selectionId: string, binding: string,
  signal?: AbortSignal): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!selectionPattern.test(selectionId) || !/^[a-f0-9]{64}$/u.test(binding)) {
    throw new CapabilityResourceError('MCP_ICON_REQUEST_INVALID', 'The MCP image request is invalid.', 400);
  }
  const actor = structuredClone(actorInput);
  signal?.throwIfAborted();
  const captured = await resolveMcpIconSource(actor, selectionId);
  if (captured.binding !== binding) throw changed();
  const assertCurrent = async () => {
    signal?.throwIfAborted();
    const fresh = await resolveMcpIconSource(actor, selectionId);
    if (fresh.binding !== captured.binding) throw changed();
  };
  const image = await readSourceBoundMcpServerIcon(captured.config, captured.binding, captured.scope, assertCurrent);
  await assertCurrent();
  return image;
}
