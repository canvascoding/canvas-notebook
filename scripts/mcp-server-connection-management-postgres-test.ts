import assert from 'node:assert/strict';
import Module from 'node:module';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';

const NOW = Date.now();
const RESOURCE = 'https://notebook.example.test/mcp';
const CLIENT = 'shared-direct-client';
const OWNER = 'connection-owner';
const OTHER = 'other-owner';

type Queryable = {
  get(sql: string, params?: unknown[]): Promise<unknown>;
  all(sql: string, params?: unknown[]): Promise<unknown[]>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
};

async function main(): Promise<void> {
  const priorEnvironment = {
    BASE_URL: process.env.BASE_URL,
    BETTER_AUTH_BASE_URL: process.env.BETTER_AUTH_BASE_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  };
  process.env.BASE_URL = 'https://notebook.example.test';
  process.env.BETTER_AUTH_BASE_URL = 'https://notebook.example.test';
  process.env.BETTER_AUTH_SECRET = 'connection-management-postgres-test-secret-32-chars';

  const postgres = new PGlite();
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  let seatDenied = false;
  let workspaceDenied = false;
  class MockSeatLimitGuardError extends Error {}
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const database: Queryable = {
      async get(sql, params = []) { return (await postgres.query(sql, params)).rows[0]; },
      async all(sql, params = []) { return (await postgres.query(sql, params)).rows; },
      async run(sql, params = []) { return postgres.query(sql, params); },
      async close() {},
    };
    const grantFor = (userId: string, sessionId: string, hash: string) => ({
      lastSuccessfulRequestAt: new Date(NOW - 1_000).toISOString(),
      grants: [{
        sessionId, tokenHash: hash, issuedAt: Math.floor((NOW - 2_000) / 1000),
        expiresAt: Math.floor((NOW + 60_000) / 1000), observedAt: new Date(NOW - 1_000).toISOString(),
        scopes: ['workspace:list'],
      }],
    });
    moduleInternals._load = (request, parent, isMain) => {
      if (request === '@/app/lib/db') return { openDb: async () => database };
      if (request === '@/app/lib/license/seat-limit') {
        return {
          assertUserSeatAccess: async () => {
            if (seatDenied) throw new MockSeatLimitGuardError('seat denied');
          },
          SeatLimitGuardError: MockSeatLimitGuardError,
        };
      }
      if (request === '@/app/lib/mcp/server/workspace-access-policy') {
        return {
          listDirectMcpSelectableWorkspaces: async (userId: string) => (
            workspaceDenied && userId === OWNER ? [] : [{ workspaceId: `${userId}-workspace` }]
          ),
        };
      }
      if (request === '@/app/lib/mcp/server/connection-usage') {
        return {
          readDirectMcpConnectionUsage: async (userId: string) => userId === OWNER
            ? grantFor(OWNER, 'owner-session', 'o'.repeat(43))
            : grantFor(OTHER, 'other-session', 't'.repeat(43)),
        };
      }
      return originalLoad(request, parent, isMain);
    };

    await postgres.exec(`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES
        ('${OWNER}', 'Owner', 'owner@example.test', 1, ${NOW - 10_000}, ${NOW - 10_000}),
        ('${OTHER}', 'Other', 'other@example.test', 1, ${NOW - 10_000}, ${NOW - 10_000});
      INSERT INTO "session" (id, token, user_id, expires_at, created_at, updated_at)
      VALUES
        ('owner-session', 'owner-session-token', '${OWNER}', ${NOW + 120_000}, ${NOW - 10_000}, ${NOW - 10_000}),
        ('other-session', 'other-session-token', '${OTHER}', ${NOW + 120_000}, ${NOW - 10_000}, ${NOW - 10_000});
      INSERT INTO oauth_resource (id, identifier, name, allowed_scopes, disabled)
      VALUES ('resource', '${RESOURCE}', 'Direct MCP', '["workspace:list"]', 0);
      INSERT INTO oauth_client (id, client_id, redirect_uris, token_endpoint_auth_method, name, disabled)
      VALUES ('client', '${CLIENT}', '[]', 'none', 'Shared Client', 0);
      INSERT INTO oauth_client_resource (id, client_id, resource_id)
      VALUES ('client-resource', '${CLIENT}', '${RESOURCE}');
      INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
      VALUES
        ('owner-consent', '${CLIENT}', '${OWNER}', '["openid","workspace:list"]', ${NOW - 5_000}, ${NOW - 5_000}),
        ('other-consent', '${CLIENT}', '${OTHER}', '["openid","workspace:list"]', ${NOW - 5_000}, ${NOW - 5_000});
      INSERT INTO mcp_direct_workspace_grant (client_id, user_id, workspace_id, created_at, updated_at)
      VALUES
        ('${CLIENT}', '${OWNER}', '${OWNER}-workspace', ${NOW - 5_000}, ${NOW - 5_000}),
        ('${CLIENT}', '${OTHER}', '${OTHER}-workspace', ${NOW - 5_000}, ${NOW - 5_000});
      INSERT INTO oauth_refresh_token (id, token, client_id, session_id, user_id, resources, expires_at, created_at, scopes)
      VALUES
        ('owner-refresh', 'owner-refresh-hash', '${CLIENT}', 'owner-session', '${OWNER}', '["${RESOURCE}"]', ${NOW + 120_000}, ${NOW - 2_000}, '["workspace:list"]'),
        ('other-refresh', 'other-refresh-hash', '${CLIENT}', 'other-session', '${OTHER}', '["${RESOURCE}"]', ${NOW + 120_000}, ${NOW - 2_000}, '["workspace:list"]');
    `);

    const { listDirectMcpConnections, disconnectDirectMcpConnection } = await import('../app/lib/mcp/server/connection-management');
    const ownerConnections = await listDirectMcpConnections(OWNER);
    const otherConnections = await listDirectMcpConnections(OTHER);
    assert.equal(ownerConnections.length, 1);
    assert.equal(otherConnections.length, 1);
    assert.equal(ownerConnections[0]?.authorizationStatus, 'usable');
    assert.equal(otherConnections[0]?.authorizationStatus, 'usable');
    assert.equal(ownerConnections[0]?.usableGrantCount, 2, 'current access and refresh grants are independently usable evidence');
    assert.notEqual(ownerConnections[0]?.connectionId, otherConnections[0]?.connectionId, 'signed references remain owner-bound');

    await postgres.query('UPDATE "session" SET expires_at = $1 WHERE id = $2', [NOW - 1, 'owner-session']);
    assert.equal((await listDirectMcpConnections(OWNER))[0]?.authorizationStatus, 'expired');
    await postgres.query('UPDATE "session" SET expires_at = $1 WHERE id = $2', [NOW + 120_000, 'owner-session']);
    await postgres.query(`
      INSERT INTO mcp_direct_grant_revocation (client_id, session_id, user_id, revoked_at)
      VALUES ($1, $2, $3, $4)
    `, [CLIENT, 'owner-session', OWNER, NOW - 500]);
    assert.equal((await listDirectMcpConnections(OWNER))[0]?.authorizationStatus, 'revoked');
    await postgres.query('DELETE FROM mcp_direct_grant_revocation WHERE user_id = $1', [OWNER]);
    await postgres.query('UPDATE "user" SET banned = 1 WHERE id = $1', [OWNER]);
    assert.equal((await listDirectMcpConnections(OWNER))[0]?.authorizationStatus, 'access_denied');
    await postgres.query('UPDATE "user" SET banned = 0 WHERE id = $1', [OWNER]);
    seatDenied = true;
    assert.equal((await listDirectMcpConnections(OWNER))[0]?.authorizationStatus, 'access_denied');
    seatDenied = false;
    workspaceDenied = true;
    assert.equal((await listDirectMcpConnections(OWNER))[0]?.authorizationStatus, 'access_denied');
    workspaceDenied = false;

    assert.deepEqual(await disconnectDirectMcpConnection(OTHER, ownerConnections[0]!.connectionId), { status: 'not_found' });
    assert.equal((await postgres.query('SELECT * FROM oauth_consent WHERE user_id = $1', [OWNER])).rows.length, 1);
    assert.deepEqual(await disconnectDirectMcpConnection(OWNER, ownerConnections[0]!.connectionId), { status: 'disconnected' });
    assert.equal((await postgres.query('SELECT * FROM oauth_consent WHERE user_id = $1', [OWNER])).rows.length, 0);
    assert.equal((await postgres.query('SELECT * FROM mcp_direct_workspace_grant WHERE user_id = $1', [OWNER])).rows.length, 0);
    const ownerRefreshRows = await postgres.query<{ revoked: unknown }>(
      'SELECT revoked FROM oauth_refresh_token WHERE user_id = $1', [OWNER],
    );
    assert.equal(ownerRefreshRows.rows[0]?.revoked == null, false);
    assert.equal((await listDirectMcpConnections(OWNER)).length, 0);
    const remainingOther = await listDirectMcpConnections(OTHER);
    assert.equal(remainingOther.length, 1);
    assert.equal(remainingOther[0]?.authorizationStatus, 'usable');
  } finally {
    moduleInternals._load = originalLoad;
    await postgres.close();
    for (const [key, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log('mcp-server-connection-management-postgres-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
