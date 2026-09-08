import { DIRECT_MCP_OAUTH_SCOPES } from '@/app/lib/mcp/server/config';

/** Canvas owns the resource's scope catalogue; other persisted policy stays intact. */
export function directMcpOAuthResourceOptions(resource: string) {
  return {
    resourceSeedMode: 'merge' as const,
    resources: [{
      identifier: resource,
      name: 'Canvas Notebook MCP',
      allowedScopes: [...DIRECT_MCP_OAUTH_SCOPES],
    }],
  };
}
