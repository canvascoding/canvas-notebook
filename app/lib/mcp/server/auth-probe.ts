import 'server-only';

import { createHash } from 'node:crypto';

import {
  ProtocolError,
  ProtocolErrorCode,
  type AuthInfo,
  type CallToolResult,
} from '@modelcontextprotocol/server';

import {
  DirectMcpAuthorizationError,
  verifyDirectMcpAccessToken,
} from '@/app/lib/mcp/server/access-token-verifier';
import { DIRECT_MCP_RESOURCE_SCOPES } from '@/app/lib/mcp/server/config';
import { directMcpToolAuthorizationError } from '@/app/lib/mcp/server/tool-auth';
import type { DirectMcpToolDescriptor } from '@/app/lib/mcp/server/tool-descriptor';
import { listDirectMcpAllowedWorkspaceIds } from '@/app/lib/mcp/server/workspace-access-policy';

export const DIRECT_MCP_AUTH_PROBE_TOOL = 'auth_probe';
export const DIRECT_MCP_AUTH_PROBE_SCOPE = 'workspace:list';

const AUTH_PROBE_SECURITY_SCHEMES = [
  {
    type: 'oauth2' as const,
    scopes: [DIRECT_MCP_AUTH_PROBE_SCOPE],
  },
];

export function getDirectMcpAuthProbeToolDescriptor(): DirectMcpToolDescriptor {
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
        allowed_workspace_count: { type: 'integer' },
      },
      required: ['authenticated', 'user_ref', 'scopes', 'allowed_workspace_count'],
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

export async function runDirectMcpAuthProbe(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
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
  if (!authInfo?.token) return directMcpToolAuthorizationError();

  try {
    const principal = await verifyDirectMcpAccessToken(
      authInfo.token,
      [DIRECT_MCP_AUTH_PROBE_SCOPE],
    );
    const scopes = principal.scopes
      .filter((scope) => (DIRECT_MCP_RESOURCE_SCOPES as readonly string[]).includes(scope))
      .sort();
    const allowedWorkspaceIds = await listDirectMcpAllowedWorkspaceIds(principal);
    const structuredContent = {
      authenticated: true,
      user_ref: redactedUserReference(principal.userId),
      scopes,
      allowed_workspace_count: allowedWorkspaceIds.size,
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
      return directMcpToolAuthorizationError(error);
    }
    throw error;
  }
}
