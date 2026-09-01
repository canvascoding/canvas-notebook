import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DIRECT_MCP_OAUTH_SCOPES,
  isDirectMcpEnabled,
  resolveDirectMcpServerConfig,
} from '../app/lib/mcp/server/config';

const ORIGIN = 'https://notebook.example.test';
const ISSUER = `${ORIGIN}/api/auth`;
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/callback';

function assertConfigurationContract(): void {
  assert.equal(isDirectMcpEnabled({}), false);
  assert.equal(isDirectMcpEnabled({ CANVAS_MCP_DIRECT_ENABLED: 'false' }), false);
  assert.equal(isDirectMcpEnabled({ CANVAS_MCP_DIRECT_ENABLED: 'TRUE' }), true);
  assert.throws(
    () => isDirectMcpEnabled({ CANVAS_MCP_DIRECT_ENABLED: 'yes' }),
    /must be either "true" or "false"/u,
  );

  const config = resolveDirectMcpServerConfig({
    CANVAS_MCP_DIRECT_ENABLED: 'true',
    NODE_ENV: 'production',
    BETTER_AUTH_BASE_URL: ORIGIN,
    BASE_URL: ORIGIN,
  });
  assert.deepEqual(config, {
    enabled: true,
    origin: ORIGIN,
    issuer: ISSUER,
    resource: RESOURCE,
    authorizationServerMetadataUrl: `${ORIGIN}/.well-known/oauth-authorization-server/api/auth`,
    authorizationServerMetadataAliasUrl: `${ISSUER}/.well-known/oauth-authorization-server`,
    protectedResourceMetadataUrl: `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    protectedResourceMetadataAliasUrl: `${ORIGIN}/.well-known/oauth-protected-resource`,
  });

  assert.throws(
    () => resolveDirectMcpServerConfig({
      CANVAS_MCP_DIRECT_ENABLED: 'true',
      NODE_ENV: 'production',
      BETTER_AUTH_BASE_URL: 'http://notebook.example.test',
    }),
    /requires an HTTPS public origin/u,
  );
  assert.equal(
    resolveDirectMcpServerConfig({
      CANVAS_MCP_DIRECT_ENABLED: 'true',
      NODE_ENV: 'production',
      BETTER_AUTH_BASE_URL: 'http://localhost:3456',
      BASE_URL: 'http://localhost:3456',
    }).resource,
    'http://localhost:3456/mcp',
  );
  assert.throws(
    () => resolveDirectMcpServerConfig({
      CANVAS_MCP_DIRECT_ENABLED: 'true',
      NODE_ENV: 'test',
      BETTER_AUTH_BASE_URL: `${ORIGIN}/api/auth`,
    }),
    /only the public instance origin/u,
  );
  assert.throws(
    () => resolveDirectMcpServerConfig({
      CANVAS_MCP_DIRECT_ENABLED: 'true',
      NODE_ENV: 'test',
      BETTER_AUTH_BASE_URL: ORIGIN,
      BASE_URL: 'https://other.example.test',
    }),
    /must use the same public origin/u,
  );
}

function configureRuntime(dataDir: string): void {
  const environment = process.env as Record<string, string | undefined>;
  environment.DATA = dataDir;
  environment.NODE_ENV = 'test';
  environment.CANVAS_DATABASE_PROVIDER = 'sqlite';
  environment.CANVAS_MCP_DIRECT_ENABLED = 'true';
  environment.BETTER_AUTH_BASE_URL = ORIGIN;
  environment.BASE_URL = ORIGIN;
  environment.BETTER_AUTH_TRUSTED_ORIGINS = ORIGIN;
  environment.BETTER_AUTH_SECRET = 'mcp-oauth-provider-test-secret-at-least-32-characters';
  delete environment.DATABASE_URL;
  delete environment.NEXT_PHASE;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json();
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

async function registerClient(
  auth: { handler: (request: Request) => Promise<Response> },
  body: Record<string, unknown>,
  prepareRequest: (request: Request) => Promise<{
    request: Request;
    response: Response | null;
  }>,
): Promise<Response> {
  const request = new Request(`${ISSUER}/oauth2/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
  const prepared = await prepareRequest(request);
  return prepared.response ?? auth.handler(prepared.request);
}

async function assertRouteRegistration(
  post: (request: import('next/server').NextRequest) => Promise<Response>,
  NextRequest: typeof import('next/server').NextRequest,
): Promise<void> {
  for (const tokenEndpointAuthMethod of [undefined, 'client_secret_post']) {
    const response = await post(new NextRequest(`${ISSUER}/oauth2/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        client_name: tokenEndpointAuthMethod
          ? 'ChatGPT-compatible public client'
          : 'Implicit public client',
        redirect_uris: [REDIRECT_URI],
        ...(tokenEndpointAuthMethod ? { token_endpoint_auth_method: tokenEndpointAuthMethod } : {}),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: DIRECT_MCP_OAUTH_SCOPES.join(' '),
      }),
    }));
    assert.equal([200, 201].includes(response.status), true);
    assert.match(response.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/iu);
    const registered = await readJson(response);
    assert.equal(registered.token_endpoint_auth_method, 'none');
    assert.equal('client_secret' in registered, false);
  }

  const rejectedMethod = await post(new NextRequest(`${ISSUER}/oauth2/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify({
      client_name: 'Confidential client is not allowed',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'client_secret_basic',
    }),
  }));
  assert.equal(rejectedMethod.status, 400);
  assert.equal((await readJson(rejectedMethod)).error, 'invalid_client_metadata');
}

async function assertRegistrationRebuildDoesNotReuseIncomingRequest(
  prepareRequest: (request: Request) => Promise<{
    request: Request;
    response: Response | null;
  }>,
  NextRequest: typeof import('next/server').NextRequest,
): Promise<void> {
  const incomingRequest = new NextRequest(`${ISSUER}/oauth2/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify({
      client_name: 'Stream-backed public client',
      redirect_uris: [REDIRECT_URI],
    }),
  });
  const nativeRequest = globalThis.Request;
  const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Request');
  assert.ok(requestDescriptor);

  class RequestRejectingRequestInput extends nativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (input instanceof nativeRequest) {
        throw new Error('The normalized request must not reuse the incoming Request body stream.');
      }
      super(input, init);
    }
  }

  Object.defineProperty(globalThis, 'Request', {
    ...requestDescriptor,
    value: RequestRejectingRequestInput,
  });
  try {
    const prepared = await prepareRequest(incomingRequest);
    assert.equal(prepared.response, null);
    assert.equal(prepared.request.url, incomingRequest.url);
    assert.equal(prepared.request.method, 'POST');
    assert.equal(prepared.request.headers.get('origin'), ORIGIN);
    const metadata = await prepared.request.json() as Record<string, unknown>;
    assert.equal(metadata.token_endpoint_auth_method, 'none');
  } finally {
    Object.defineProperty(globalThis, 'Request', requestDescriptor);
  }
}

async function assertMetadata(
  getMetadata: (request: Request) => Promise<Response>,
): Promise<void> {
  for (const url of [
    `${ORIGIN}/.well-known/oauth-authorization-server/api/auth`,
    `${ISSUER}/.well-known/oauth-authorization-server`,
  ]) {
    const response = await getMetadata(new Request(url, {
      headers: {
        'x-forwarded-host': 'attacker.example.test',
        'x-forwarded-proto': 'http',
      },
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/u);
    assert.match(response.headers.get('cache-control') || '', /max-age=300/u);
    const metadata = await readJson(response);
    assert.equal(metadata.issuer, ISSUER);
    assert.equal(metadata.authorization_endpoint, `${ISSUER}/oauth2/authorize`);
    assert.equal(metadata.token_endpoint, `${ISSUER}/oauth2/token`);
    assert.equal(metadata.registration_endpoint, `${ISSUER}/oauth2/register`);
    assert.equal(metadata.revocation_endpoint, `${ISSUER}/oauth2/revoke`);
    assert.equal(metadata.introspection_endpoint, `${ISSUER}/oauth2/introspect`);
    assert.equal(metadata.jwks_uri, `${ISSUER}/jwks`);
    assert.deepEqual(metadata.grant_types_supported, [
      'authorization_code',
      'refresh_token',
    ]);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(metadata.scopes_supported, [...DIRECT_MCP_OAUTH_SCOPES]);
  }
}

async function assertRegistrationPolicy(
  auth: { handler: (request: Request) => Promise<Response> },
  enforcePolicy: (request: Request) => Promise<Response | null>,
  prepareRequest: (request: Request) => Promise<{
    request: Request;
    response: Response | null;
  }>,
): Promise<string> {
  const validRegistration = await registerClient(auth, {
    client_name: 'ChatGPT Direct MCP Test',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: DIRECT_MCP_OAUTH_SCOPES.join(' '),
  }, prepareRequest);
  assert.equal([200, 201].includes(validRegistration.status), true);
  const registered = await readJson(validRegistration);
  assert.equal(typeof registered.client_id, 'string');
  assert.equal(registered.token_endpoint_auth_method, 'none');
  assert.equal('client_secret' in registered, false);
  assert.deepEqual(registered.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(registered.scope, DIRECT_MCP_OAUTH_SCOPES.join(' '));

  const invalidScope = await registerClient(auth, {
    client_name: 'Invalid Scope',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'openid knowledge:delete',
  }, prepareRequest);
  assert.equal(invalidScope.status, 400);
  assert.equal((await readJson(invalidScope)).error, 'invalid_scope');

  const clientCredentials = await registerClient(auth, {
    client_name: 'Invalid Grant',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['client_credentials'],
  }, prepareRequest);
  assert.equal(clientCredentials.status, 400);
  assert.equal((await readJson(clientCredentials)).error, 'invalid_client_metadata');

  const invalidRedirect = await registerClient(auth, {
    client_name: 'Invalid Redirect',
    redirect_uris: ['https://chatgpt.com/connector/oauth/callback#fragment'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  }, prepareRequest);
  assert.equal(invalidRedirect.status, 400);

  const disabledPkce = await registerClient(auth, {
    client_name: 'Invalid PKCE',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    require_pkce: false,
  }, prepareRequest);
  assert.equal(disabledPkce.status, 400);
  assert.equal((await readJson(disabledPkce)).error, 'invalid_client_metadata');

  return String(registered.client_id);
}

function authorizeUrl(clientId: string, overrides: Record<string, string | null> = {}): URL {
  const url = new URL(`${ISSUER}/oauth2/authorize`);
  const values: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'openid workspace:list knowledge:read',
    state: 'opaque-client-state',
    resource: RESOURCE,
    code_challenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_',
    code_challenge_method: 'S256',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete values[key];
    else values[key] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function assertAuthorizePolicy(
  auth: { handler: (request: Request) => Promise<Response> },
  clientId: string,
  enforcePolicy: (request: Request) => Promise<Response | null>,
): Promise<void> {
  const noResource = authorizeUrl(clientId, { resource: null });
  const missingResourceResponse = await enforcePolicy(new Request(noResource));
  assert.equal(missingResourceResponse?.status, 400);
  assert.equal((await readJson(missingResourceResponse!)).error, 'invalid_target');

  const wrongResource = authorizeUrl(clientId, {
    resource: 'https://other.example.test/mcp',
  });
  assert.equal((await enforcePolicy(new Request(wrongResource)))?.status, 400);
  assert.equal(await enforcePolicy(new Request(authorizeUrl(clientId))), null);

  const validResponse = await auth.handler(new Request(authorizeUrl(clientId)));
  assert.equal(validResponse.status, 302);
  const loginUrl = new URL(validResponse.headers.get('location') || '', ORIGIN);
  assert.equal(loginUrl.origin, ORIGIN);
  assert.equal(loginUrl.pathname, '/login');
  assert.equal(loginUrl.searchParams.has('sig'), true);
  assert.equal(loginUrl.searchParams.get('client_id'), clientId);

  const missingPkce = await auth.handler(new Request(authorizeUrl(clientId, {
    code_challenge: null,
    code_challenge_method: null,
  })));
  assert.equal(missingPkce.status, 302);
  const pkceError = new URL(missingPkce.headers.get('location') || '', ORIGIN);
  assert.equal(pkceError.origin + pkceError.pathname, REDIRECT_URI);
  assert.equal(pkceError.searchParams.get('error'), 'invalid_request');
  assert.match(pkceError.searchParams.get('error_description') || '', /pkce is required/u);

  const unknownScope = await auth.handler(new Request(authorizeUrl(clientId, {
    scope: 'openid knowledge:delete',
  })));
  assert.equal(unknownScope.status, 302);
  assert.equal(
    new URL(unknownScope.headers.get('location') || '', ORIGIN).searchParams.get('error'),
    'invalid_scope',
  );

  const wrongRedirect = await auth.handler(new Request(authorizeUrl(clientId, {
    redirect_uri: 'https://attacker.example.test/callback',
  })));
  assert.equal(wrongRedirect.status, 302);
  assert.notEqual(
    new URL(wrongRedirect.headers.get('location') || '', ORIGIN).origin,
    'https://attacker.example.test',
  );

  const plainPkce = await auth.handler(new Request(authorizeUrl(clientId, {
    code_challenge_method: 'plain',
  })));
  assert.equal(plainPkce.status, 302);
  const plainPkceError = new URL(plainPkce.headers.get('location') || '', ORIGIN);
  assert.equal(plainPkceError.origin + plainPkceError.pathname, REDIRECT_URI);
  assert.equal(plainPkceError.searchParams.get('error'), 'invalid_request');
  assert.match(plainPkceError.searchParams.get('error_description') || '', /S256/u);
}

async function assertTokenPolicy(
  auth: { handler: (request: Request) => Promise<Response> },
  clientId: string,
  enforcePolicy: (request: Request) => Promise<Response | null>,
): Promise<void> {
  const tokenRequest = (resourceValues: string[]) => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: 'unused-code',
      code_verifier: 'unused-verifier',
      redirect_uri: REDIRECT_URI,
    });
    for (const resource of resourceValues) body.append('resource', resource);

    return new Request(`${ISSUER}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  };

  const missingResourceRequest = tokenRequest([]);
  const missingResourceResponse = await enforcePolicy(missingResourceRequest);
  assert.equal(missingResourceResponse?.status, 400);
  assert.equal((await readJson(missingResourceResponse!)).error, 'invalid_target');

  for (const resourceValues of [
    ['https://attacker.example.test/mcp'],
    [RESOURCE, 'https://attacker.example.test/mcp'],
    [RESOURCE, RESOURCE],
  ]) {
    const response = await enforcePolicy(tokenRequest(resourceValues));
    assert.equal(response?.status, 400);
    assert.equal((await readJson(response!)).error, 'invalid_target');
  }

  const unsupportedGrant = await auth.handler(new Request(`${ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      resource: RESOURCE,
    }),
  }));
  assert.equal(unsupportedGrant.status, 400);
  assert.equal((await readJson(unsupportedGrant)).error, 'unsupported_grant_type');
}

async function main(): Promise<void> {
  assertConfigurationContract();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-oauth-provider-'));
  configureRuntime(dataDir);

  try {
    const [{ auth }, { getAuthorizationServerMetadata }, {
      enforceDirectMcpOAuthRequestPolicy,
      prepareDirectMcpOAuthRequest,
    }, { POST: postOAuthRoute }, { NextRequest }] = await Promise.all([
      import('../app/lib/auth'),
      import('../app/lib/mcp/server/authorization-server-metadata'),
      import('../app/lib/mcp/server/oauth-request-policy'),
      import('../app/api/auth/[...all]/route'),
      import('next/server'),
    ]);

    await assertMetadata(getAuthorizationServerMetadata);
    const previousFeatureFlag = process.env.CANVAS_MCP_DIRECT_ENABLED;
    process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
    const disabledResponse = await enforceDirectMcpOAuthRequestPolicy(new Request(`${ISSUER}/oauth2/register`, {
      method: 'POST',
    }));
    assert.equal(disabledResponse?.status, 404);
    process.env.CANVAS_MCP_DIRECT_ENABLED = previousFeatureFlag;
    await assertRegistrationRebuildDoesNotReuseIncomingRequest(
      prepareDirectMcpOAuthRequest,
      NextRequest,
    );
    await assertRouteRegistration(postOAuthRoute, NextRequest);
    const clientId = await assertRegistrationPolicy(
      auth,
      enforceDirectMcpOAuthRequestPolicy,
      prepareDirectMcpOAuthRequest,
    );
    await assertAuthorizePolicy(auth, clientId, enforceDirectMcpOAuthRequestPolicy);
    await assertTokenPolicy(auth, clientId, enforceDirectMcpOAuthRequestPolicy);

    const { openDb } = await import('../app/lib/db');
    const database = await openDb();
    try {
      const storedClient = await database.get(
        `
          SELECT client_secret AS clientSecret, token_endpoint_auth_method AS tokenEndpointAuthMethod, require_pkce AS requirePkce
          FROM oauth_client
          WHERE client_id = ?
        `,
        [clientId],
      ) as { clientSecret: string | null; tokenEndpointAuthMethod: string | null; requirePkce: number | null };
      assert.equal(storedClient.clientSecret, null);
      assert.equal(storedClient.tokenEndpointAuthMethod, 'none');
      assert.notEqual(storedClient.requirePkce, 0);
    } finally {
      await database.close();
    }

    console.log('mcp-server-oauth-provider-test: ok');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
