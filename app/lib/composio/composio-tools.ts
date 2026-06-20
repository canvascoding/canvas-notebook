import 'server-only';

import { Type } from 'typebox';
import {
  connectGatewayToolkit,
  disconnectGatewayToolkit,
  executeGatewayTool,
  getGatewayAuthRedirect,
  getGatewayToolSchemas,
  refreshGatewayToolkit,
  searchGatewayTools,
} from './composio-gateway';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { EnvStorageScope } from '../integrations/env-config';

const COMPOSIO_TOOL_DESCRIPTIONS = {
  SEARCH_TOOLS: 'Search for available tools across connected external apps (GitHub, Gmail, Slack, etc.). Returns tool name, description, and toolkit. Use this to discover which actions are available before executing. Always search before executing — don\'t guess action names.',
  GET_TOOL_SCHEMAS: 'Get the complete input parameter schemas for specific Composio tools. Provide tool slugs obtained from COMPOSIO_SEARCH_TOOLS. Returns JSON Schema for each tool\'s parameters so you know exactly what fields to provide.',
  EXECUTE: 'Execute a Composio tool action. The action must be a valid tool slug (use COMPOSIO_SEARCH_TOOLS to find available actions first). If the tool requires authentication you haven\'t set up, the response will contain auth_required with a redirect URL to connect the app.',
  MANAGE_CONNECTIONS: 'Manage connections to external apps. Use \'connect\' to get an OAuth redirect URL, \'disconnect\' to remove a connection, or \'status\' to check if a toolkit is connected.',
} as const;

const ComposioSearchToolsParameters = Type.Object({
  query: Type.String({ description: 'Natural language search query for tools (e.g., "list repositories github" or "send email")' }),
  toolkits: Type.Optional(Type.Array(Type.String(), { description: 'Filter to specific toolkit slugs (e.g., ["github", "gmail"])' })),
});

const ComposioGetToolSchemasParameters = Type.Object({
  tools: Type.Array(Type.String(), { description: 'Array of tool slugs to get schemas for (e.g., ["GITHUB_GET_REPOS"])' }),
});

const ComposioExecuteParameters = Type.Object({
  action: Type.String({ description: 'Tool slug to execute (e.g., "GITHUB_GET_REPOS"). Use COMPOSIO_SEARCH_TOOLS to find available actions.' }),
  params: Type.Record(Type.String(), Type.Unknown(), { description: 'Parameters for the tool action. Use COMPOSIO_GET_TOOL_SCHEMAS to learn what parameters are required.' }),
});

const ComposioManageConnectionsParameters = Type.Object({
  action: Type.Union([Type.Literal('connect'), Type.Literal('disconnect'), Type.Literal('status')], { description: 'Connection action: "connect" generates OAuth URL, "disconnect" removes connection, "status" checks connection state' }),
  toolkit: Type.String({ description: 'Toolkit slug (e.g., "github", "gmail", "slack")' }),
});

function truncateResult(data: unknown, maxLength = 8000): string {
  const str = JSON.stringify(data);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...[truncated]';
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

export function createComposioSearchToolsTool(storageScope?: EnvStorageScope | null): AgentTool {
  return {
    name: 'COMPOSIO_SEARCH_TOOLS',
    label: 'Search External Tools',
    description: COMPOSIO_TOOL_DESCRIPTIONS.SEARCH_TOOLS,
    parameters: ComposioSearchToolsParameters,
    execute: async (_toolCallId: string, params: unknown) => {
      try {
        const p = params as { query: string; toolkits?: string[] };
        const query = String(p.query || '');
        const toolkits = Array.isArray(p.toolkits) ? p.toolkits : undefined;
        return textResult(JSON.stringify(await searchGatewayTools(query, toolkits, storageScope)));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error searching tools';
        return textResult(JSON.stringify({ error: message }));
      }
    },
  };
}

export function createComposioGetToolSchemasTool(storageScope?: EnvStorageScope | null): AgentTool {
  return {
    name: 'COMPOSIO_GET_TOOL_SCHEMAS',
    label: 'Get External Tool Schemas',
    description: COMPOSIO_TOOL_DESCRIPTIONS.GET_TOOL_SCHEMAS,
    parameters: ComposioGetToolSchemasParameters,
    execute: async (_toolCallId: string, params: unknown) => {
      try {
        const p = params as { tools: string[] };
        const tools = Array.isArray(p.tools) ? p.tools : [];
        return textResult(truncateResult(await getGatewayToolSchemas(tools, storageScope)));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error getting tool schemas';
        return textResult(JSON.stringify({ error: message }));
      }
    },
  };
}

export function createComposioExecuteTool(storageScope?: EnvStorageScope | null): AgentTool {
  return {
    name: 'composio_execute',
    label: 'Execute External Tool',
    description: COMPOSIO_TOOL_DESCRIPTIONS.EXECUTE,
    parameters: ComposioExecuteParameters,
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as { action: string; params: Record<string, unknown> };
      const action = String(p.action || '');
      const toolParams = (p.params && typeof p.params === 'object') ? p.params as Record<string, unknown> : {};
      const toolkitName = action.split('_')[0]?.toLowerCase() ?? '';
      try {
        const result = await executeGatewayTool(action, toolParams, storageScope);

        return textResult(truncateResult(result));
      } catch (error: unknown) {
        const err = error as { statusCode?: number; code?: string; message?: string };
        if (err?.statusCode === 401 || err?.code === 'NOT_CONNECTED' || err?.message?.includes('not connected') || err?.message?.includes('not authenticated')) {
          let redirectUrl = '';
          try {
            redirectUrl = await getGatewayAuthRedirect(toolkitName, storageScope);
          } catch {
            redirectUrl = '';
          }

          return textResult(JSON.stringify({
            auth_required: true,
            redirect_url: redirectUrl,
            toolkit: toolkitName,
            toolkit_name: toolkitName.charAt(0).toUpperCase() + toolkitName.slice(1),
            tool_name: action,
            message: `This action requires ${toolkitName} to be connected. Please connect it in Settings → Integrations → Connected Apps.`,
          }));
        }

        const message = error instanceof Error ? error.message : 'Unknown error executing tool';
        return textResult(JSON.stringify({ error: message }));
      }
    },
  };
}

export function createComposioManageConnectionsTool(storageScope?: EnvStorageScope | null): AgentTool {
  return {
    name: 'COMPOSIO_MANAGE_CONNECTIONS',
    label: 'Manage App Connections',
    description: COMPOSIO_TOOL_DESCRIPTIONS.MANAGE_CONNECTIONS,
    parameters: ComposioManageConnectionsParameters,
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as { action: 'connect' | 'disconnect' | 'status'; toolkit: string };
      try {
        const action = p.action;
        const toolkit = p.toolkit;

        switch (action) {
          case 'connect': {
            const connectionRequest = await connectGatewayToolkit(toolkit, storageScope);
            return textResult(JSON.stringify({
              redirect_url: connectionRequest.redirectUrl,
              message: `Open this URL to connect ${toolkit}. After connecting, return to the chat.`,
            }));
          }

          case 'disconnect': {
            await disconnectGatewayToolkit(toolkit, storageScope);
            return textResult(JSON.stringify({ success: true, message: `${toolkit} disconnected successfully.` }));
          }

          case 'status': {
            const account = await refreshGatewayToolkit(toolkit, storageScope);
            if (account.status && account.status !== 'NOT_CONNECTED') {
              return textResult(JSON.stringify({
                connected: true,
                toolkit,
                status: account.status,
                connected_at: account.connectedAt,
              }));
            }
            return textResult(JSON.stringify({ connected: false, toolkit }));
          }

          default:
            return textResult(JSON.stringify({ error: `Unknown action: ${action}. Use 'connect', 'disconnect', or 'status'.` }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error managing connections';
        return textResult(JSON.stringify({ error: message }));
      }
    },
  };
}

export function createComposioTools(storageScope?: EnvStorageScope | null): AgentTool[] {
  return [
    createComposioSearchToolsTool(storageScope),
    createComposioGetToolSchemasTool(storageScope),
    createComposioExecuteTool(storageScope),
    createComposioManageConnectionsTool(storageScope),
  ];
}
