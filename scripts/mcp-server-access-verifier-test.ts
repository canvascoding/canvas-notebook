import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import Module from 'node:module';

import { PGlite } from '@electric-sql/pglite';
import { exportJWK, SignJWT } from 'jose';

const origin = 'https://verifier.fixture.test';
const issuer = `${origin}/api/auth`;
const resource = `${origin}/mcp`;
const userId = 'verifier-user';
const clientId = 'verifier-client';
const sessionId = 'verifier-session';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: invalidPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
const postgres = new PGlite();

class FixtureSeatLimitGuardError extends Error {
  constructor() {
    super('Fixture seat access denied.');
  }
}

let seatAllowed = true;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;

function installMocks(): void {
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request.includes('app/lib/auth')) {
      return {
        auth: {
          api: {
            getJwks: async () => ({
              keys: [{ ...publicJwk, alg: 'RS256', kid: 'verifier-key', use: 'sig' }],
            }),
          },
        },
      };
    }
    if (request.includes('app/lib/db')) {
      return {
        openDb: async () => ({
          get: async (sql: string, params: unknown[]) => {
            const result = await postgres.query(sql, params);
            return result.rows[0];
          },
          close: async () => {},
        }),
      };
    }
    if (request.includes('license/seat-limit')) {
      return {
        SeatLimitGuardError: FixtureSeatLimitGuardError,
        assertUserSeatAccess: async () => {
          if (!seatAllowed) throw new FixtureSeatLimitGuardError();
          return { userId, organizationId: null, mode: 'solo' };
        },
      };
    }
    if (request.includes('mcp/server/config')) {
      return {
        resolveDirectMcpOAuthConfig: () => ({
          issuer,
          resource,
          protectedResourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
        }),
      };
    }
    return originalLoad(request, parent, isMain);
  };
}

async function createSchema(): Promise<void> {
  await postgres.exec(`
    CREATE TABLE "session" (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE "user" (
      id TEXT PRIMARY KEY,
      banned BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE oauth_client (
      client_id TEXT PRIMARY KEY,
      name TEXT,
      disabled BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE oauth_consent (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE mcp_revoked_access_token (
      token_hash TEXT NOT NULL,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL
    );
    CREATE TABLE mcp_direct_grant_revocation (
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL
    );
  `);
}

async function seedActiveGrant(): Promise<void> {
  await postgres.exec(`
    DELETE FROM mcp_revoked_access_token;
    DELETE FROM mcp_direct_grant_revocation;
    DELETE FROM oauth_consent;
    DELETE FROM oauth_client;
    DELETE FROM "session";
    DELETE FROM "user";
  `);
  const now = new Date();
  const consentUpdatedAt = new Date(now.getTime() - 60_000);
  const sessionExpiresAt = new Date(now.getTime() + 3_600_000);
  await postgres.query('INSERT INTO "user" (id, banned) VALUES ($1, $2)', [userId, false]);
  await postgres.query('INSERT INTO "session" (id, user_id, expires_at) VALUES ($1, $2, $3)', [sessionId, userId, sessionExpiresAt]);
  await postgres.query('INSERT INTO oauth_client (client_id, name, disabled) VALUES ($1, $2, $3)', [clientId, 'Verifier fixture client', false]);
  await postgres.query('INSERT INTO oauth_consent (id, client_id, user_id, updated_at, created_at) VALUES ($1, $2, $3, $4, $5)', ['consent-1', clientId, userId, consentUpdatedAt, consentUpdatedAt]);
  seatAllowed = true;
}

async function signToken(options: {
  audience?: string;
  privateSigningKey?: typeof privateKey;
  issuedAt?: number;
  expiresAt?: number;
} = {}): Promise<string> {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000) - 10;
  const expiresAt = options.expiresAt ?? Math.floor(Date.now() / 1000) + 3_600;
  return new SignJWT({
    azp: clientId,
    sid: sessionId,
    scope: 'workspace:list',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'verifier-key' })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(options.audience ?? resource)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(options.privateSigningKey ?? privateKey);
}

async function expectAuthorizationFailure(
  callback: () => Promise<unknown>,
  code: 'invalid_token' | 'insufficient_scope' | 'authorization_unavailable',
  status: 401 | 403 | 503,
): Promise<void> {
  const { DirectMcpAuthorizationError } = await import('../app/lib/mcp/server/access-token-verifier');
  await assert.rejects(callback, (error: unknown) => (
    error instanceof DirectMcpAuthorizationError
    && error.code === code
    && error.status === status
  ));
}

async function main(): Promise<void> {
  installMocks();
  try {
    publicJwk = await exportJWK(publicKey);
    await createSchema();
    const { verifyDirectMcpAccessToken } = await import('../app/lib/mcp/server/access-token-verifier');
    await seedActiveGrant();
    const validToken = await signToken();
    const principal = await verifyDirectMcpAccessToken(validToken, ['workspace:list']);
    assert.equal(principal.userId, userId);
    assert.equal(principal.clientId, clientId);
    assert.equal(principal.sessionId, sessionId);
    assert.equal(principal.clientName, 'Verifier fixture client');

    await seedActiveGrant();
    await expectAuthorizationFailure(
      () => signToken({ privateSigningKey: invalidPrivateKey }).then(verifyDirectMcpAccessToken),
      'invalid_token',
      401,
    );

    await seedActiveGrant();
    await expectAuthorizationFailure(
      () => signToken({ audience: `${origin}/other-resource` }).then(verifyDirectMcpAccessToken),
      'invalid_token',
      401,
    );

    await seedActiveGrant();
    await postgres.query('UPDATE "session" SET expires_at = $1 WHERE id = $2', [new Date(Date.now() - 1_000), sessionId]);
    await expectAuthorizationFailure(() => signToken().then(verifyDirectMcpAccessToken), 'invalid_token', 401);

    await seedActiveGrant();
    const revokedToken = await signToken();
    await postgres.query(
      'INSERT INTO mcp_revoked_access_token (token_hash, client_id, session_id, user_id) VALUES ($1, $2, $3, $4)',
      [createHash('sha256').update(revokedToken).digest('base64url'), clientId, sessionId, userId],
    );
    await expectAuthorizationFailure(() => verifyDirectMcpAccessToken(revokedToken), 'invalid_token', 401);

    await seedActiveGrant();
    const revokedGrantToken = await signToken();
    await postgres.query(
      'INSERT INTO mcp_direct_grant_revocation (client_id, session_id, user_id, revoked_at) VALUES ($1, $2, $3, $4)',
      [clientId, sessionId, userId, new Date(Date.now() + 1_000)],
    );
    await expectAuthorizationFailure(() => verifyDirectMcpAccessToken(revokedGrantToken), 'invalid_token', 401);

    await seedActiveGrant();
    await postgres.exec('DELETE FROM oauth_consent');
    await expectAuthorizationFailure(() => signToken().then(verifyDirectMcpAccessToken), 'invalid_token', 401);

    await seedActiveGrant();
    await postgres.query('UPDATE "user" SET banned = TRUE WHERE id = $1', [userId]);
    await expectAuthorizationFailure(() => signToken().then(verifyDirectMcpAccessToken), 'invalid_token', 401);

    await seedActiveGrant();
    await postgres.query('UPDATE oauth_client SET disabled = TRUE WHERE client_id = $1', [clientId]);
    await expectAuthorizationFailure(() => signToken().then(verifyDirectMcpAccessToken), 'invalid_token', 401);

    await seedActiveGrant();
    seatAllowed = false;
    await expectAuthorizationFailure(() => signToken().then(verifyDirectMcpAccessToken), 'invalid_token', 401);

    await seedActiveGrant();
    await expectAuthorizationFailure(
      () => signToken().then((token) => verifyDirectMcpAccessToken(token, ['knowledge:read'])),
      'insufficient_scope',
      403,
    );
    console.log('mcp-server-access-verifier-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    await postgres.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
