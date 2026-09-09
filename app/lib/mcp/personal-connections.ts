import 'server-only';
import { randomUUID } from 'node:crypto';
import { assertMcpConnectionAccess, McpAccessError, requireMcpUserAccess } from './access';
import { parseAndValidateMcpConfig, readMcpConfigState, writeMcpConfigRaw, type McpConfig } from './config';
import { listMcpServerDefinitions } from './server-definitions';

function accountLabel(value: string, config: McpConfig, exceptId?: string): string {
  const label = value.trim();
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f]/u.test(label)) throw new McpAccessError('Choose an account name between 1 and 120 characters.', 400);
  if (Object.entries(config.mcpServers).some(([name, connection]) => connection.connectionId !== exceptId && (connection.displayName || name).toLocaleLowerCase() === label.toLocaleLowerCase())) {
    throw new McpAccessError('Choose a unique name for this account.', 409);
  }
  return label;
}

async function mutatePersonalConnections(userId: string, mutate: (config: McpConfig) => Promise<string>): Promise<{ server: string; connectionId: string }> {
  const scope = { userId };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await requireMcpUserAccess(scope);
    const state = await readMcpConfigState(scope);
    const config = parseAndValidateMcpConfig(state.rawContent);
    const server = await mutate(config);
    const removedId = config.mcpServers[server]?.connectionId;
    try {
      const saved = await writeMcpConfigRaw(JSON.stringify(config, null, 2), scope, { expectedRaw: state.rawContent });
      return { server, connectionId: parseAndValidateMcpConfig(saved.rawContent).mcpServers[server]?.connectionId || removedId || server };
    } catch (error) {
      if ((error as { code?: string }).code !== 'MCP_CONFIG_CONFLICT' || attempt === 2) throw error;
    }
  }
  throw new McpAccessError('MCP connections changed. Please retry.', 409);
}

export async function createPersonalMcpConnection(userId: string, definitionId: string, displayName: string) {
  return mutatePersonalConnections(userId, async (config) => {
    const actor = await requireMcpUserAccess({ userId });
    if (!actor?.organizationId) throw new McpAccessError('An organization is required to use approved servers.');
    const definition = (await listMcpServerDefinitions(actor.organizationId)).find((item) => item.id === definitionId && item.enabled);
    if (!definition) throw new McpAccessError('Approved MCP server not found.', 404);
    const label = accountLabel(displayName, config);
    const server = `${label.replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 48) || 'account'}_${randomUUID().slice(0, 8)}`;
    config.mcpServers[server] = { ...definition.config, enabled: true, organizationId: actor.organizationId, serverDefinitionId: definition.id, displayName: label };
    return server;
  });
}

export async function renamePersonalMcpConnection(userId: string, connectionId: string, displayName: string) {
  return mutatePersonalConnections(userId, async (config) => {
    const { serverName } = await assertMcpConnectionAccess(connectionId, { userId }, { management: true, allowDisabled: true });
    if (!config.mcpServers[serverName] || config.mcpServers[serverName].connectionId !== connectionId) throw new McpAccessError('MCP connection changed.', 409);
    config.mcpServers[serverName].displayName = accountLabel(displayName, config, connectionId);
    return serverName;
  });
}

export async function removePersonalMcpConnection(userId: string, connectionId: string) {
  const result = await mutatePersonalConnections(userId, async (config) => {
    const { serverName } = await assertMcpConnectionAccess(connectionId, { userId }, { management: true, allowDisabled: true });
    if (config.mcpServers[serverName]?.connectionId !== connectionId) throw new McpAccessError('MCP connection changed.', 409);
    delete config.mcpServers[serverName];
    return serverName;
  });
  return { ...result, connectionId };
}
