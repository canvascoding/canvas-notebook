import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DIRECT_MCP_OAUTH_SCOPES,
  DIRECT_MCP_RESOURCE_SCOPES,
  resolveDirectMcpServerConfig,
} from '../app/lib/mcp/server/config';

const ORIGIN = 'https://notebook.example.test';
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/callback';
const EMAIL = 'oauth-resource-owner@example.test';
const PASSWORD = 'OAuthResourceOwnerPassword123!';
const CODE_VERIFIER = 'canvas-notebook-direct-mcp-pkce-verifier-0123456789-._~';
const REQUESTED_SCOPES = [
  'openid',
  'offline_access',
  'workspace:list',
  'knowledge:read',
];

type AuthHandler = {
  handler: (request: Request) => Promise<Response>;
  api: {
    signJWT: (input: {
      body: {
        payload: Record<string, unknown>;
      };
    }) => Promise<{ token: string }>;
  };
};

function configureRuntime(dataDir: string): void {
  const environment = process.env as Record<string, string | undefined>;
  environment.DATA = dataDir;
  environment.NODE_ENV = 'test';
  environment.CANVAS_DATABASE_PROVIDER = 'sqlite';
  environment.CANVAS_MCP_DIRECT_ENABLED = 'true';
  environment.CANVAS_INSTANCE_ID = 'mcp-protected-resource-test';
  environment.BETTER_AUTH_BASE_URL = ORIGIN;
  environment.BASE_URL = ORIGIN;
  environment.BETTER_AUTH_TRUSTED_ORIGINS = ORIGIN;
  environment.BETTER_AUTH_SECRET = 'mcp-resource-test-secret-at-least-32-characters';
  delete environment.DATABASE_URL;
  delete environment.NEXT_PHASE;
}

function readSessionCookie(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  const sessionCookie = setCookies.find((value) => value.includes('session_token='));
  assert.ok(sessionCookie, 'Expected Better Auth to set a session cookie.');
  return sessionCookie.split(';', 1)[0];
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json();
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function readRedirect(data: Record<string, unknown>): URL {
  assert.equal(data.redirect, true);
  assert.equal(typeof data.url, 'string');
  return new URL(String(data.url), ORIGIN);
}

function authorizationUrl(clientId: string, resource: string): URL {
  const challenge = createHash('sha256')
    .update(CODE_VERIFIER)
    .digest('base64url');
  const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', REQUESTED_SCOPES.join(' '));
  url.searchParams.set('state', 'protected-resource-test-state');
  url.searchParams.set('resource', resource);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent');
  return url;
}

async function assertAuthorizationError(
  action: () => Promise<unknown>,
  expected: {
    status: number;
    code: string;
    challengeIncludes?: string[];
  },
): Promise<void> {
  const { DirectMcpAuthorizationError } = await import(
    '../app/lib/mcp/server/access-token-verifier'
  );
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof DirectMcpAuthorizationError);
    assert.equal(error.status, expected.status);
    assert.equal(error.code, expected.code);
    for (const fragment of expected.challengeIncludes ?? []) {
      assert.ok(error.challenge?.includes(fragment), `Missing challenge fragment: ${fragment}`);
    }
    return true;
  });
}

async function issueTokenSet(
  auth: AuthHandler,
  dispatch: (request: Request) => Promise<Response>,
  issuer: string,
  resource: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  clientId: string;
}> {
  const registrationResponse = await dispatch(new Request(`${issuer}/oauth2/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify({
      client_name: 'ChatGPT Protected Resource Test',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: DIRECT_MCP_OAUTH_SCOPES.join(' '),
    }),
  }));
  assert.equal([200, 201].includes(registrationResponse.status), true);
  const clientId = String((await readJson(registrationResponse)).client_id);
  assert.ok(clientId);

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

  const authorizeResponse = await dispatch(new Request(
    authorizationUrl(clientId, resource),
    {
      headers: {
        cookie: sessionCookie,
      },
    },
  ));
  assert.equal(authorizeResponse.status, 302);
  const consentUrl = new URL(authorizeResponse.headers.get('location') || '', ORIGIN);
  assert.equal(consentUrl.pathname, '/oauth/consent');

  const consentResponse = await dispatch(new Request(`${issuer}/oauth2/consent`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: sessionCookie,
      origin: ORIGIN,
    },
    body: JSON.stringify({
      accept: true,
      oauth_query: consentUrl.searchParams.toString(),
    }),
  }));
  assert.equal(consentResponse.status, 200);
  const callbackUrl = readRedirect(await readJson(consentResponse));
  const code = callbackUrl.searchParams.get('code');
  assert.ok(code);

  const tokenResponse = await dispatch(new Request(`${issuer}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: CODE_VERIFIER,
      redirect_uri: REDIRECT_URI,
      resource,
    }),
  }));
  assert.equal(tokenResponse.status, 200);
  const tokenSet = await readJson(tokenResponse);
  assert.equal(typeof tokenSet.access_token, 'string');
  assert.equal(typeof tokenSet.refresh_token, 'string');
  return {
    accessToken: String(tokenSet.access_token),
    refreshToken: String(tokenSet.refresh_token),
    clientId,
  };
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-resource-'));
  configureRuntime(dataDir);

  try {
    const { createInitialOwner } = await import('../app/lib/auth-setup');
    await createInitialOwner({
      name: 'OAuth Resource Owner',
      email: EMAIL,
      password: PASSWORD,
    });

    const [
      { auth },
      { enforceDirectMcpOAuthRequestPolicy },
      {
        DirectMcpAuthorizationError,
        verifyDirectMcpAccessToken,
        verifyDirectMcpRequest,
      },
      {
        getDirectMcpProtectedResourceMetadata,
        directMcpProtectedResourceMetadataResponse,
      },
      {
        applyDirectMcpRevocation,
        prepareDirectMcpRevocation,
      },
      canonicalMetadataRoute,
      aliasMetadataRoute,
    ] = await Promise.all([
      import('../app/lib/auth'),
      import('../app/lib/mcp/server/oauth-request-policy'),
      import('../app/lib/mcp/server/access-token-verifier'),
      import('../app/lib/mcp/server/protected-resource-metadata'),
      import('../app/lib/mcp/server/oauth-grant-revocation'),
      import('../app/.well-known/oauth-protected-resource/mcp/route'),
      import('../app/.well-known/oauth-protected-resource/route'),
    ]);
    const { issuer, resource, protectedResourceMetadataUrl } =
      resolveDirectMcpServerConfig();

    async function dispatch(request: Request): Promise<Response> {
      return (await enforceDirectMcpOAuthRequestPolicy(request))
        ?? auth.handler(request);
    }

    const expectedMetadata = {
      resource,
      authorization_servers: [issuer],
      scopes_supported: [...DIRECT_MCP_RESOURCE_SCOPES],
      bearer_methods_supported: ['header'],
    };
    assert.deepEqual(await getDirectMcpProtectedResourceMetadata(), expectedMetadata);
    for (const response of await Promise.all([
      directMcpProtectedResourceMetadataResponse(),
      canonicalMetadataRoute.GET(),
      aliasMetadataRoute.GET(),
    ])) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(await readJson(response), expectedMetadata);
    }

    const originalFeatureFlag = process.env.CANVAS_MCP_DIRECT_ENABLED;
    process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
    assert.equal((await directMcpProtectedResourceMetadataResponse()).status, 404);
    process.env.CANVAS_MCP_DIRECT_ENABLED = originalFeatureFlag;

    const tokenSet = await issueTokenSet(
      auth as unknown as AuthHandler,
      dispatch,
      issuer,
      resource,
    );
    const principal = await verifyDirectMcpAccessToken(
      tokenSet.accessToken,
      ['knowledge:read'],
    );
    assert.equal(principal.userId, principal.subject);
    assert.equal(principal.clientId, tokenSet.clientId);
    assert.equal(principal.audience, resource);
    assert.ok(principal.scopes.includes('knowledge:read'));

    const requestPrincipal = await verifyDirectMcpRequest(new Request(`${ORIGIN}/mcp`, {
      headers: {
        authorization: `Bearer ${tokenSet.accessToken}`,
      },
    }), ['workspace:list']);
    assert.equal(requestPrincipal.userId, principal.userId);

    await assertAuthorizationError(
      () => verifyDirectMcpRequest(new Request(`${ORIGIN}/mcp`)),
      {
        status: 401,
        code: 'invalid_token',
        challengeIncludes: [`resource_metadata="${protectedResourceMetadataUrl}"`],
      },
    );
    await assertAuthorizationError(
      () => verifyDirectMcpAccessToken(tokenSet.accessToken, ['knowledge:search']),
      {
        status: 403,
        code: 'insufficient_scope',
        challengeIncludes: [
          'error="insufficient_scope"',
          'scope="knowledge:search"',
        ],
      },
    );

    const now = Math.floor(Date.now() / 1000);
    const baseClaims = {
      sub: principal.userId,
      azp: principal.clientId,
      sid: principal.sessionId,
      scope: REQUESTED_SCOPES.join(' '),
      iat: now,
      exp: now + 900,
    };
    const wrongIssuer = await auth.api.signJWT({
      body: {
        payload: {
          ...baseClaims,
          iss: 'https://foreign-instance.example.test/api/auth',
          aud: resource,
        },
      },
    });
    const wrongResource = await auth.api.signJWT({
      body: {
        payload: {
          ...baseClaims,
          iss: issuer,
          aud: 'https://foreign-instance.example.test/mcp',
        },
      },
    });
    const mixedResource = await auth.api.signJWT({
      body: {
        payload: {
          ...baseClaims,
          iss: issuer,
          aud: [resource, 'https://foreign-instance.example.test/mcp'],
        },
      },
    });
    const expired = await auth.api.signJWT({
      body: {
        payload: {
          ...baseClaims,
          iss: issuer,
          aud: resource,
          iat: now - 1800,
          exp: now - 900,
        },
      },
    });
    const tokenSegments = tokenSet.accessToken.split('.');
    assert.equal(tokenSegments.length, 3);
    const signature = tokenSegments[2];
    tokenSegments[2] = `${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`;
    const tampered = tokenSegments.join('.');
    for (const invalid of [
      wrongIssuer.token,
      wrongResource.token,
      mixedResource.token,
      expired.token,
      tampered,
    ]) {
      await assertAuthorizationError(
        () => verifyDirectMcpAccessToken(invalid, ['knowledge:read']),
        {
          status: 401,
          code: 'invalid_token',
          challengeIncludes: ['error="invalid_token"'],
        },
      );
    }

    const { openDb } = await import('../app/lib/db');
    const statusDatabase = await openDb();
    try {
      await statusDatabase.run(
        'UPDATE "user" SET banned = 1 WHERE id = ?',
        [principal.userId],
      );
    } finally {
      await statusDatabase.close();
    }
    await assertAuthorizationError(
      () => verifyDirectMcpAccessToken(tokenSet.accessToken, ['knowledge:read']),
      {
        status: 401,
        code: 'invalid_token',
      },
    );
    const restoreDatabase = await openDb();
    try {
      await restoreDatabase.run(
        'UPDATE "user" SET banned = 0 WHERE id = ?',
        [principal.userId],
      );
    } finally {
      await restoreDatabase.close();
    }

    const revokeRequest = new Request(`${issuer}/oauth2/revoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: ORIGIN,
      },
      body: new URLSearchParams({
        client_id: tokenSet.clientId,
        token: tokenSet.accessToken,
        token_type_hint: 'access_token',
      }),
    });
    const revocationCandidate = await prepareDirectMcpRevocation(revokeRequest);
    assert.ok(revocationCandidate);
    const revokeResponse = await auth.handler(revokeRequest);
    assert.equal(revokeResponse.status, 200);
    await applyDirectMcpRevocation(revocationCandidate);
    await assertAuthorizationError(
      () => verifyDirectMcpAccessToken(tokenSet.accessToken, ['knowledge:read']),
      {
        status: 401,
        code: 'invalid_token',
      },
    );

    const refreshAfterRevocation = new Request(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: tokenSet.clientId,
        refresh_token: tokenSet.refreshToken,
        resource,
      }),
    });
    const refreshPolicyResponse = await enforceDirectMcpOAuthRequestPolicy(
      refreshAfterRevocation,
    );
    assert.equal(refreshPolicyResponse?.status, 400);
    assert.equal((await readJson(refreshPolicyResponse!)).error, 'invalid_grant');

    const errorResponse = new DirectMcpAuthorizationError(
      'invalid_token',
      401,
      'Token invalid.',
      { challengeError: 'invalid_token' },
    ).toResponse();
    assert.equal(errorResponse.status, 401);
    assert.equal(
      errorResponse.headers.get('www-authenticate'),
      (
        `Bearer resource_metadata="${protectedResourceMetadataUrl}", `
        + 'error="invalid_token", '
        + 'error_description="The access token is invalid or expired."'
      ),
    );
    assert.equal(errorResponse.headers.get('cache-control'), 'no-store');

    console.log('mcp-server-protected-resource-test: ok');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
