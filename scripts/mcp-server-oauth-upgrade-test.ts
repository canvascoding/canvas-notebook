import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt } from 'better-auth/plugins';
import { drizzle as sqliteDrizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as pgDrizzle } from 'drizzle-orm/pglite';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../app/lib/db/migrate';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import * as schema from '../app/lib/db/schema';
import { DIRECT_MCP_OAUTH_SCOPES } from '../app/lib/mcp/server/config';
import { directMcpOAuthResourceOptions } from '../app/lib/mcp/server/oauth-resource-config';

const ORIGIN = 'https://upgrade.example.test';
const ISSUER = `${ORIGIN}/api/auth`;
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'https://chatgpt.com/connector/oauth/callback';
const VERIFIER = 'canvas-notebook-upgrade-pkce-verifier-0123456789-abcdefghijk';
const OLD_SCOPES = DIRECT_MCP_OAUTH_SCOPES.filter(s => s !== 'knowledge:write' && s !== 'knowledge:assets');
type Handler = { handler(request: Request): Promise<Response> };

async function json(response: Response) {
  const body = await response.json();
  assert.ok(response.ok, `OAuth request failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function post(endpoint: string, body: unknown, cookie?: string) {
  return new Request(`${ISSUER}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function authorize(auth: Handler, clientId: string, cookie: string) {
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    scope: DIRECT_MCP_OAUTH_SCOPES.join(' '), state: 'upgrade-regression', resource: RESOURCE,
    prompt: 'consent', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
  });
  const response = await auth.handler(new Request(`${ISSUER}/oauth2/authorize?${query}`, { headers: { cookie } }));
  assert.equal(response.status, 302);
  const consentUrl = new URL(response.headers.get('location')!, ORIGIN);
  assert.equal(consentUrl.pathname, '/oauth/consent');
  const consent = await json(await auth.handler(post('oauth2/consent', {
    accept: true, oauth_query: consentUrl.searchParams.toString(),
  }, cookie)));
  const code = new URL(consent.url, ORIGIN).searchParams.get('code');
  assert.ok(code);
  return tokenRequest(auth, {
    grant_type: 'authorization_code', client_id: clientId, code,
    redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE,
  });
}

async function tokenRequest(auth: Handler, fields: Record<string, string>) {
  return json(await auth.handler(new Request(`${ISSUER}/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams(fields),
  })));
}

function assertTokenScopes(tokens: { scope: string; access_token: string; refresh_token: string }, scopes: readonly string[]) {
  assert.deepEqual(tokens.scope.split(' '), [...scopes]);
  // Issued by our in-process provider; inspect scope without exposing credentials.
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
  assert.deepEqual(claims.scope.split(' '), [...scopes]);
  assert.ok(tokens.refresh_token);
}

async function exerciseUpgrade(provider: 'sqlite' | 'pg') {
  const sqlite = provider === 'sqlite' ? new BetterSqlite3(':memory:') : null;
  const postgres = provider === 'pg' ? new PGlite() : null;
  try {
    if (sqlite) runMigrations(sqlite);
    if (postgres) await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const database = sqlite ? sqliteDrizzle(sqlite, { schema }) : pgDrizzle(postgres!, { schema });
    const makeAuth = (upgraded: boolean) => betterAuth({
      baseURL: ORIGIN,
      secret: 'isolated-oauth-upgrade-test-secret-at-least-32-characters',
      database: drizzleAdapter(database, { provider }),
      emailAndPassword: { enabled: true },
      plugins: [jwt({ jwt: { issuer: ISSUER } }), oauthProvider({
        loginPage: '/login', consentPage: '/oauth/consent',
        allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,
        grantTypes: ['authorization_code', 'refresh_token'],
        scopes: [...DIRECT_MCP_OAUTH_SCOPES],
        clientRegistrationAllowedScopes: [...DIRECT_MCP_OAUTH_SCOPES],
        clientRegistrationDefaultResources: [RESOURCE], clientRegistrationAllowedResources: [RESOURCE],
        storeTokens: 'hashed', storeClientSecret: 'hashed', clientPrivileges: () => false,
        ...(upgraded ? directMcpOAuthResourceOptions(RESOURCE) : {
          resources: [{ identifier: RESOURCE, name: 'Old Canvas MCP', allowedScopes: [...OLD_SCOPES], accessTokenTtl: 240 }],
        }),
        silenceWarnings: { oauthAuthServerConfig: true },
      })],
    });
    const oldAuth = makeAuth(false);
    const signup = await oldAuth.handler(post('sign-up/email', {
      name: 'Upgrade test', email: 'upgrade@example.test', password: 'IsolatedUpgradePassword123!',
    }));
    await json(signup);
    const cookie = signup.headers.getSetCookie().find(v => v.includes('session_token='))!.split(';')[0];
    const client = await json(await oldAuth.handler(post('oauth2/register', {
      client_name: 'ChatGPT Upgrade Test', redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], scope: DIRECT_MCP_OAUTH_SCOPES.join(' '),
    })));
    const oldTokens = await authorize(oldAuth, client.client_id, cookie);
    assertTokenScopes(oldTokens, OLD_SCOPES);

    // A new process/config on the SAME database must upgrade the resource.
    const upgradedAuth = makeAuth(true);
    const newTokens = await authorize(upgradedAuth, client.client_id, cookie);
    assertTokenScopes(newTokens, DIRECT_MCP_OAUTH_SCOPES);
    assert.equal(newTokens.expires_in, 240, 'Preserve resource policies outside the configured scope catalogue.');
    const refresh = (refreshToken: string) => tokenRequest(upgradedAuth, {
      grant_type: 'refresh_token', client_id: client.client_id, refresh_token: refreshToken, resource: RESOURCE,
    });
    const refreshed = await refresh(newTokens.refresh_token);
    assertTokenScopes(refreshed, DIRECT_MCP_OAUTH_SCOPES);
    assert.notEqual(refreshed.refresh_token, newTokens.refresh_token);
    // Old credentials never gain permissions merely because the policy changed.
    assertTokenScopes(await refresh(oldTokens.refresh_token), OLD_SCOPES);
    const restartedAuth = makeAuth(true);
    assertTokenScopes(await authorize(restartedAuth, client.client_id, cookie), DIRECT_MCP_OAUTH_SCOPES);
    console.log(`mcp-server-oauth-upgrade-test (${provider}): ok`);
  } finally {
    sqlite?.close();
    await postgres?.close();
  }
}

async function main() {
  await exerciseUpgrade('sqlite');
  await exerciseUpgrade('pg');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
