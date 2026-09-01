import {
  DIRECT_MCP_OAUTH_SCOPES,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import { directMcpRefreshGrantIsActive } from '@/app/lib/mcp/server/oauth-grant-revocation';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';

const MAX_DYNAMIC_CLIENT_REGISTRATION_BYTES = 16 * 1024;
const PUBLIC_DYNAMIC_CLIENT_AUTH_METHODS = new Set([
  'none',
  // Several MCP clients still send this RFC 7591 value even though an open
  // registration endpoint can only issue a public client. Normalize it below
  // and advertise the resulting `none` method in the registration response.
  'client_secret_post',
]);

export type PreparedDirectMcpOAuthRequest = {
  request: Request;
  response: Response | null;
};

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
    '/api/auth/oauth2/consent',
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

function validateAuthorizationPkce(url: URL): Response | null {
  const codeChallenge = url.searchParams.get('code_challenge')?.trim();
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');
  if (
    !codeChallenge
    || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)
    || codeChallengeMethod !== 'S256'
  ) {
    return oauthError(
      'invalid_request',
      'Direct MCP authorization requires a S256 PKCE code challenge.',
    );
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
    && (
      typeof metadata.token_endpoint_auth_method !== 'string'
      || !PUBLIC_DYNAMIC_CLIENT_AUTH_METHODS.has(metadata.token_endpoint_auth_method)
    )
  ) {
    return oauthError(
      'invalid_client_metadata',
      'Unauthenticated registration only supports public MCP clients.',
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

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('content-type') || '';
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function bodyIsTooLarge(request: Request, body: string): boolean {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DYNAMIC_CLIENT_REGISTRATION_BYTES) {
      return true;
    }
  }
  return new TextEncoder().encode(body).byteLength > MAX_DYNAMIC_CLIENT_REGISTRATION_BYTES;
}

async function normalizeDynamicClientRegistrationRequest(
  request: Request,
): Promise<PreparedDirectMcpOAuthRequest> {
  if (!hasJsonContentType(request)) {
    return {
      request,
      response: oauthError(
        'invalid_client_metadata',
        'Dynamic client registration requires an application/json body.',
      ),
    };
  }

  let serializedBody: string;
  try {
    serializedBody = await request.clone().text();
  } catch {
    return {
      request,
      response: oauthError(
        'invalid_client_metadata',
        'Dynamic client registration requires a JSON body.',
      ),
    };
  }

  if (bodyIsTooLarge(request, serializedBody)) {
    return {
      request,
      response: oauthError(
        'invalid_client_metadata',
        'Dynamic client registration metadata is too large.',
      ),
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(serializedBody);
  } catch {
    return {
      request,
      response: oauthError(
        'invalid_client_metadata',
        'Dynamic client registration requires a JSON body.',
      ),
    };
  }

  const validationError = validateRegistrationBody(body);
  if (validationError) return { request, response: validationError };

  // Better Auth versions before the stable 1.7 line default an omitted method
  // to client_secret_basic. MCP clients may also optimistically request
  // client_secret_post during open registration. Both cases must result in a
  // public client: a secret cannot safely be issued to an unauthenticated
  // registrant.
  const metadata = body as Record<string, unknown>;
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return {
    // Do not use the incoming Request as the constructor input here. In the
    // production Next.js request pipeline it can carry a one-shot body stream;
    // deriving from it while replacing the body can throw before Better Auth
    // receives the normalized registration. All OAuth-relevant request data is
    // explicitly preserved instead.
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify({
        ...metadata,
        token_endpoint_auth_method: 'none',
      }),
    }),
    response: null,
  };
}

export async function prepareDirectMcpOAuthRequest(
  request: Request,
): Promise<PreparedDirectMcpOAuthRequest> {
  const url = new URL(request.url);
  const runtimeSettings = await getDirectMcpRuntimeSettings();
  if (isDirectMcpOAuthPath(url.pathname) && !runtimeSettings.enabled) {
    return { request, response: disabledResponse() };
  }
  if (!runtimeSettings.enabled) return { request, response: null };

  if (
    request.method === 'POST'
    && url.pathname === '/api/auth/oauth2/register'
  ) {
    return normalizeDynamicClientRegistrationRequest(request);
  }

  if (
    request.method === 'GET'
    && url.pathname === '/api/auth/oauth2/authorize'
  ) {
    return {
      request,
      response: (
        validateResourceValues(url.searchParams.getAll('resource'))
        ?? validateAuthorizationPkce(url)
      ),
    };
  }

  if (
    request.method === 'POST'
    && url.pathname === '/api/auth/oauth2/token'
  ) {
    let form: FormData;
    try {
      form = await request.clone().formData();
    } catch {
      return {
        request,
        response: oauthError(
          'invalid_request',
          'The OAuth token request must use a form-encoded body.',
        ),
      };
    }
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code' || grantType === 'refresh_token') {
      const resourceValues = form.getAll('resource')
        .filter((value): value is string => typeof value === 'string');
      const resourceError = validateResourceValues(resourceValues);
      if (resourceError) return { request, response: resourceError };
      if (grantType === 'refresh_token') {
        const refreshGrantActive = await directMcpRefreshGrantIsActive(
          form,
          request.headers,
        );
        if (refreshGrantActive === false) {
          return {
            request,
            response: oauthError(
              'invalid_grant',
              'The refresh grant is inactive.',
            ),
          };
        }
      }
    }
  }

  return { request, response: null };
}

export async function enforceDirectMcpOAuthRequestPolicy(
  request: Request,
): Promise<Response | null> {
  return (await prepareDirectMcpOAuthRequest(request)).response;
}
