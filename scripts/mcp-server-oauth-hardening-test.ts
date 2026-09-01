import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { resolveDirectMcpServerConfig } from '../app/lib/mcp/server/config';

const ORIGIN = 'https://notebook.example.test';
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/callback';
const REGISTRATION_LIMIT = 10;

function configureRuntime(dataDir: string): void {
  const environment = process.env as Record<string, string | undefined>;
  environment.DATA = dataDir;
  environment.NODE_ENV = 'test';
  environment.CANVAS_DATABASE_PROVIDER = 'sqlite';
  environment.CANVAS_MCP_DIRECT_ENABLED = 'true';
  environment.CANVAS_INSTANCE_ID = 'mcp-oauth-hardening-test';
  environment.BETTER_AUTH_BASE_URL = ORIGIN;
  environment.BASE_URL = ORIGIN;
  environment.BETTER_AUTH_TRUSTED_ORIGINS = ORIGIN;
  environment.BETTER_AUTH_SECRET = 'mcp-oauth-hardening-test-secret-at-least-32-characters';
  delete environment.DATABASE_URL;
  delete environment.NEXT_PHASE;
}

function registrationRequest(issuer: string, name: string): NextRequest {
  return new NextRequest(`${issuer}/oauth2/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid workspace:list',
    }),
  });
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-oauth-hardening-'));
  configureRuntime(dataDir);

  try {
    const [{ POST }, { openDb }, {
      DIRECT_MCP_UNUSED_DYNAMIC_CLIENT_RETENTION_DAYS,
      pruneUnusedDirectMcpDynamicClients,
    }] = await Promise.all([
      import('../app/api/auth/[...all]/route'),
      import('../app/lib/db'),
      import('../app/lib/mcp/server/oauth-client-maintenance'),
    ]);
    const { issuer, resource } = resolveDirectMcpServerConfig();

    const previousFeatureFlag = process.env.CANVAS_MCP_DIRECT_ENABLED;
    process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
    const disabledRegistration = await POST(registrationRequest(issuer, 'Disabled Registration Test'));
    assert.equal(disabledRegistration.status, 404);
    assert.equal((await disabledRegistration.json() as Record<string, unknown>).error, 'not_found');
    process.env.CANVAS_MCP_DIRECT_ENABLED = previousFeatureFlag;

    for (let index = 0; index < REGISTRATION_LIMIT; index += 1) {
      const response = await POST(registrationRequest(issuer, `Rate Limit Test ${index}`));
      assert.equal([200, 201].includes(response.status), true);
    }

    const rateLimited = await POST(registrationRequest(issuer, 'Rate Limit Test Blocked'));
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.headers.get('retry-after'), '60');
    const rateLimitedBody = await rateLimited.json() as Record<string, unknown>;
    assert.equal(rateLimitedBody.error, 'temporarily_unavailable');
    assert.equal(JSON.stringify(rateLimitedBody).includes('Rate Limit Test Blocked'), false);

    const database = await openDb();
    try {
      const now = Date.now();
      const staleCreatedAt = now - ((DIRECT_MCP_UNUSED_DYNAMIC_CLIENT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
      const staleClientId = `stale-direct-mcp-${randomUUID()}`;
      const consentClientId = `consent-direct-mcp-${randomUUID()}`;
      const tokenClientId = `token-direct-mcp-${randomUUID()}`;

      for (const clientId of [staleClientId, consentClientId, tokenClientId]) {
        await database.run(`
          INSERT INTO oauth_client (
            id, client_id, client_secret, user_id, created_at, updated_at,
            redirect_uris, token_endpoint_auth_method, public, require_pkce
          ) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'none', NULL, TRUE)
        `, [
          `client-${randomUUID()}`,
          clientId,
          staleCreatedAt,
          staleCreatedAt,
          JSON.stringify([REDIRECT_URI]),
        ]);
        await database.run(`
          INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
          VALUES (?, ?, ?, ?)
        `, [`resource-${randomUUID()}`, clientId, resource, staleCreatedAt]);
      }
      await database.run(`
        INSERT INTO oauth_consent (id, client_id, scopes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `, [
        `consent-${randomUUID()}`,
        consentClientId,
        JSON.stringify(['workspace:list']),
        staleCreatedAt,
        staleCreatedAt,
      ]);
      await database.run(`
        INSERT INTO oauth_access_token (id, token, client_id, expires_at, created_at, scopes)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        `access-token-${randomUUID()}`,
        `token-${randomUUID()}`,
        tokenClientId,
        now + (60 * 60 * 1000),
        staleCreatedAt,
        JSON.stringify(['workspace:list']),
      ]);

      const pruned = await pruneUnusedDirectMcpDynamicClients(now);
      assert.equal(pruned >= 1, true);
      const staleClient = await database.get(
        'SELECT client_id FROM oauth_client WHERE client_id = ?',
        [staleClientId],
      );
      const consentClient = await database.get(
        'SELECT client_id FROM oauth_client WHERE client_id = ?',
        [consentClientId],
      );
      const tokenClient = await database.get(
        'SELECT client_id FROM oauth_client WHERE client_id = ?',
        [tokenClientId],
      );
      assert.equal(staleClient, undefined);
      assert.equal((consentClient as { client_id?: string } | undefined)?.client_id, consentClientId);
      assert.equal((tokenClient as { client_id?: string } | undefined)?.client_id, tokenClientId);

      const auditRows = await database.all(`
        SELECT status, metadata_json AS metadataJson, summary
        FROM audit_events
        WHERE source = 'direct_mcp'
          AND action = 'direct_mcp.dynamic_client_registration'
        ORDER BY created_at ASC
      `) as Array<{ status: string; metadataJson: string | null; summary: string | null }>;
      assert.equal(auditRows.length, REGISTRATION_LIMIT + 2);
      assert.equal(auditRows.at(-1)?.status, 'blocked');
      for (const auditRow of auditRows) {
        const metadata = JSON.parse(auditRow.metadataJson ?? '{}') as Record<string, unknown>;
        assert.deepEqual(Object.keys(metadata).sort(), ['endpoint', 'rateLimited', 'statusCode']);
        assert.equal(metadata.endpoint, '/api/auth/oauth2/register');
        assert.equal(typeof metadata.statusCode, 'number');
        assert.equal(metadata.rateLimited, metadata.statusCode === 429);
        assert.match(auditRow.summary ?? '', /^Direct MCP OAuth client registration returned HTTP \d{3}\.$/u);
      }
    } finally {
      await database.close();
    }

    console.log('mcp-server-oauth-hardening-test: ok');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
