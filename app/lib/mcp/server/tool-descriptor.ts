import 'server-only';

import type { Tool } from '@modelcontextprotocol/server';

export type DirectMcpOAuthSecurityScheme = {
  type: 'oauth2';
  scopes: string[];
};

/**
 * The SDK keeps tool-level OAuth metadata open-ended for forward compatibility.
 * Canvas publishes the standard field as well as the legacy _meta mirror so
 * current and older MCP clients discover the required scope consistently.
 */
export type DirectMcpToolDescriptor = Tool & {
  securitySchemes: DirectMcpOAuthSecurityScheme[];
  _meta: {
    securitySchemes: DirectMcpOAuthSecurityScheme[];
  };
};
