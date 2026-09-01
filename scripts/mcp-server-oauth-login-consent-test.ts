import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import {
  DIRECT_MCP_OAUTH_SCOPES,
  resolveDirectMcpServerConfig,
} from '../app/lib/mcp/server/config';

const ORIGIN = 'https://notebook.example.test';
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/callback';
const EMAIL = 'oauth-owner@example.test';
const PASSWORD = 'OAuthOwnerPassword123!';

function configureRuntime(dataDir: string): void {
  const environment = process.env as Record<string, string | undefined>;
  environment.DATA = dataDir;
  environment.NODE_ENV = 'test';
  environment.CANVAS_DATABASE_PROVIDER = 'sqlite';
  environment.CANVAS_MCP_DIRECT_ENABLED = 'true';
  environment.CANVAS_INSTANCE_ID = 'mcp-oauth-login-consent-test';
  environment.BETTER_AUTH_BASE_URL = ORIGIN;
  environment.BASE_URL = ORIGIN;
  environment.BETTER_AUTH_TRUSTED_ORIGINS = ORIGIN;
  environment.BETTER_AUTH_SECRET = 'mcp-oauth-login-consent-test-secret-at-least-32-characters';
  delete environment.DATABASE_URL;
  delete environment.NEXT_PHASE;
}

function toPageSearchParams(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

function readRedirect(data: unknown): string {
  assert.equal(typeof data, 'object');
  assert.notEqual(data, null);
  const record = data as Record<string, unknown>;
  assert.equal(record.redirect, true);
  assert.equal(typeof record.url, 'string');
  assert.ok(record.url);
  return String(record.url);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json();
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function readSessionCookie(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  const sessionCookie = setCookies.find((value) => value.includes('session_token='));
  assert.ok(sessionCookie, 'Expected Better Auth to set a session cookie.');
  return sessionCookie.split(';', 1)[0];
}

function readStoredStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  const normalized = typeof parsed === 'string'
    ? JSON.parse(parsed) as unknown
    : parsed;
  assert.equal(Array.isArray(normalized), true);
  return normalized as string[];
}

function authorizationUrl(
  clientId: string,
  resource: string,
  prompt?: 'consent',
): URL {
  const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', DIRECT_MCP_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', `state-${prompt ?? 'login'}`);
  url.searchParams.set('resource', resource);
  url.searchParams.set(
    'code_challenge',
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_',
  );
  url.searchParams.set('code_challenge_method', 'S256');
  if (prompt) url.searchParams.set('prompt', prompt);
  return url;
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-oauth-consent-'));
  configureRuntime(dataDir);

  try {
    const { createInitialOwner } = await import('../app/lib/auth-setup');
    const owner = await createInitialOwner({
      name: 'OAuth Owner',
      email: EMAIL,
      password: PASSWORD,
    });

    const [
      { auth },
      { enforceDirectMcpOAuthRequestPolicy },
      { POST: completeConsentRedirect },
      { completeDirectMcpOAuthConsentRedirect },
      {
        resolveDirectMcpConsentPresentation,
        verifyOAuthPageQuery,
      },
      { POST: postAuthRoute },
    ] = await Promise.all([
      import('../app/lib/auth'),
      import('../app/lib/mcp/server/oauth-request-policy'),
      import('../app/api/auth/oauth2/consent/redirect/route'),
      import('../app/lib/mcp/server/oauth-consent-redirect'),
      import('../app/lib/mcp/server/oauth-page-query'),
      import('../app/api/auth/[...all]/route'),
    ]);
    const { issuer, resource } = resolveDirectMcpServerConfig();
    const [
      { loadWorkspaceListingForActor },
      { resolveWorkspaceActor },
      {
        listDirectMcpAllowedWorkspaceIds,
        setDirectMcpWorkspaceEnabled,
      },
    ] = await Promise.all([
      import('../app/lib/workspaces/listing-action'),
      import('../app/lib/workspaces/context'),
      import('../app/lib/mcp/server/workspace-access-policy'),
    ]);
    const workspaceListing = await loadWorkspaceListingForActor(resolveWorkspaceActor({
      id: owner.id,
      email: EMAIL,
      role: 'admin',
    }));
    assert.ok(workspaceListing.defaultWorkspace);
    const workspaceId = workspaceListing.defaultWorkspace.workspaceId;
    assert.deepEqual(await setDirectMcpWorkspaceEnabled({
      userId: owner.id,
      workspaceId,
      enabled: true,
    }), { status: 'updated', enabled: true });

    async function dispatch(request: Request): Promise<Response> {
      return (await enforceDirectMcpOAuthRequestPolicy(request))
        ?? auth.handler(request);
    }

    const registrationRequest = new Request(`${issuer}/oauth2/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        client_name: 'ChatGPT OAuth UI Test',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: DIRECT_MCP_OAUTH_SCOPES.join(' '),
      }),
    });
    const registrationResponse = await dispatch(registrationRequest);
    assert.equal([200, 201].includes(registrationResponse.status), true);
    const registration = await readJson(registrationResponse);
    const clientId = String(registration.client_id);
    assert.ok(clientId);

    const normalLogin = await dispatch(new Request(`${issuer}/sign-in/email`, {
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
    assert.equal(normalLogin.status, 200);
    const normalLoginData = await readJson(normalLogin);
    assert.equal(normalLoginData.redirect, false);
    assert.equal(typeof normalLoginData.token, 'string');

    const initialAuthorize = await dispatch(new Request(
      authorizationUrl(clientId, resource),
    ));
    assert.equal(initialAuthorize.status, 302);
    const loginLocation = new URL(
      initialAuthorize.headers.get('location') || '',
      ORIGIN,
    );
    assert.equal(loginLocation.pathname, '/login');
    const loginOAuthQuery = loginLocation.searchParams.toString();
    assert.ok(loginOAuthQuery.includes('sig='));

    const verifiedLoginQuery = await verifyOAuthPageQuery(
      toPageSearchParams(loginLocation),
    );
    assert.ok(verifiedLoginQuery);
    assert.equal(verifiedLoginQuery.clientId, clientId);

    const oauthLogin = await dispatch(new Request(`${issuer}/sign-in/email`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD,
        oauth_query: loginOAuthQuery,
      }),
    }));
    assert.equal(oauthLogin.status, 200);
    const oauthCookie = readSessionCookie(oauthLogin);
    const consentLocation = new URL(
      readRedirect(await readJson(oauthLogin)),
      ORIGIN,
    );
    assert.equal(consentLocation.pathname, '/oauth/consent');

    const verifiedConsentQuery = await verifyOAuthPageQuery(
      toPageSearchParams(consentLocation),
    );
    assert.ok(verifiedConsentQuery, 'The Better Auth consent query must verify.');
    assert.equal(verifiedConsentQuery.clientId, clientId);

    const { openDb } = await import('../app/lib/db');
    const inspectionDatabase = await openDb();
    try {
      const storedClient = await inspectionDatabase.get(
        `
          SELECT
            disabled,
            public,
            token_endpoint_auth_method AS tokenEndpointAuthMethod,
            scopes
          FROM oauth_client
          WHERE client_id = ?
        `,
        [clientId],
      ) as {
        disabled: number;
        public: number | null;
        tokenEndpointAuthMethod: string;
        scopes: string;
      };
      assert.deepEqual(
        {
          disabled: storedClient.disabled,
          public: storedClient.public,
          tokenEndpointAuthMethod: storedClient.tokenEndpointAuthMethod,
          scopes: readStoredStringArray(storedClient.scopes),
        },
        {
          disabled: 0,
          public: null,
          tokenEndpointAuthMethod: 'none',
          scopes: [...DIRECT_MCP_OAUTH_SCOPES],
        },
      );
    } finally {
      await inspectionDatabase.close();
    }

    const consentPresentation = await resolveDirectMcpConsentPresentation(
      toPageSearchParams(consentLocation),
    );
    assert.ok(consentPresentation);
    assert.equal(consentPresentation.clientName, 'ChatGPT OAuth UI Test');
    assert.equal(consentPresentation.instanceHost, 'notebook.example.test');
    assert.deepEqual(
      consentPresentation.scopes,
      [...DIRECT_MCP_OAUTH_SCOPES],
    );

    const manipulatedParams = toPageSearchParams(consentLocation);
    manipulatedParams.client_id = `${clientId}tampered`;
    assert.equal(await verifyOAuthPageQuery(manipulatedParams), null);
    assert.equal(
      await verifyOAuthPageQuery(
        toPageSearchParams(consentLocation),
        Date.now() + 10 * 60 * 1_000,
      ),
      null,
    );

    const denyResponse = await dispatch(new Request(`${issuer}/oauth2/consent`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: oauthCookie,
        origin: ORIGIN,
      },
      body: JSON.stringify({
        accept: false,
        oauth_query: consentLocation.searchParams.toString(),
      }),
    }));
    assert.equal(denyResponse.status, 200);
    const deniedRedirect = new URL(
      readRedirect(await readJson(denyResponse)),
      ORIGIN,
    );
    assert.equal(deniedRedirect.origin + deniedRedirect.pathname, REDIRECT_URI);
    assert.equal(deniedRedirect.searchParams.get('error'), 'access_denied');
    assert.equal(deniedRedirect.searchParams.get('state'), 'state-login');

    const consentAuthorize = await dispatch(new Request(
      authorizationUrl(clientId, resource, 'consent'),
      {
        headers: {
          cookie: oauthCookie,
        },
      },
    ));
    assert.equal(consentAuthorize.status, 302);
    const secondConsentLocation = new URL(
      consentAuthorize.headers.get('location') || '',
      ORIGIN,
    );
    assert.equal(secondConsentLocation.pathname, '/oauth/consent');

    const invalidOriginForm = new URLSearchParams({
      accept: 'true',
      oauth_query: secondConsentLocation.searchParams.toString(),
    });
    const invalidOriginResponse = await completeConsentRedirect(
      new Request(`${ORIGIN}/api/auth/oauth2/consent/redirect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: oauthCookie,
          origin: 'https://attacker.example.test',
        },
        body: invalidOriginForm,
      }),
    );
    assert.equal(invalidOriginResponse.status, 403);
    assert.ok(invalidOriginResponse.headers.get('x-request-id'));

    const acceptForm = new URLSearchParams({
      accept: 'true',
      oauth_query: secondConsentLocation.searchParams.toString(),
    });
    const consentIssuedAt = Number(
      secondConsentLocation.searchParams.get('ba_iat'),
    );
    assert.equal(Number.isFinite(consentIssuedAt), true);
    const delayedAcceptResponse = await completeDirectMcpOAuthConsentRedirect(
      new Request(`${ORIGIN}/api/auth/oauth2/consent/redirect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: oauthCookie,
          origin: ORIGIN,
        },
        body: acceptForm,
      }),
      auth.handler,
      consentIssuedAt + 10 * 60 * 1_000,
    );
    assert.equal(delayedAcceptResponse.status, 303);
    assert.ok(new URL(
      delayedAcceptResponse.headers.get('location') || '',
      ORIGIN,
    ).searchParams.get('code'));

    const staleAcceptResponse = await completeDirectMcpOAuthConsentRedirect(
      new Request(`${ORIGIN}/api/auth/oauth2/consent/redirect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: oauthCookie,
          origin: ORIGIN,
        },
        body: acceptForm,
      }),
      auth.handler,
      consentIssuedAt + 61 * 60 * 1_000,
    );
    assert.equal(staleAcceptResponse.status, 400);
    assert.equal((await readJson(staleAcceptResponse)).error, 'invalid_request');

    const acceptResponse = await postAuthRoute(new NextRequest(`${issuer}/oauth2/consent`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: oauthCookie,
        origin: ORIGIN,
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: secondConsentLocation.searchParams.toString(),
      }),
    }));
    assert.equal(acceptResponse.status, 200);
    const acceptedRedirect = new URL(
      readRedirect(await readJson(acceptResponse)),
      ORIGIN,
    );
    assert.equal(acceptedRedirect.origin + acceptedRedirect.pathname, REDIRECT_URI);
    assert.ok(acceptedRedirect.searchParams.get('code'));
    assert.equal(acceptedRedirect.searchParams.get('state'), 'state-consent');
    assert.equal(acceptedRedirect.searchParams.get('iss'), issuer);
    assert.deepEqual(
      [...await listDirectMcpAllowedWorkspaceIds({ clientId, userId: owner.id })],
      [workspaceId],
    );

    const tamperedConsent = await dispatch(new Request(`${issuer}/oauth2/consent`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: oauthCookie,
        origin: ORIGIN,
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: `${secondConsentLocation.searchParams.toString()}tampered`,
      }),
    }));
    assert.equal(tamperedConsent.status, 400);
    assert.equal((await readJson(tamperedConsent)).error, 'invalid_signature');

    console.log('mcp-server-oauth-login-consent-test: ok');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
