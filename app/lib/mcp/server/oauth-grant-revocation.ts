import 'server-only';

import { createHash } from 'node:crypto';

import { openDb } from '@/app/lib/db';
import {
  DirectMcpAuthorizationError,
  loadDirectMcpGrantState,
  verifyDirectMcpJwtClaims,
} from '@/app/lib/mcp/server/access-token-verifier';
import {
  assertUserSeatAccess,
  SeatLimitGuardError,
} from '@/app/lib/license/seat-limit';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';

type DirectMcpRefreshGrantRow = {
  id: string;
  client_id: string;
  session_id: string | null;
  user_id: string;
  expires_at: unknown;
  revoked: unknown;
  session_expires_at: unknown;
  user_banned: unknown;
  client_disabled: unknown;
};

export type DirectMcpRevocationCandidate = {
  clientId: string;
  sessionId: string | null;
  userId: string;
  tokenType: 'access_token' | 'refresh_token';
  refreshId: string | null;
  accessTokenHash: string | null;
  accessTokenExpiresAt: number | null;
};

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

function storedTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function readBasicClientId(authorization: string | null): string | null {
  if (!authorization?.startsWith('Basic ')) return null;
  try {
    const value = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = value.indexOf(':');
    if (separator < 0) return null;
    return decodeURIComponent(value.slice(0, separator)).trim() || null;
  } catch {
    return null;
  }
}

function readClientId(form: FormData, headers: Headers): string | null {
  const basicClientId = readBasicClientId(headers.get('authorization'));
  if (basicClientId) return basicClientId;
  const formClientId = form.get('client_id');
  return typeof formClientId === 'string' && formClientId.trim()
    ? formClientId.trim()
    : null;
}

async function loadRefreshGrant(
  token: string,
  clientId: string,
): Promise<DirectMcpRefreshGrantRow | null> {
  const database = await openDb();
  try {
    const row = await database.get(`
      SELECT
        refresh_grant.id,
        refresh_grant.client_id,
        refresh_grant.session_id,
        refresh_grant.user_id,
        refresh_grant.expires_at,
        refresh_grant.revoked,
        auth_session.expires_at AS session_expires_at,
        local_user.banned AS user_banned,
        oauth_client.disabled AS client_disabled
      FROM oauth_refresh_token refresh_grant
      INNER JOIN "user" local_user
        ON local_user.id = refresh_grant.user_id
      INNER JOIN oauth_client
        ON oauth_client.client_id = refresh_grant.client_id
      LEFT JOIN "session" auth_session
        ON auth_session.id = refresh_grant.session_id
       AND auth_session.user_id = refresh_grant.user_id
      WHERE refresh_grant.token = ?
        AND refresh_grant.client_id = ?
      LIMIT 1
    `, [storedTokenHash(token), clientId]);
    return (row as DirectMcpRefreshGrantRow | undefined) ?? null;
  } finally {
    await database.close();
  }
}

function refreshGrantIsLocallyActive(grant: DirectMcpRefreshGrantRow): boolean {
  const refreshExpiresAt = timestampToMilliseconds(grant.expires_at);
  const sessionExpiresAt = timestampToMilliseconds(grant.session_expires_at);
  return (
    !grant.revoked
    && Boolean(grant.session_id)
    && refreshExpiresAt !== null
    && refreshExpiresAt > Date.now()
    && sessionExpiresAt !== null
    && sessionExpiresAt > Date.now()
    && !isDatabaseBoolean(grant.user_banned)
    && !isDatabaseBoolean(grant.client_disabled)
  );
}

export async function directMcpRefreshGrantIsActive(
  form: FormData,
  headers: Headers,
): Promise<boolean | null> {
  const refreshToken = form.get('refresh_token');
  const clientId = readClientId(form, headers);
  if (typeof refreshToken !== 'string' || !refreshToken || !clientId) return null;

  const grant = await loadRefreshGrant(refreshToken, clientId);
  if (!grant) return null;
  if (!refreshGrantIsLocallyActive(grant)) return false;

  try {
    await assertUserSeatAccess({ userId: grant.user_id });
  } catch (error) {
    if (error instanceof SeatLimitGuardError) return false;
    throw error;
  }
  return true;
}

async function prepareAccessTokenCandidate(
  token: string,
  clientId: string,
): Promise<DirectMcpRevocationCandidate | null> {
  try {
    const claims = await verifyDirectMcpJwtClaims(token);
    if (claims.clientId !== clientId) return null;
    const state = await loadDirectMcpGrantState(claims);
    if (!state) return null;
    return {
      clientId,
      sessionId: claims.sessionId,
      userId: claims.subject,
      tokenType: 'access_token',
      refreshId: null,
      accessTokenHash: storedTokenHash(token),
      accessTokenExpiresAt: claims.expiresAt * 1000,
    };
  } catch (error) {
    if (error instanceof DirectMcpAuthorizationError) return null;
    throw error;
  }
}

async function prepareRefreshTokenCandidate(
  token: string,
  clientId: string,
): Promise<DirectMcpRevocationCandidate | null> {
  const grant = await loadRefreshGrant(token, clientId);
  if (!grant) return null;
  return {
    clientId,
    sessionId: grant.session_id,
    userId: grant.user_id,
    tokenType: 'refresh_token',
    refreshId: grant.id,
    accessTokenHash: null,
    accessTokenExpiresAt: null,
  };
}

export async function prepareDirectMcpRevocation(
  request: Request,
): Promise<DirectMcpRevocationCandidate | null> {
  if (!(await getDirectMcpRuntimeSettings()).enabled) return null;

  const url = new URL(request.url);
  if (
    request.method !== 'POST'
    || url.pathname !== '/api/auth/oauth2/revoke'
  ) {
    return null;
  }

  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return null;
  }

  const tokenValue = form.get('token');
  const clientId = readClientId(form, request.headers);
  const hintValue = form.get('token_type_hint');
  const hint = typeof hintValue === 'string' ? hintValue : null;
  if (typeof tokenValue !== 'string' || !tokenValue || !clientId) return null;
  const token = tokenValue.startsWith('Bearer ') ? tokenValue.slice(7) : tokenValue;

  if (hint === null || hint === 'access_token') {
    const candidate = await prepareAccessTokenCandidate(token, clientId);
    if (candidate || hint === 'access_token') return candidate;
  }
  if (hint === null || hint === 'refresh_token') {
    return prepareRefreshTokenCandidate(token, clientId);
  }
  return null;
}

export async function applyDirectMcpRevocation(
  candidate: DirectMcpRevocationCandidate,
): Promise<void> {
  const database = await openDb();
  const revokedAt = Date.now();
  await database.run('BEGIN');
  try {
    if (candidate.accessTokenHash && candidate.sessionId && candidate.accessTokenExpiresAt) {
      await database.run(`
        INSERT INTO mcp_revoked_access_token (
          token_hash, client_id, session_id, user_id, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO NOTHING
      `, [
        candidate.accessTokenHash,
        candidate.clientId,
        candidate.sessionId,
        candidate.userId,
        candidate.accessTokenExpiresAt,
        revokedAt,
      ]);
    } else if (candidate.refreshId) {
      await database.run(`
        UPDATE oauth_refresh_token
        SET revoked = COALESCE(revoked, ?)
        WHERE id = ? AND user_id = ? AND client_id = ?
      `, [revokedAt, candidate.refreshId, candidate.userId, candidate.clientId]);
      await database.run(`
        UPDATE oauth_access_token
        SET expires_at = CASE WHEN expires_at > ? THEN ? ELSE expires_at END
        WHERE refresh_id = ? AND user_id = ? AND client_id = ?
      `, [revokedAt, revokedAt, candidate.refreshId, candidate.userId, candidate.clientId]);
    }
    await database.run('COMMIT');
  } catch (error) {
    await database.run('ROLLBACK');
    throw error;
  } finally {
    await database.close();
  }
}
