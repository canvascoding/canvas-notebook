import 'server-only';

import { resolveDirectMcpOAuthConfig } from '@/app/lib/mcp/server/config';
import { refreshOAuthConsentQuery } from '@/app/lib/mcp/server/oauth-page-query';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';

const MAX_OAUTH_QUERY_LENGTH = 8_192;

type OAuthHandler = (request: Request) => Promise<Response>;

function oauthError(
  error: string,
  errorDescription: string,
  status: number,
): Response {
  return Response.json({
    error,
    error_description: errorDescription,
  }, {
    status,
    headers: {
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  });
}

function singleFormValue(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 1 && typeof values[0] === 'string'
    ? values[0]
    : null;
}

function readProviderRedirect(responseBody: unknown): string | null {
  if (!responseBody || typeof responseBody !== 'object') return null;
  const record = responseBody as Record<string, unknown>;
  return record.redirect === true && typeof record.url === 'string' && record.url
    ? record.url
    : null;
}

function isExpectedOAuthRedirect(
  redirectUrl: string,
  registeredRedirectUri: string,
): boolean {
  try {
    const redirect = new URL(redirectUrl);
    const registered = new URL(registeredRedirectUri);
    if (
      redirect.protocol !== registered.protocol
      || redirect.username !== registered.username
      || redirect.password !== registered.password
      || redirect.host !== registered.host
      || redirect.pathname !== registered.pathname
      || redirect.hash
    ) {
      return false;
    }
    for (const [key, value] of registered.searchParams) {
      if (!redirect.searchParams.getAll(key).includes(value)) return false;
    }
    return Boolean(
      redirect.searchParams.get('code')
      || redirect.searchParams.get('error'),
    );
  } catch {
    return false;
  }
}

function consentRequestHeaders(request: Request, origin: string): Headers {
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    origin,
  });
  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const userAgent = request.headers.get('user-agent');
  if (userAgent) headers.set('user-agent', userAgent);
  return headers;
}

function copyProviderCookies(source: Response, target: Headers): void {
  for (const cookie of source.headers.getSetCookie()) {
    target.append('set-cookie', cookie);
  }
}

/**
 * Completes consent as a top-level form navigation and returns an actual HTTP
 * redirect to the registered client callback. This avoids relying on a
 * browser-side fetch followed by JavaScript navigation to a loopback URL.
 */
export async function completeDirectMcpOAuthConsentRedirect(
  request: Request,
  oauthHandler: OAuthHandler,
  now = Date.now(),
): Promise<Response> {
  if (!(await getDirectMcpRuntimeSettings()).enabled) {
    return oauthError('not_found', 'Direct MCP OAuth is not enabled.', 404);
  }

  const config = resolveDirectMcpOAuthConfig();
  if (request.headers.get('origin') !== config.origin) {
    return oauthError('invalid_request', 'The OAuth consent origin is invalid.', 403);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError('invalid_request', 'The OAuth consent form is invalid.', 400);
  }
  const acceptValue = singleFormValue(form, 'accept');
  const oauthQuery = singleFormValue(form, 'oauth_query');
  if (
    (acceptValue !== 'true' && acceptValue !== 'false')
    || !oauthQuery
    || oauthQuery.length > MAX_OAUTH_QUERY_LENGTH
  ) {
    return oauthError('invalid_request', 'The OAuth consent form is invalid.', 400);
  }

  const refreshedOAuthQuery = await refreshOAuthConsentQuery(oauthQuery, now);
  const query = refreshedOAuthQuery
    ? new URLSearchParams(refreshedOAuthQuery)
    : null;
  const registeredRedirectUri = query?.get('redirect_uri');
  if (!refreshedOAuthQuery || !registeredRedirectUri) {
    return oauthError('invalid_request', 'The OAuth consent request is invalid or expired.', 400);
  }

  const providerResponse = await oauthHandler(new Request(
    `${config.issuer}/oauth2/consent`,
    {
      method: 'POST',
      headers: consentRequestHeaders(request, config.origin),
      body: JSON.stringify({
        accept: acceptValue === 'true',
        oauth_query: refreshedOAuthQuery,
      }),
    },
  ));
  if (!providerResponse.ok) {
    return oauthError(
      providerResponse.status >= 500 ? 'temporarily_unavailable' : 'invalid_request',
      providerResponse.status >= 500
        ? 'The OAuth consent service is temporarily unavailable.'
        : 'The OAuth consent request could not be completed.',
      providerResponse.status >= 500 ? 503 : 400,
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return oauthError('temporarily_unavailable', 'The OAuth consent response was invalid.', 503);
  }
  const redirectUrl = readProviderRedirect(responseBody);
  if (!redirectUrl || !isExpectedOAuthRedirect(redirectUrl, registeredRedirectUri)) {
    return oauthError('temporarily_unavailable', 'The OAuth consent response was invalid.', 503);
  }

  const headers = new Headers({
    location: redirectUrl,
    'cache-control': 'no-store',
    pragma: 'no-cache',
  });
  copyProviderCookies(providerResponse, headers);
  return new Response(null, { status: 303, headers });
}
