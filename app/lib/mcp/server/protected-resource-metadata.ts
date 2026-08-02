import {
  DIRECT_MCP_RESOURCE_SCOPES,
  isDirectMcpEnabled,
  resolveDirectMcpServerConfig,
} from '@/app/lib/mcp/server/config';

export type DirectMcpProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ['header'];
};

export function getDirectMcpProtectedResourceMetadata():
DirectMcpProtectedResourceMetadata | null {
  if (!isDirectMcpEnabled()) return null;

  const config = resolveDirectMcpServerConfig();
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...DIRECT_MCP_RESOURCE_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

export function directMcpProtectedResourceMetadataResponse(): Response {
  const metadata = getDirectMcpProtectedResourceMetadata();
  if (!metadata) {
    return new Response(null, {
      status: 404,
      headers: {
        'cache-control': 'no-store',
      },
    });
  }

  return Response.json(metadata, {
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}

export function directMcpProtectedResourceMetadataOptionsResponse(): Response {
  if (!isDirectMcpEnabled()) {
    return new Response(null, {
      status: 404,
      headers: {
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-origin': '*',
      'access-control-max-age': '300',
    },
  });
}
