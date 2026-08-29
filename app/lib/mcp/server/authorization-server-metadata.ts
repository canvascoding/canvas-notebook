import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';

import { auth } from '@/app/lib/auth';
import {
  beginDirectMcpDiagnostic,
  completeDirectMcpDiagnostic,
  failDirectMcpDiagnostic,
  withDirectMcpRequestId,
} from '@/app/lib/mcp/server/diagnostics';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';

const metadataHandler = oauthProviderAuthServerMetadata(auth, {
  headers: {
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  },
});

function disabledResponse(): Response {
  return Response.json(
    {
      error: 'not_found',
      error_description: 'Direct MCP OAuth is not enabled.',
    },
    {
      status: 404,
      headers: {
        'cache-control': 'no-store',
      },
    },
  );
}

export async function getAuthorizationServerMetadata(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const diagnostics = beginDirectMcpDiagnostic(request, 'discovery.authorization_server');
  try {
    const response = withDirectMcpRequestId(
      !(await getDirectMcpRuntimeSettings()).enabled
        ? disabledResponse()
        : await metadataHandler(request),
      diagnostics.requestId,
    );
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
      error_description: 'OAuth authorization server metadata is temporarily unavailable.',
    }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    }), diagnostics.requestId);
  }
}

export async function headAuthorizationServerMetadata(request: Request): Promise<Response> {
  const response = await getAuthorizationServerMetadata(request);
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
