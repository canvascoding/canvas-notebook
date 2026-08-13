import 'server-only';

import { createHash } from 'node:crypto';

import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type AuthInfo,
  type CallToolResult,
} from '@modelcontextprotocol/server';

import packageJson from '@/package.json';
import {
  DirectMcpAuthorizationError,
  verifyDirectMcpAccessToken,
} from '@/app/lib/mcp/server/access-token-verifier';
import { getDirectMcpEnabledTools } from '@/app/lib/mcp/server/config';

export const DIRECT_MCP_AUTH_PROBE_TOOL = 'auth_probe';
export const DIRECT_MCP_AUTH_PROBE_SCOPE = 'workspace:list';

const AUTH_PROBE_SECURITY_SCHEMES = [
  {
    type: 'oauth2' as const,
    scopes: [DIRECT_MCP_AUTH_PROBE_SCOPE],
  },
];

export function getDirectMcpAuthProbeToolDescriptor() {
  return {
    name: DIRECT_MCP_AUTH_PROBE_TOOL,
    title: 'Verify Canvas Notebook connection',
    description: (
      'Verifies OAuth access to this Canvas Notebook instance without reading '
      + 'workspace or knowledge data.'
    ),
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        authenticated: { type: 'boolean' },
        user_ref: { type: 'string' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['authenticated', 'user_ref', 'scopes'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    securitySchemes: AUTH_PROBE_SECURITY_SCHEMES,
    _meta: {
      securitySchemes: AUTH_PROBE_SECURITY_SCHEMES,
    },
  };
}

function redactedUserReference(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12);
}

function toolAuthorizationError(
  error?: DirectMcpAuthorizationError,
): CallToolResult {
  const authorizationError = error ?? new DirectMcpAuthorizationError(
    'invalid_token',
    401,
    'Authentication is required.',
    {
      challengeError: 'invalid_token',
    },
  );
  const result: CallToolResult = {
    content: [{
      type: 'text',
      text: authorizationError.status === 503
        ? 'Authorization is temporarily unavailable.'
        : 'Authentication is required to verify this connection.',
    }],
    isError: true,
  };
  if (authorizationError.challenge) {
    result._meta = {
      'mcp/www_authenticate': [authorizationError.challenge],
    };
  }
  return result;
}

async function runAuthProbe(authInfo?: AuthInfo): Promise<CallToolResult> {
  if (!authInfo?.token) return toolAuthorizationError();

  try {
    const principal = await verifyDirectMcpAccessToken(
      authInfo.token,
      [DIRECT_MCP_AUTH_PROBE_SCOPE],
    );
    const scopes = principal.scopes
      .filter((scope) => scope === DIRECT_MCP_AUTH_PROBE_SCOPE)
      .sort();
    const structuredContent = {
      authenticated: true,
      user_ref: redactedUserReference(principal.userId),
      scopes,
    };
    return {
      content: [{
        type: 'text',
        text: 'Canvas Notebook OAuth connection verified.',
      }],
      structuredContent,
    };
  } catch (error) {
    if (error instanceof DirectMcpAuthorizationError) {
      return toolAuthorizationError(error);
    }
    throw error;
  }
}

export function createDirectMcpAuthProbeServer(): Server {
  const authProbeEnabled = getDirectMcpEnabledTools().includes(
    DIRECT_MCP_AUTH_PROBE_TOOL,
  );
  const server = new Server(
    {
      name: 'canvas-notebook-direct-mcp',
      version: packageJson.version,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: (
        authProbeEnabled
          ? 'This authentication probe verifies the local OAuth connection. It does not expose workspace or knowledge data.'
          : 'No MCP tools are currently enabled for this Canvas Notebook instance.'
      ),
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: authProbeEnabled ? [getDirectMcpAuthProbeToolDescriptor()] : [],
  }));

  server.setRequestHandler('tools/call', async (request, context) => {
    if (!authProbeEnabled || request.params.name !== DIRECT_MCP_AUTH_PROBE_TOOL) {
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        `Unknown tool ${request.params.name}.`,
      );
    }
    const args = request.params.arguments;
    if (
      args !== undefined
      && (
        typeof args !== 'object'
        || args === null
        || Array.isArray(args)
        || Object.keys(args).length > 0
      )
    ) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `${DIRECT_MCP_AUTH_PROBE_TOOL} does not accept arguments.`,
      );
    }
    return runAuthProbe(context.http?.authInfo);
  });

  return server;
}
