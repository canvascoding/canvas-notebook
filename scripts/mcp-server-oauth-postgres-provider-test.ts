import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';
import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import * as schema from '../app/lib/db/schema';
import { DIRECT_MCP_OAUTH_SCOPES } from '../app/lib/mcp/server/config';

const ORIGIN = 'https://notebook.example.test';
const ISSUER = `${ORIGIN}/api/auth`;
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/callback';

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await runPostgresMigrations(
      postgres as unknown as Parameters<typeof runPostgresMigrations>[0],
    );
    const database = drizzle(postgres, { schema });
    const auth = betterAuth({
      secret: 'mcp-oauth-postgres-provider-test-secret-at-least-32-characters',
      baseURL: ORIGIN,
      database: drizzleAdapter(database, { provider: 'pg' }),
      plugins: [
        jwt({ jwt: { issuer: ISSUER } }),
        oauthProvider({
          loginPage: '/login',
          consentPage: '/oauth/consent',
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
          allowPublicClientPrelogin: false,
          grantTypes: ['authorization_code', 'refresh_token'],
          scopes: [...DIRECT_MCP_OAUTH_SCOPES],
          clientRegistrationDefaultScopes: ['openid'],
          clientRegistrationAllowedScopes: [...DIRECT_MCP_OAUTH_SCOPES],
          resources: [{
            identifier: RESOURCE,
            name: 'Canvas Notebook MCP',
            allowedScopes: [...DIRECT_MCP_OAUTH_SCOPES],
          }],
          clientRegistrationDefaultResources: [RESOURCE],
          clientRegistrationAllowedResources: [RESOURCE],
          storeClientSecret: 'hashed',
          storeTokens: 'hashed',
          clientPrivileges: () => false,
        }),
      ],
    });

    const response = await auth.handler(new Request(`${ISSUER}/oauth2/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        client_name: 'ChatGPT PostgreSQL Dynamic Client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: DIRECT_MCP_OAUTH_SCOPES.join(' '),
      }),
    }));
    assert.equal(response.status, 201);
    const registered = await response.json() as Record<string, unknown>;
    assert.equal(registered.token_endpoint_auth_method, 'none');
    assert.equal('client_secret' in registered, false);
    assert.equal(typeof registered.client_id, 'string');

    const clientId = String(registered.client_id);
    const storedClient = await postgres.query<{
      client_secret: string | null;
      token_endpoint_auth_method: string | null;
    }>(`
      SELECT client_secret, token_endpoint_auth_method
      FROM oauth_client
      WHERE client_id = $1
    `, [clientId]);
    assert.equal(storedClient.rows.length, 1);
    assert.equal(storedClient.rows[0]?.client_secret, null);
    assert.equal(storedClient.rows[0]?.token_endpoint_auth_method, 'none');

    const clientResources = await postgres.query<{ resource_id: string }>(`
      SELECT client_id AS resource_id
      FROM oauth_client_resource
      WHERE client_id = $1
    `, [clientId]);
    assert.equal(clientResources.rows.length, 1);
  } finally {
    await postgres.close();
  }
}

main().then(() => {
  console.log('mcp-server-oauth-postgres-provider-test: ok');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
