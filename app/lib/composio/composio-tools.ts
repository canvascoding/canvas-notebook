import 'server-only';

import { Type } from 'typebox';
import { getComposio } from './composio-client';
import { getComposioSession, getComposioUserId } from './composio-session';
import type { AgentTool } from '@mariozechner/pi-agent-core';

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

const HIDDEN_TOOLKIT_SLUGS = new Set([
  'gemini',
  'google_veo',
  'nano_banana',
  'openai',
  'anthropic',
  'google',
]);

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

function getCallbackUrl(): string {
  const port = process.env.PORT || '3000';
  const vercelUrl = process.env.VERCEL_URL;
  const base = vercelUrl ? `https://${vercelUrl}` : `http://localhost:${port}`;
  return `${base}/api/composio/callback`;
}

export function createComposioSearchToolsTool(): AgentTool {
  return {
    name: 'COMPOSIO_SEARCH_TOOLS',
    label: 'Search External Tools',
    description: COMPOSIO_TOOL_DESCRIPTIONS.SEARCH_TOOLS,
    parameters: ComposioSearchToolsParameters,
    execute: async (_toolCallId: string, params: unknown) => {
      try {
        const p = params as { query: string; toolkits?: string[] };
        const composio = await getComposio();
        if (!composio) {
          return textResult(JSON.stringify({ error: 'Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.' }));
        }

        const query = String(p.query || '');
        const toolkits = Array.isArray(p.toolkits) ? p.toolkits : undefined;
        const results = await composio.tools.getRawComposioTools({
          search: query,
          ...(toolkits ? { toolkits } : {}),
        } as Parameters<typeof composio.tools.getRawComposioTools>[0]);

        const resultArr = Array.isArray(results) ? results : [];
        const filtered = resultArr.filter((tool: Record<string, unknown>) => {
          const toolkit = (tool.toolkit ?? {}) as Record<string, unknown>;
          const toolkitSlug = String(toolkit.slug ?? tool.toolkitSlug ?? '');
          return !HIDDEN_TOOLKIT_SLUGS.has(toolkitSlug);
        });
        const formatted = filtered.slice(0, 20).map((tool: Record<string, unknown>) => {
          const toolkit = (tool.toolkit ?? {}) as Record<string, unknown>;
          return {
            slug: String(tool.slug ?? tool.name ?? ''),
            name: String(tool.name ?? tool.slug ?? ''),
            description: typeof tool.description === 'string' ? tool.description.slice(0, 200) : '',
            toolkit: String(toolkit.slug ?? tool.toolkitSlug ?? ''),
          };
        });

        return textResult(JSON.stringify({ tools: formatted, count: formatted.length }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error searching tools';
        return textResult(JSON.stringify({ error: message }));
      }
    },
  };
}

export function createComposioGetToolSchemasTool(): AgentTool {
  return {
    name: 'COMPOSIO_GET_TOOL_SCHEMAS',
    label: 'Get External Tool Schemas',
    description: COMPOSIO_TOOL_DESCRIPTIONS.GET_TOOL_SCHEMAS,
    parameters: ComposioGetToolSchemasParameters,
    execute: async (_toolCallId: string, params: unknown) => {
      try {
        const p = params as { tools: string[] };
        const composio = await getComposio();
        if (!composio) {
          return textResult(JSON.stringify({ error: 'Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.' }));
        }

        const tools = Array.isArray(p.tools) ? p.tools : [];
        const schemas: Record<string, unknown> = {};
        for (const slug of tools.slice(0, 10)) {
          try {
            const tool = await composio.tools.getRawComposioToolBySlug(String(slug));
            const toolRecord = tool as Record<string, unknown>;
            schemas[String(slug)] = (toolRecord?.inputParameters ?? null) as Record<string, unknown> | null;
          } catch {
            schemas[String(slug)] = { error: `Tool '${slug}' not found` };
          }
        }

        return textResult(truncateResult(schemas));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error getting tool schemas';
        return textResult(JSON.stringify({ error: message }));
      }
    },
  };
}

export function createComposioExecuteTool(): AgentTool {
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
        const composio = await getComposio();
        if (!composio) {
          return textResult(JSON.stringify({ error: 'Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.' }));
        }

        const userId = getComposioUserId();
        const result = await composio.tools.execute(action, {
          userId,
          arguments: toolParams,
        });

        return textResult(truncateResult(result));
      } catch (error: unknown) {
        const err = error as { statusCode?: number; code?: string; message?: string };
        if (err?.statusCode === 401 || err?.code === 'NOT_CONNECTED' || err?.message?.includes('not connected') || err?.message?.includes('not authenticated')) {
          const session = await getComposioSession();
          let redirectUrl = '';

          if (session) {
            try {
              const connectionRequest = await session.authorize(toolkitName, { callbackUrl: getCallbackUrl() });
              redirectUrl = connectionRequest.redirectUrl;
            } catch {
              redirectUrl = '';
            }
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

export function createComposioManageConnectionsTool(): AgentTool {
  return {
    name: 'COMPOSIO_MANAGE_CONNECTIONS',
    label: 'Manage App Connections',
    description: COMPOSIO_TOOL_DESCRIPTIONS.MANAGE_CONNECTIONS,
    parameters: ComposioManageConnectionsParameters,
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as { action: 'connect' | 'disconnect' | 'status'; toolkit: string };
      try {
        const composio = await getComposio();
        if (!composio) {
          return textResult(JSON.stringify({ error: 'Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.' }));
        }

        const userId = getComposioUserId();
        const action = p.action;
        const toolkit = p.toolkit;

        switch (action) {
          case 'connect': {
            const session = await getComposioSession();
            if (!session) {
              return textResult(JSON.stringify({ error: 'Failed to create Composio session.' }));
            }
            const connectionRequest = await session.authorize(toolkit, { callbackUrl: getCallbackUrl() });
            return textResult(JSON.stringify({
              redirect_url: connectionRequest.redirectUrl,
              message: `Open this URL to connect ${toolkit}. After connecting, return to the chat.`,
            }));
          }

          case 'disconnect': {
            const { items: accounts } = await composio.connectedAccounts.list({ userIds: [userId] });
            const account = accounts.find((a) => a.toolkit?.slug === toolkit);
            if (account) {
              await composio.connectedAccounts.delete(account.id);
              return textResult(JSON.stringify({ success: true, message: `${toolkit} disconnected successfully.` }));
            }
            return textResult(JSON.stringify({ error: `No connected account found for ${toolkit}.` }));
          }

          case 'status': {
            const { items: accounts } = await composio.connectedAccounts.list({ userIds: [userId] });
            const account = accounts.find((a) => a.toolkit?.slug === toolkit);
            if (account) {
              return textResult(JSON.stringify({
                connected: true,
                toolkit,
                status: account.status,
                connected_at: account.createdAt,
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

export function createComposioTools(): AgentTool[] {
  return [
    createComposioSearchToolsTool(),
    createComposioGetToolSchemasTool(),
    createComposioExecuteTool(),
    createComposioManageConnectionsTool(),
  ];
}