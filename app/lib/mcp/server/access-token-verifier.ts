import 'server-only';

import { createHash } from 'node:crypto';

import type { JSONWebKeySet, JWTPayload } from 'jose';
import { verifyJwsAccessToken } from 'better-auth/oauth2';

import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import {
  assertUserSeatAccess,
  SeatLimitGuardError,
} from '@/app/lib/license/seat-limit';
import {
  type DirectMcpResourceScope,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';

const MAX_BEARER_TOKEN_LENGTH = 16 * 1024;
const localJwksCacheKey = {};

type DirectMcpGrantStateRow = {
  session_id: string;
  session_expires_at: unknown;
  user_id: string;
  user_banned: unknown;
  client_id: string;
  client_disabled: unknown;
  revoked_token_hash: string | null;
  grant_revoked_at: unknown;
};

export type DirectMcpJwtClaims = {
  subject: string;
  clientId: string;
  sessionId: string;
  issuer: string;
  audience: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  payload: JWTPayload;
};

export type DirectMcpAccessPrincipal = DirectMcpJwtClaims & {
  userId: string;
};

export type DirectMcpAuthorizationErrorCode =
  | 'invalid_token'
  | 'insufficient_scope'
  | 'authorization_unavailable';

function escapeChallengeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function buildChallenge(
  error?: Exclude<DirectMcpAuthorizationErrorCode, 'authorization_unavailable'>,
  scope?: string,
): string {
  const config = resolveDirectMcpOAuthConfig();
  const parameters = [
    `resource_metadata="${escapeChallengeValue(config.protectedResourceMetadataUrl)}"`,
  ];
  if (error) {
    parameters.push(`error="${error}"`);
    parameters.push(
      `error_description="${escapeChallengeValue(
        error === 'insufficient_scope'
          ? 'Additional authorization is required.'
          : 'The access token is invalid or expired.',
      )}"`,
    );
  }
  if (scope) parameters.push(`scope="${escapeChallengeValue(scope)}"`);
  return `Bearer ${parameters.join(', ')}`;
}

export class DirectMcpAuthorizationError extends Error {
  public readonly challenge: string | null;

  constructor(
    public readonly code: DirectMcpAuthorizationErrorCode,
    public readonly status: 401 | 403 | 503,
    message: string,
    options: {
      challengeError?: 'invalid_token' | 'insufficient_scope';
      scope?: string;
    } = {},
  ) {
    super(message);
    this.name = 'DirectMcpAuthorizationError';
    this.challenge = status === 503
      ? null
      : buildChallenge(options.challengeError, options.scope);
  }

  toResponse(): Response {
    const headers = new Headers({
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });
    if (this.challenge) headers.set('www-authenticate', this.challenge);

    return Response.json(
      {
        error: this.code,
        message: this.message,
      },
      {
        status: this.status,
        headers,
      },
    );
  }
}

function invalidToken(message = 'The access token is invalid or inactive.'):
DirectMcpAuthorizationError {
  return new DirectMcpAuthorizationError('invalid_token', 401, message, {
    challengeError: 'invalid_token',
  });
}

function authorizationUnavailable(): DirectMcpAuthorizationError {
  return new DirectMcpAuthorizationError(
    'authorization_unavailable',
    503,
    'The authorization service is temporarily unavailable.',
  );
}

function isDatabaseBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function timestampToMilliseconds(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function getLocalJwks(): Promise<JSONWebKeySet | undefined> {
  const jwks = await auth.api.getJwks();
  if (!jwks || !Array.isArray(jwks.keys)) return undefined;
  return jwks as JSONWebKeySet;
}

function parseRequiredClaims(payload: JWTPayload): DirectMcpJwtClaims {
  const config = resolveDirectMcpOAuthConfig();
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const clientId = typeof payload.azp === 'string' ? payload.azp.trim() : '';
  const sessionId = typeof payload.sid === 'string' ? payload.sid.trim() : '';
  const scope = typeof payload.scope === 'string' ? payload.scope : '';
  const scopes = [...new Set(scope.split(/\s+/u).filter(Boolean))];
  const tokenAudiences = typeof payload.aud === 'string'
    ? [payload.aud]
    : Array.isArray(payload.aud)
      ? payload.aud
      : [];
  const allowedAudiences = new Set([
    config.resource,
    `${config.issuer}/oauth2/userinfo`,
  ]);
  const hasExactResourceBinding = (
    tokenAudiences.includes(config.resource)
    && tokenAudiences.every((audience) => allowedAudiences.has(audience))
  );

  if (
    !subject
    || !clientId
    || !sessionId
    || payload.iss !== config.issuer
    || !hasExactResourceBinding
    || typeof payload.iat !== 'number'
    || typeof payload.exp !== 'number'
    || payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw invalidToken();
  }

  return {
    subject,
    clientId,
    sessionId,
    issuer: config.issuer,
    audience: config.resource,
    scopes,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    payload,
  };
}

export async function verifyDirectMcpJwtClaims(
  token: string,
): Promise<DirectMcpJwtClaims> {
  const normalizedToken = token.trim();
  if (!normalizedToken || normalizedToken.length > MAX_BEARER_TOKEN_LENGTH) {
    throw invalidToken();
  }

  const config = resolveDirectMcpOAuthConfig();
  let jwksUnavailable = false;
  let payload: JWTPayload;
  try {
    payload = await verifyJwsAccessToken(normalizedToken, {
      jwksFetch: async () => {
        try {
          return await getLocalJwks();
        } catch (error) {
          jwksUnavailable = true;
          throw error;
        }
      },
      jwksCacheKey: localJwksCacheKey,
      verifyOptions: {
        issuer: config.issuer,
        audience: config.resource,
      },
    });
  } catch {
    if (jwksUnavailable) throw authorizationUnavailable();
    throw invalidToken();
  }

  return parseRequiredClaims(payload);
}

export async function loadDirectMcpGrantState(
  claims: Pick<DirectMcpJwtClaims, 'sessionId' | 'subject' | 'clientId'>,
  token?: string,
): Promise<DirectMcpGrantStateRow | null> {
  const database = await openDb();
  try {
    const row = await database.get(`
      SELECT
        auth_session.id AS session_id,
        auth_session.expires_at AS session_expires_at,
        local_user.id AS user_id,
        local_user.banned AS user_banned,
        oauth_client.client_id AS client_id,
        oauth_client.disabled AS client_disabled,
        revoked_access_token.token_hash AS revoked_token_hash,
        grant_revocation.revoked_at AS grant_revoked_at
      FROM "session" auth_session
      INNER JOIN "user" local_user
        ON local_user.id = auth_session.user_id
      INNER JOIN oauth_client
        ON oauth_client.client_id = ?
      LEFT JOIN mcp_revoked_access_token revoked_access_token
        ON revoked_access_token.token_hash = ?
       AND revoked_access_token.client_id = oauth_client.client_id
       AND revoked_access_token.session_id = auth_session.id
       AND revoked_access_token.user_id = local_user.id
      LEFT JOIN mcp_direct_grant_revocation grant_revocation
        ON grant_revocation.client_id = oauth_client.client_id
       AND grant_revocation.session_id = auth_session.id
       AND grant_revocation.user_id = local_user.id
      WHERE auth_session.id = ?
        AND auth_session.user_id = ?
      LIMIT 1
    `, [
      claims.clientId,
      token ? createHash('sha256').update(token).digest('base64url') : '',
      claims.sessionId,
      claims.subject,
    ]);
    return (row as DirectMcpGrantStateRow | undefined) ?? null;
  } finally {
    await database.close();
  }
}

function assertGrantStateActive(
  state: DirectMcpGrantStateRow | null,
  claims: DirectMcpJwtClaims,
): void {
  const sessionExpiresAt = timestampToMilliseconds(state?.session_expires_at);
  const grantRevokedAt = timestampToMilliseconds(state?.grant_revoked_at);
  const tokenIssuedAt = claims.issuedAt * 1000;
  if (
    !state
    || state.session_id !== claims.sessionId
    || state.user_id !== claims.subject
    || state.client_id !== claims.clientId
    || isDatabaseBoolean(state.user_banned)
    || isDatabaseBoolean(state.client_disabled)
    || sessionExpiresAt === null
    || sessionExpiresAt <= Date.now()
    || state.revoked_token_hash !== null
    || (grantRevokedAt !== null && tokenIssuedAt <= grantRevokedAt)
  ) {
    throw invalidToken();
  }
}

export async function verifyDirectMcpAccessToken(
  token: string,
  requiredScopes: readonly DirectMcpResourceScope[] = [],
): Promise<DirectMcpAccessPrincipal> {
  const claims = await verifyDirectMcpJwtClaims(token);
  const grantedScopes = new Set(claims.scopes);
  const missingScope = requiredScopes.find((scope) => !grantedScopes.has(scope));
  if (missingScope) {
    throw new DirectMcpAuthorizationError(
      'insufficient_scope',
      403,
      `The access token does not grant the required scope ${missingScope}.`,
      {
        challengeError: 'insufficient_scope',
        scope: missingScope,
      },
    );
  }

  let state: DirectMcpGrantStateRow | null;
  try {
    state = await loadDirectMcpGrantState(claims, token);
  } catch {
    throw authorizationUnavailable();
  }
  assertGrantStateActive(state, claims);

  try {
    await assertUserSeatAccess({ userId: claims.subject });
  } catch (error) {
    if (error instanceof SeatLimitGuardError) throw invalidToken();
    throw authorizationUnavailable();
  }

  return {
    ...claims,
    userId: claims.subject,
  };
}

export async function verifyDirectMcpRequest(
  request: Request,
  requiredScopes: readonly DirectMcpResourceScope[] = [],
): Promise<DirectMcpAccessPrincipal> {
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    throw new DirectMcpAuthorizationError(
      'invalid_token',
      401,
      'A Bearer access token is required.',
    );
  }

  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  if (!match) throw invalidToken('The Authorization header is malformed.');
  return verifyDirectMcpAccessToken(match[1], requiredScopes);
}
