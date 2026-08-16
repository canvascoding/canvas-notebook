import {
  DIRECT_MCP_RESOURCE_SCOPES,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';

export type DirectMcpProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ['header'];
};

export async function getDirectMcpProtectedResourceMetadata():
Promise<DirectMcpProtectedResourceMetadata | null> {
  if (!(await getDirectMcpRuntimeSettings()).enabled) return null;

  const config = resolveDirectMcpOAuthConfig();
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...DIRECT_MCP_RESOURCE_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

export async function directMcpProtectedResourceMetadataResponse(): Promise<Response> {
  const metadata = await getDirectMcpProtectedResourceMetadata();
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

export async function directMcpProtectedResourceMetadataOptionsResponse(): Promise<Response> {
  if (!(await getDirectMcpRuntimeSettings()).enabled) {
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
