import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { decodeJwt } from 'jose';

import {
  DIRECT_MCP_OAUTH_SCOPES,
  resolveDirectMcpServerConfig,
} from '../app/lib/mcp/server/config';

const ORIGIN = 'https://notebook.example.test';
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/callback';
const WRONG_REDIRECT_URI = 'https://chatgpt.com/connector/oauth/other-callback';
const EMAIL = 'oauth-client-owner@example.test';
const PASSWORD = 'OAuthClientOwnerPassword123!';
const CODE_VERIFIER = 'canvas-notebook-oauth-client-verifier-0123456789-._~';
const WRONG_CODE_VERIFIER = 'canvas-notebook-oauth-client-wrong-verifier-9876543210';
const GRANTED_SCOPES = [
  'openid',
  'offline_access',
  'workspace:list',
  'knowledge:read',
];

type JsonRecord = Record<string, unknown>;
type RouteDispatcher = (request: Request) => Promise<Response>;

async function mcpRequest(input: {
  post: (request: Request) => Promise<Response>;
  resource: string;
  token: string;
  id: number;
  method: string;
  params: JsonRecord;
}): Promise<Response> {
  return input.post(new Request(input.resource, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${input.token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: input.id,
      method: input.method,
      params: input.params,
    }),
  }));
}

function configureRuntime(dataDir: string): void {
  const environment = process.env as Record<string, string | undefined>;
  environment.DATA = dataDir;
  environment.NODE_ENV = 'test';
  environment.CANVAS_DATABASE_PROVIDER = 'sqlite';
  environment.CANVAS_MCP_DIRECT_ENABLED = 'true';
  environment.CANVAS_INSTANCE_ID = 'mcp-oauth-client-test';
  environment.BETTER_AUTH_BASE_URL = ORIGIN;
  environment.BASE_URL = ORIGIN;
  environment.BETTER_AUTH_TRUSTED_ORIGINS = ORIGIN;
  environment.BETTER_AUTH_SECRET = 'mcp-oauth-client-test-secret-at-least-32-characters';
  delete environment.DATABASE_URL;
  delete environment.NEXT_PHASE;
}

async function readJson(response: Response): Promise<JsonRecord> {
  const value = await response.json();
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as JsonRecord;
}

function readSessionCookie(response: Response): string {
  const sessionCookie = response.headers
    .getSetCookie()
    .find((value) => value.includes('session_token='));
  assert.ok(sessionCookie, 'Expected Better Auth to set a session cookie.');
  return sessionCookie.split(';', 1)[0];
}

function readRedirect(responseBody: JsonRecord): URL {
  assert.equal(responseBody.redirect, true);
  assert.equal(typeof responseBody.url, 'string');
  return new URL(String(responseBody.url), ORIGIN);
}

function pkceChallenge(verifier = CODE_VERIFIER): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function buildAuthorizationUrl(input: {
  clientId: string;
  resource: string;
  state: string;
  redirectUri?: string;
  scopes?: string[];
  codeChallenge?: string | null;
  codeChallengeMethod?: 'S256' | 'plain' | null;
}): URL {
  const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri ?? REDIRECT_URI);
  url.searchParams.set('scope', (input.scopes ?? GRANTED_SCOPES).join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('resource', input.resource);
  url.searchParams.set('prompt', 'consent');
  if (input.codeChallenge !== null) {
    url.searchParams.set(
      'code_challenge',
      input.codeChallenge ?? pkceChallenge(),
    );
  }
  if (input.codeChallengeMethod !== null) {
    url.searchParams.set(
      'code_challenge_method',
      input.codeChallengeMethod ?? 'S256',
    );
  }
  return url;
}

async function registerPublicClient(
  dispatch: RouteDispatcher,
  issuer: string,
  name: string,
  tokenEndpointAuthMethod: 'none' | null = 'none',
): Promise<string> {
  const metadata: JsonRecord = {
    client_name: name,
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: DIRECT_MCP_OAUTH_SCOPES.join(' '),
  };
  if (tokenEndpointAuthMethod !== null) {
    metadata.token_endpoint_auth_method = tokenEndpointAuthMethod;
  }
  const response = await dispatch(new Request(`${issuer}/oauth2/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify(metadata),
  }));
  assert.equal([200, 201].includes(response.status), true);
  const registered = await readJson(response);
  assert.equal(registered.token_endpoint_auth_method, 'none');
  assert.equal('client_secret' in registered, false);
  const clientId = String(registered.client_id);
  assert.ok(clientId);
  return clientId;
}

async function assertDynamicRegistrationBoundary(
  dispatch: RouteDispatcher,
  issuer: string,
): Promise<void> {
  const implicitPublicClientId = await registerPublicClient(
    dispatch,
    issuer,
    'ChatGPT Public Client With Omitted Auth Method',
    null,
  );
  assert.ok(implicitPublicClientId);

  const invalidAuthMethod = await dispatch(new Request(`${issuer}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      client_name: 'Confidential Client Is Not Allowed',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'client_secret_basic',
    }),
  }));
  assert.equal(invalidAuthMethod.status, 400);
  assert.equal((await readJson(invalidAuthMethod)).error, 'invalid_client_metadata');

  const invalidContentType = await dispatch(new Request(`${issuer}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: ORIGIN },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
  }));
  assert.equal(invalidContentType.status, 400);
  assert.equal((await readJson(invalidContentType)).error, 'invalid_client_metadata');

  const oversizedMetadata = await dispatch(new Request(`${issuer}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: 'x'.repeat(16 * 1024),
    }),
  }));
  assert.equal(oversizedMetadata.status, 400);
  assert.equal((await readJson(oversizedMetadata)).error, 'invalid_client_metadata');
}

async function authorizeCode(input: {
  dispatch: RouteDispatcher;
  clientId: string;
  cookie: string;
  resource: string;
  state: string;
}): Promise<string> {
  const authorizeResponse = await input.dispatch(new Request(
    buildAuthorizationUrl({
      clientId: input.clientId,
      resource: input.resource,
      state: input.state,
    }),
    {
      headers: {
        cookie: input.cookie,
      },
    },
  ));
  assert.equal(authorizeResponse.status, 302);
  const consentUrl = new URL(
    authorizeResponse.headers.get('location') || '',
    ORIGIN,
  );
  assert.equal(consentUrl.pathname, '/oauth/consent');

  const consentResponse = await input.dispatch(new Request(
    `${ORIGIN}/api/auth/oauth2/consent`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: input.cookie,
        origin: ORIGIN,
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: consentUrl.searchParams.toString(),
      }),
    },
  ));
  assert.equal(consentResponse.status, 200);
  const callback = readRedirect(await readJson(consentResponse));
  assert.equal(callback.origin + callback.pathname, REDIRECT_URI);
  assert.equal(callback.searchParams.get('state'), input.state);
  const code = callback.searchParams.get('code');
  assert.ok(code);
  return code;
}

async function exchangeAuthorizationCode(input: {
  dispatch: RouteDispatcher;
  issuer: string;
  resource: string;
  clientId: string;
  code: string;
  verifier?: string;
  redirectUri?: string;
}): Promise<Response> {
  return input.dispatch(new Request(`${input.issuer}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier ?? CODE_VERIFIER,
      redirect_uri: input.redirectUri ?? REDIRECT_URI,
      resource: input.resource,
    }),
  }));
}

function serializeLogArguments(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(' ');
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-oauth-client-'));
  configureRuntime(dataDir);

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const capturedLogs: string[] = [];
  let captureLogs = false;
  const capture = (args: unknown[]): void => {
    if (captureLogs) capturedLogs.push(serializeLogArguments(args));
  };
  console.log = (...args: unknown[]) => capture(args);
  console.warn = (...args: unknown[]) => capture(args);
  console.error = (...args: unknown[]) => capture(args);

  try {
    const { createInitialOwner } = await import('../app/lib/auth-setup');
    await createInitialOwner({
      name: 'OAuth Client Owner',
      email: EMAIL,
      password: PASSWORD,
    });

    const [
      authRoute,
      mcpRoute,
      { NextRequest },
      { auth },
      {
        DirectMcpAuthorizationError,
        verifyDirectMcpAccessToken,
      },
      { openDb },
    ] = await Promise.all([
      import('../app/api/auth/[...all]/route'),
      import('../app/mcp/route'),
      import('next/server'),
      import('../app/lib/auth'),
      import('../app/lib/mcp/server/access-token-verifier'),
      import('../app/lib/db'),
    ]);
    const { issuer, resource } = resolveDirectMcpServerConfig();

    async function dispatch(request: Request): Promise<Response> {
      const nextRequest = new NextRequest(request);
      if (request.method === 'GET') return authRoute.GET(nextRequest);
      if (request.method === 'POST') return authRoute.POST(nextRequest);
      throw new Error(`Unsupported test method ${request.method}.`);
    }

    captureLogs = true;

    const clientId = await registerPublicClient(
      dispatch,
      issuer,
      'ChatGPT Automated PKCE Client',
    );
    const otherClientId = await registerPublicClient(
      dispatch,
      issuer,
      'Other Public OAuth Client',
    );
    await assertDynamicRegistrationBoundary(dispatch, issuer);

    const loginResponse = await dispatch(new Request(`${issuer}/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD,
      }),
    }));
    assert.equal(loginResponse.status, 200);
    const sessionCookie = readSessionCookie(loginResponse);

    const missingPkce = await dispatch(new Request(buildAuthorizationUrl({
      clientId,
      resource,
      state: 'missing-pkce',
      codeChallenge: null,
      codeChallengeMethod: null,
    }), {
      headers: { cookie: sessionCookie },
    }));
    assert.equal(missingPkce.status, 400);
    assert.equal((await missingPkce.json()).error, 'invalid_request');

    const plainPkce = await dispatch(new Request(buildAuthorizationUrl({
      clientId,
      resource,
      state: 'plain-pkce',
      codeChallenge: CODE_VERIFIER,
      codeChallengeMethod: 'plain',
    }), {
      headers: { cookie: sessionCookie },
    }));
    assert.equal(plainPkce.status, 400);
    assert.equal((await plainPkce.json()).error, 'invalid_request');

    const wrongAuthorizeResource = await dispatch(new Request(
      buildAuthorizationUrl({
        clientId,
        resource: 'https://foreign-instance.example.test/mcp',
        state: 'wrong-resource',
      }),
      {
        headers: { cookie: sessionCookie },
      },
    ));
    assert.equal(wrongAuthorizeResource.status, 400);
    assert.equal((await readJson(wrongAuthorizeResource)).error, 'invalid_target');

    const unknownScope = await dispatch(new Request(buildAuthorizationUrl({
      clientId,
      resource,
      state: 'unknown-scope',
      scopes: ['openid', 'knowledge:delete'],
    }), {
      headers: { cookie: sessionCookie },
    }));
    assert.equal(unknownScope.status, 302);
    const scopeCallback = new URL(
      unknownScope.headers.get('location') || '',
      ORIGIN,
    );
    assert.equal(scopeCallback.searchParams.get('error'), 'invalid_scope');

    const wrongAuthorizeRedirect = await dispatch(new Request(buildAuthorizationUrl({
      clientId,
      resource,
      state: 'wrong-redirect',
      redirectUri: WRONG_REDIRECT_URI,
    }), {
      headers: { cookie: sessionCookie },
    }));
    assert.equal(wrongAuthorizeRedirect.status, 302);
    assert.notEqual(
      new URL(
        wrongAuthorizeRedirect.headers.get('location') || '',
        ORIGIN,
      ).origin + new URL(
        wrongAuthorizeRedirect.headers.get('location') || '',
        ORIGIN,
      ).pathname,
      WRONG_REDIRECT_URI,
    );

    const wrongVerifierCode = await authorizeCode({
      dispatch,
      clientId,
      cookie: sessionCookie,
      resource,
      state: 'wrong-verifier',
    });
    const wrongVerifierResponse = await exchangeAuthorizationCode({
      dispatch,
      issuer,
      resource,
      clientId,
      code: wrongVerifierCode,
      verifier: WRONG_CODE_VERIFIER,
    });
    assert.equal(wrongVerifierResponse.status, 401);
    assert.equal((await readJson(wrongVerifierResponse)).error, 'invalid_request');

    const wrongRedirectCode = await authorizeCode({
      dispatch,
      clientId,
      cookie: sessionCookie,
      resource,
      state: 'wrong-token-redirect',
    });
    const wrongTokenRedirect = await exchangeAuthorizationCode({
      dispatch,
      issuer,
      resource,
      clientId,
      code: wrongRedirectCode,
      redirectUri: WRONG_REDIRECT_URI,
    });
    assert.equal(wrongTokenRedirect.status, 400);
    assert.equal((await readJson(wrongTokenRedirect)).error, 'invalid_grant');

    const validCode = await authorizeCode({
      dispatch,
      clientId,
      cookie: sessionCookie,
      resource,
      state: 'valid-code',
    });
    const missingTokenResource = await dispatch(new Request(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: validCode,
        code_verifier: CODE_VERIFIER,
        redirect_uri: REDIRECT_URI,
      }),
    }));
    assert.equal(missingTokenResource.status, 400);
    assert.equal((await readJson(missingTokenResource)).error, 'invalid_target');

    const tokenResponse = await exchangeAuthorizationCode({
      dispatch,
      issuer,
      resource,
      clientId,
      code: validCode,
    });
    assert.equal(tokenResponse.status, 200);
    assert.match(tokenResponse.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/iu);
    const initialTokens = await readJson(tokenResponse);
    const accessToken = String(initialTokens.access_token);
    const refreshToken = String(initialTokens.refresh_token);
    const idToken = String(initialTokens.id_token);
    assert.ok(accessToken);
    assert.ok(refreshToken);
    assert.ok(idToken);
    assert.equal(initialTokens.token_type, 'Bearer');
    assert.equal(initialTokens.scope, GRANTED_SCOPES.join(' '));

    const replayResponse = await exchangeAuthorizationCode({
      dispatch,
      issuer,
      resource,
      clientId,
      code: validCode,
    });
    assert.equal(replayResponse.status, 400);
    assert.equal((await readJson(replayResponse)).error, 'invalid_grant');

    const accessPayload = decodeJwt(accessToken);
    assert.equal(accessPayload.iss, issuer);
    const audiences = typeof accessPayload.aud === 'string'
      ? [accessPayload.aud]
      : accessPayload.aud ?? [];
    assert.ok(audiences.includes(resource));
    assert.ok(audiences.every((audience) => (
      audience === resource || audience === `${issuer}/oauth2/userinfo`
    )));

    const principal = await verifyDirectMcpAccessToken(
      accessToken,
      ['knowledge:read'],
    );
    assert.equal(principal.clientId, clientId);
    assert.equal(principal.audience, resource);

    const initializedMcp = await mcpRequest({
      post: mcpRoute.POST,
      resource,
      token: accessToken,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: 'canvas-oauth-client-flow-test',
          version: '1.0.0',
        },
      },
    });
    assert.equal(initializedMcp.status, 200);
    assert.match(initializedMcp.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/iu);
    const initializedMcpResult = await readJson(initializedMcp);
    assert.equal(
      ((initializedMcpResult.result as JsonRecord).serverInfo as JsonRecord).name,
      'canvas-notebook-direct-mcp',
    );

    const authenticatedTools = await mcpRequest({
      post: mcpRoute.POST,
      resource,
      token: accessToken,
      id: 2,
      method: 'tools/list',
      params: {},
    });
    assert.equal(authenticatedTools.status, 200);
    const authenticatedToolsResult = await readJson(authenticatedTools);
    assert.ok(Array.isArray((authenticatedToolsResult.result as JsonRecord).tools));

    const authenticatedProbe = await mcpRequest({
      post: mcpRoute.POST,
      resource,
      token: accessToken,
      id: 3,
      method: 'tools/call',
      params: { name: 'auth_probe', arguments: {} },
    });
    assert.equal(authenticatedProbe.status, 200);
    const authenticatedProbeResult = await readJson(authenticatedProbe);
    const structuredContent = (
      (authenticatedProbeResult.result as JsonRecord).structuredContent
    ) as JsonRecord;
    assert.equal(structuredContent.authenticated, true);

    const now = Math.floor(Date.now() / 1000);
    const baseClaims = {
      sub: principal.userId,
      azp: clientId,
      sid: principal.sessionId,
      scope: GRANTED_SCOPES.join(' '),
      iat: now,
      exp: now + 900,
    };
    const foreignIssuer = await auth.api.signJWT({
      body: {
        payload: {
          ...baseClaims,
          iss: 'https://foreign-instance.example.test/api/auth',
          aud: resource,
        },
      },
    });
    const foreignAudience = await auth.api.signJWT({
      body: {
        payload: {
          ...baseClaims,
          iss: issuer,
          aud: 'https://foreign-instance.example.test/mcp',
        },
      },
    });
    for (const token of [foreignIssuer.token, foreignAudience.token]) {
      await assert.rejects(
        () => verifyDirectMcpAccessToken(token, ['knowledge:read']),
        (error: unknown) => (
          error instanceof DirectMcpAuthorizationError
          && error.status === 401
          && error.code === 'invalid_token'
        ),
      );
    }
    await assert.rejects(
      () => verifyDirectMcpAccessToken(accessToken, ['knowledge:search']),
      (error: unknown) => (
        error instanceof DirectMcpAuthorizationError
        && error.status === 403
        && error.code === 'insufficient_scope'
      ),
    );

    const elevatedScopeCode = await authorizeCode({
      dispatch,
      clientId,
      cookie: sessionCookie,
      resource,
      state: 'elevated-refresh-scope',
    });
    const elevatedScopeTokens = await exchangeAuthorizationCode({
      dispatch,
      issuer,
      resource,
      clientId,
      code: elevatedScopeCode,
    });
    assert.equal(elevatedScopeTokens.status, 200);
    const elevatedScopeRefreshToken = String(
      (await readJson(elevatedScopeTokens)).refresh_token,
    );
    const elevatedRefreshScope = await dispatch(new Request(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: elevatedScopeRefreshToken,
        scope: `${GRANTED_SCOPES.join(' ')} knowledge:search`,
        resource,
      }),
    }));
    assert.equal(elevatedRefreshScope.status, 400);
    assert.equal((await readJson(elevatedRefreshScope)).error, 'invalid_scope');

    const refreshFlowCode = await authorizeCode({
      dispatch,
      clientId,
      cookie: sessionCookie,
      resource,
      state: 'refresh-flow',
    });
    const refreshFlowTokens = await exchangeAuthorizationCode({
      dispatch,
      issuer,
      resource,
      clientId,
      code: refreshFlowCode,
    });
    assert.equal(refreshFlowTokens.status, 200);
    const refreshFlowRefreshToken = String(
      (await readJson(refreshFlowTokens)).refresh_token,
    );

    const wrongRefreshResource = await dispatch(new Request(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshFlowRefreshToken,
        resource: 'https://foreign-instance.example.test/mcp',
      }),
    }));
    assert.equal(wrongRefreshResource.status, 400);
    assert.equal((await readJson(wrongRefreshResource)).error, 'invalid_target');

    const refreshResponse = await dispatch(new Request(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: ORIGIN,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshFlowRefreshToken,
        resource,
      }),
    }));
    assert.equal(refreshResponse.status, 200);
    const rotatedTokens = await readJson(refreshResponse);
    const rotatedAccessToken = String(rotatedTokens.access_token);
    const rotatedRefreshToken = String(rotatedTokens.refresh_token);
    assert.ok(rotatedAccessToken);
    assert.ok(rotatedRefreshToken);
    assert.notEqual(rotatedRefreshToken, refreshFlowRefreshToken);
    await verifyDirectMcpAccessToken(rotatedAccessToken, ['knowledge:read']);

    const rotationDatabase = await openDb();
    try {
      const oldGrant = await rotationDatabase.get(`
        SELECT revoked
        FROM oauth_refresh_token
        WHERE token = ?
      `, [tokenHash(refreshFlowRefreshToken)]) as { revoked: unknown } | undefined;
      const newGrant = await rotationDatabase.get(`
        SELECT revoked
        FROM oauth_refresh_token
        WHERE token = ?
      `, [tokenHash(rotatedRefreshToken)]) as { revoked: unknown } | undefined;
      assert.ok(oldGrant?.revoked);
      assert.equal(newGrant?.revoked, null);
    } finally {
      await rotationDatabase.close();
    }

    const wrongClientRevocation = await dispatch(new Request(`${issuer}/oauth2/revoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: otherClientId,
        token: rotatedRefreshToken,
        token_type_hint: 'refresh_token',
      }),
    }));
    assert.equal(wrongClientRevocation.status, 200);
    await verifyDirectMcpAccessToken(rotatedAccessToken, ['knowledge:read']);

    const revocationResponse = await dispatch(new Request(`${issuer}/oauth2/revoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        token: rotatedRefreshToken,
        token_type_hint: 'refresh_token',
      }),
    }));
    assert.equal(revocationResponse.status, 200);
    await verifyDirectMcpAccessToken(rotatedAccessToken, ['knowledge:read']);

    const refreshAfterRevocation = await dispatch(new Request(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: rotatedRefreshToken,
        resource,
      }),
    }));
    assert.equal(refreshAfterRevocation.status, 400);
    assert.equal((await readJson(refreshAfterRevocation)).error, 'invalid_grant');

    const failingRegistrationDatabase = await openDb();
    try {
      await failingRegistrationDatabase.run(
        'ALTER TABLE oauth_client RENAME TO oauth_client_unavailable',
      );
    } finally {
      await failingRegistrationDatabase.close();
    }
    const providerFailure = await dispatch(new Request(`${issuer}/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        client_name: 'Provider Failure Diagnostic Client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
      }),
    }));
    assert.equal(providerFailure.status, 503);
    assert.match(providerFailure.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/iu);
    const providerFailureBody = await readJson(providerFailure);
    assert.equal(providerFailureBody.error, 'temporarily_unavailable');
    assert.equal(JSON.stringify(providerFailureBody).includes('oauth_client'), false);

    captureLogs = false;
    const auditDatabase = await openDb();
    let auditText: string;
    try {
      auditText = JSON.stringify(await auditDatabase.all(`
        SELECT *
        FROM audit_events
        WHERE source = 'auth'
        ORDER BY created_at ASC
      `));
    } finally {
      await auditDatabase.close();
    }

    const capturedText = capturedLogs.join('\n');
    const sensitiveValues = [
      ['password', PASSWORD],
      ['PKCE verifier', CODE_VERIFIER],
      ['authorization code', validCode],
      ['access token', accessToken],
      ['refresh token', refreshToken],
      ['rotated access token', rotatedAccessToken],
      ['rotated refresh token', rotatedRefreshToken],
      ['ID token', idToken],
      ['session cookie', sessionCookie],
    ] as const;
    for (const [label, value] of sensitiveValues) {
      assert.equal(
        capturedText.includes(value),
        false,
        `Runtime logs must not contain the ${label}.`,
      );
      assert.equal(
        auditText.includes(value),
        false,
        `Audit records must not contain the ${label}.`,
      );
    }
    assert.equal(capturedText.includes('OAUTH_PERSISTENCE_SCHEMA_ERROR'), true);
    assert.equal(capturedText.includes('oauth_client'), false);

    originalConsole.log('mcp-server-oauth-client-test: ok');
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
