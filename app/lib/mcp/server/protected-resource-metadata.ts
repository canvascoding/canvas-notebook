import {
  DIRECT_MCP_RESOURCE_SCOPES,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import {
  beginDirectMcpDiagnostic,
  completeDirectMcpDiagnostic,
  failDirectMcpDiagnostic,
  withDirectMcpRequestId,
} from '@/app/lib/mcp/server/diagnostics';
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

export async function directMcpProtectedResourceMetadataResponse(
  request: Request,
): Promise<Response> {
  const startedAt = Date.now();
  const diagnostics = beginDirectMcpDiagnostic(request, 'discovery.protected_resource');
  try {
    const metadata = await getDirectMcpProtectedResourceMetadata();
    const response = withDirectMcpRequestId(metadata
      ? Response.json(metadata, {
        headers: {
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=300',
        },
      })
      : new Response(null, {
        status: 404,
        headers: {
          'cache-control': 'no-store',
        },
      }), diagnostics.requestId);
    await completeDirectMcpDiagnostic(diagnostics, {
      statusCode: response.status,
      code: response.status === 404 ? 'MCP_DISABLED' : 'MCP_DISCOVERY_COMPLETED',
      startedAt,
    });
    return response;
  } catch {
    await failDirectMcpDiagnostic(diagnostics, {
      code: 'MCP_DISCOVERY_ERROR',
      startedAt,
      statusCode: 500,
    });
    return withDirectMcpRequestId(Response.json({
      error: 'temporarily_unavailable',
      error_description: 'Protected resource metadata is temporarily unavailable.',
    }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    }), diagnostics.requestId);
  }
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
