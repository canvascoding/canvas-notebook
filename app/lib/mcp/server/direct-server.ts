import 'server-only';

import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type AuthInfo,
  type CallToolResult,
} from '@modelcontextprotocol/server';

import packageJson from '@/package.json';
import {
  DIRECT_MCP_AUTH_PROBE_TOOL,
  getDirectMcpAuthProbeToolDescriptor,
  runDirectMcpAuthProbe,
} from '@/app/lib/mcp/server/auth-probe';
import { getDirectMcpEnabledTools, type DirectMcpToolId } from '@/app/lib/mcp/server/config';
import {
  recordDirectMcpRequestOperation,
  recordDirectMcpToolFailure,
} from '@/app/lib/mcp/server/diagnostics';
import {
  getDirectMcpWorkspaceToolDefinitions,
} from '@/app/lib/mcp/server/workspace-tools';
import type { DirectMcpToolDescriptor } from '@/app/lib/mcp/server/tool-descriptor';

type DirectMcpToolHandler = {
  id: DirectMcpToolId;
  descriptor: DirectMcpToolDescriptor;
  execute: (args: unknown, authInfo?: AuthInfo) => Promise<CallToolResult>;
};

export function createDirectMcpServer(
  configuredTools: readonly DirectMcpToolId[] = getDirectMcpEnabledTools(),
): Server {
  const enabledTools = new Set(configuredTools);
  const tools: DirectMcpToolHandler[] = [];
  if (enabledTools.has(DIRECT_MCP_AUTH_PROBE_TOOL)) {
    tools.push({
      id: DIRECT_MCP_AUTH_PROBE_TOOL,
      descriptor: getDirectMcpAuthProbeToolDescriptor(),
      execute: runDirectMcpAuthProbe,
    });
  }
  for (const tool of getDirectMcpWorkspaceToolDefinitions()) {
    if (!enabledTools.has(tool.id)) continue;
    tools.push({
      id: tool.id,
      descriptor: tool.descriptor,
      execute: tool.execute,
    });
  }
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const instructions = tools.length === 0
    ? 'No MCP tools are currently enabled for this Canvas Notebook instance.'
    : 'Canvas Notebook provides read-only access to the signed-in user’s workspaces and workspace files.';

  const server = new Server(
    {
      name: 'canvas-notebook-direct-mcp',
      version: packageJson.version,
    },
    {
      capabilities: { tools: {} },
      instructions,
    },
  );

  server.setRequestHandler('tools/list', async () => {
    recordDirectMcpRequestOperation('tools/list');
    return { tools: tools.map((tool) => tool.descriptor) };
  });

  server.setRequestHandler('tools/call', async (request, context) => {
    recordDirectMcpRequestOperation('tools/call');
    const tool = toolsById.get(request.params.name as DirectMcpToolId);
    if (!tool) {
      recordDirectMcpToolFailure();
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        'The requested tool is not available.',
      );
    }
    recordDirectMcpRequestOperation('tools/call', tool.id);
    try {
      const result = await tool.execute(request.params.arguments, context.http?.authInfo);
      if (result.isError) recordDirectMcpToolFailure();
      return result;
    } catch (error) {
      recordDirectMcpToolFailure();
      throw error;
    }
  });

  return server;
}
