import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';

import { auth } from '@/app/lib/auth';
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
  if (!(await getDirectMcpRuntimeSettings()).enabled) return disabledResponse();
  return metadataHandler(request);
}

export async function headAuthorizationServerMetadata(request: Request): Promise<Response> {
  const response = await getAuthorizationServerMetadata(request);
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
