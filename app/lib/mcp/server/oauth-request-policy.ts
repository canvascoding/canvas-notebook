import {
  DIRECT_MCP_OAUTH_SCOPES,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import { directMcpRefreshGrantIsActive } from '@/app/lib/mcp/server/oauth-grant-revocation';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';

function oauthError(error: string, description: string): Response {
  return Response.json(
    {
      error,
      error_description: description,
    },
    {
      status: 400,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    },
  );
}

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

export function isDirectMcpOAuthPath(pathname: string): boolean {
  return [
    '/api/auth/oauth2/register',
    '/api/auth/oauth2/authorize',
    '/api/auth/oauth2/token',
    '/api/auth/oauth2/revoke',
    '/api/auth/oauth2/introspect',
  ].includes(pathname);
}

function validateResourceValues(values: string[]): Response | null {
  const { resource } = resolveDirectMcpOAuthConfig();
  if (values.length !== 1 || values[0] !== resource) {
    return oauthError('invalid_target', `The OAuth resource must be exactly ${resource}.`);
  }
  return null;
}

function validateRegistrationBody(body: unknown): Response | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return oauthError('invalid_client_metadata', 'The client metadata must be a JSON object.');
  }
  const metadata = body as Record<string, unknown>;
  if (metadata.require_pkce === false) {
    return oauthError('invalid_client_metadata', 'PKCE cannot be disabled for registered clients.');
  }
  if (
    metadata.token_endpoint_auth_method !== undefined
    && metadata.token_endpoint_auth_method !== 'none'
  ) {
    return oauthError(
      'invalid_client_metadata',
      'Unauthenticated registration is limited to public clients.',
    );
  }
  if (Array.isArray(metadata.grant_types)) {
    const allowedGrantTypes = new Set(['authorization_code', 'refresh_token']);
    if (
      metadata.grant_types.some((grantType) => (
        typeof grantType !== 'string' || !allowedGrantTypes.has(grantType)
      ))
    ) {
      return oauthError(
        'invalid_client_metadata',
        'Only authorization_code and refresh_token grants are allowed.',
      );
    }
  }
  if (typeof metadata.scope === 'string') {
    const allowedScopes = new Set<string>(DIRECT_MCP_OAUTH_SCOPES);
    const requestedScopes = metadata.scope.split(' ').filter(Boolean);
    const invalidScope = requestedScopes.find((scope) => !allowedScopes.has(scope));
    if (invalidScope) {
      return oauthError('invalid_scope', `The scope ${invalidScope} is not allowed.`);
    }
  }
  return null;
}

export async function enforceDirectMcpOAuthRequestPolicy(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  const runtimeSettings = await getDirectMcpRuntimeSettings();
  if (isDirectMcpOAuthPath(url.pathname) && !runtimeSettings.enabled) {
    return disabledResponse();
  }
  if (!runtimeSettings.enabled) return null;

  if (
    request.method === 'POST'
    && url.pathname === '/api/auth/oauth2/register'
  ) {
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return oauthError(
        'invalid_client_metadata',
        'Dynamic client registration requires a JSON body.',
      );
    }
    return validateRegistrationBody(body);
  }

  if (
    request.method === 'GET'
    && url.pathname === '/api/auth/oauth2/authorize'
  ) {
    return validateResourceValues(url.searchParams.getAll('resource'));
  }

  if (
    request.method === 'POST'
    && url.pathname === '/api/auth/oauth2/token'
  ) {
    let form: FormData;
    try {
      form = await request.clone().formData();
    } catch {
      return oauthError(
        'invalid_request',
        'The OAuth token request must use a form-encoded body.',
      );
    }
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code' || grantType === 'refresh_token') {
      const resourceValues = form.getAll('resource')
        .filter((value): value is string => typeof value === 'string');
      const resourceError = validateResourceValues(resourceValues);
      if (resourceError) return resourceError;
      if (grantType === 'refresh_token') {
        const refreshGrantActive = await directMcpRefreshGrantIsActive(
          form,
          request.headers,
        );
        if (refreshGrantActive === false) {
          return oauthError(
            'invalid_grant',
            'The refresh grant is inactive.',
          );
        }
      }
    }
  }

  return null;
}
