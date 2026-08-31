import 'server-only';

import type { CallToolResult } from '@modelcontextprotocol/server';

import { DirectMcpAuthorizationError } from '@/app/lib/mcp/server/access-token-verifier';

export function directMcpToolAuthorizationError(
  error?: DirectMcpAuthorizationError,
  requiredScope?: string,
): CallToolResult {
  const authorizationError = error ?? new DirectMcpAuthorizationError(
    'invalid_token',
    401,
    'Authentication is required.',
    { challengeError: 'invalid_token' },
  );
  const text = authorizationError.status === 503
    ? 'Canvas authorization is temporarily unavailable. Try this tool again shortly.'
    : authorizationError.code === 'insufficient_scope'
      ? `This tool requires the additional OAuth permission "${requiredScope || 'requested scope'}". In Canvas, verify the capability under Settings > MCP Server, reload the MCP server in your client, and approve the new permission once. You do not need to register a new client.`
      : 'Sign in to Canvas again to use this tool. If the tool is disabled, enable it under Settings > MCP Server and reload the MCP server in your client.';
  const result: CallToolResult = {
    content: [{
      type: 'text',
      text,
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
