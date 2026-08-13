import 'server-only';

import type { CallToolResult } from '@modelcontextprotocol/server';

import { DirectMcpAuthorizationError } from '@/app/lib/mcp/server/access-token-verifier';

export function directMcpToolAuthorizationError(
  error?: DirectMcpAuthorizationError,
): CallToolResult {
  const authorizationError = error ?? new DirectMcpAuthorizationError(
    'invalid_token',
    401,
    'Authentication is required.',
    { challengeError: 'invalid_token' },
  );
  const result: CallToolResult = {
    content: [{
      type: 'text',
      text: authorizationError.status === 503
        ? 'Authorization is temporarily unavailable.'
        : 'Sign in to Canvas to use this tool.',
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
