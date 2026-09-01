import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import { openDb } from '@/app/lib/db';
import {
  DIRECT_MCP_OAUTH_SCOPES,
  type DirectMcpOAuthScope,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';

const MAX_CONNECTIONS = 50;
const MAX_CONNECTION_REFERENCE_LENGTH = 2048;

type DirectMcpConnectionRow = {
  consent_id: string;
  client_id: string;
  client_name: string | null;
  scopes: unknown;
  connected_at: unknown;
  updated_at: unknown;
  allowed_workspace_count: unknown;
};

type DirectMcpConnectionReference = {
  version: 1;
  userId: string;
  consentId: string;
};

export type DirectMcpConnection = {
  connectionId: string;
  clientName: string;
  scopes: DirectMcpOAuthScope[];
  connectedAt: string | null;
  updatedAt: string | null;
  allowedWorkspaceCount: number;
};

export type DisconnectDirectMcpConnectionResult =
  | { status: 'disconnected' }
  | { status: 'not_found' };

function safeClientName(value: string | null): string {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return normalized || 'MCP client';
}

function timestampToIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampToIso(numeric);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function toSafeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(200, Math.trunc(value)));
  }
  if (typeof value === 'string') return toSafeCount(Number(value));
  return 0;
}

function parseScopes(value: unknown): DirectMcpOAuthScope[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const allowed = new Set<string>(DIRECT_MCP_OAUTH_SCOPES);
  return DIRECT_MCP_OAUTH_SCOPES.filter((scope) => (
    allowed.has(scope) && parsed.includes(scope)
  ));
}

function connectionSignature(encodedPayload: string): string {
  return createHmac(
    'sha256',
    resolveAuthSecret(process.env, { allowProductionBuildFallback: true }),
  ).update(encodedPayload).digest('base64url');
}

function encodeConnectionReference(userId: string, consentId: string): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, userId, consentId }), 'utf8')
    .toString('base64url');
  return `${payload}.${connectionSignature(payload)}`;
}

function decodeConnectionReference(value: string): DirectMcpConnectionReference | null {
  if (!value || value.length > MAX_CONNECTION_REFERENCE_LENGTH) return null;
  const [encodedPayload, signature, ...extra] = value.split('.');
  if (!encodedPayload || !signature || extra.length > 0) return null;

  const expectedSignature = connectionSignature(encodedPayload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    actualBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<DirectMcpConnectionReference>;
    if (
      parsed.version !== 1
      || typeof parsed.userId !== 'string'
      || !parsed.userId
      || typeof parsed.consentId !== 'string'
      || !parsed.consentId
    ) {
      return null;
    }
    return {
      version: 1,
      userId: parsed.userId,
      consentId: parsed.consentId,
    };
  } catch {
    return null;
  }
}

function directMcpResource(): string {
  return resolveDirectMcpOAuthConfig().resource;
}

async function findOwnedDirectMcpConnectionClientId(input: {
  database: Awaited<ReturnType<typeof openDb>>;
  userId: string;
  connectionId: string;
}): Promise<string | null> {
  const reference = decodeConnectionReference(input.connectionId);
  if (!reference || reference.userId !== input.userId) return null;

  const connection = await input.database.get(`
    SELECT oauth_consent.client_id AS client_id
    FROM oauth_consent
    INNER JOIN oauth_client
      ON oauth_client.client_id = oauth_consent.client_id
    INNER JOIN oauth_client_resource
      ON oauth_client_resource.client_id = oauth_client.client_id
    WHERE oauth_consent.id = ?
      AND oauth_consent.user_id = ?
      AND oauth_client_resource.resource_id = ?
      AND oauth_client.token_endpoint_auth_method = 'none'
    LIMIT 1
  `, [reference.consentId, input.userId, directMcpResource()]) as { client_id: unknown } | undefined;
  return typeof connection?.client_id === 'string' && connection.client_id
    ? connection.client_id
    : null;
}

export async function resolveOwnedDirectMcpConnectionClientId(
  userId: string,
  connectionId: string,
): Promise<string | null> {
  const database = await openDb();
  try {
    return await findOwnedDirectMcpConnectionClientId({ database, userId, connectionId });
  } finally {
    await database.close();
  }
}

export async function hasDirectMcpConnectionConsent(input: {
  clientId: string;
  userId: string;
}): Promise<boolean> {
  const database = await openDb();
  try {
    const connection = await database.get(`
      SELECT 1
      FROM oauth_consent
      INNER JOIN oauth_client_resource
        ON oauth_client_resource.client_id = oauth_consent.client_id
      WHERE oauth_consent.client_id = ?
        AND oauth_consent.user_id = ?
        AND oauth_client_resource.resource_id = ?
      LIMIT 1
    `, [input.clientId, input.userId, directMcpResource()]);
    return Boolean(connection);
  } finally {
    await database.close();
  }
}

export async function listDirectMcpConnections(
  userId: string,
): Promise<DirectMcpConnection[]> {
  const database = await openDb();
  try {
    const rows = await database.all(`
      SELECT
        oauth_consent.id AS consent_id,
        oauth_consent.client_id AS client_id,
        oauth_client.name AS client_name,
        oauth_consent.scopes AS scopes,
        oauth_consent.created_at AS connected_at,
        oauth_consent.updated_at AS updated_at,
        (
          SELECT COUNT(*)
          FROM mcp_direct_workspace_grant workspace_grant
          WHERE workspace_grant.client_id = oauth_consent.client_id
            AND workspace_grant.user_id = oauth_consent.user_id
        ) AS allowed_workspace_count
      FROM oauth_consent
      INNER JOIN oauth_client
        ON oauth_client.client_id = oauth_consent.client_id
      INNER JOIN oauth_client_resource
        ON oauth_client_resource.client_id = oauth_client.client_id
      WHERE oauth_consent.user_id = ?
        AND oauth_client_resource.resource_id = ?
        AND oauth_client.token_endpoint_auth_method = 'none'
      ORDER BY oauth_consent.updated_at DESC, oauth_consent.created_at DESC
      LIMIT ?
    `, [userId, directMcpResource(), MAX_CONNECTIONS]) as DirectMcpConnectionRow[];

    const connections = new Map<string, DirectMcpConnection>();
    for (const row of rows) {
      if (connections.has(row.client_id)) continue;
      connections.set(row.client_id, {
        connectionId: encodeConnectionReference(userId, row.consent_id),
        clientName: safeClientName(row.client_name),
        scopes: parseScopes(row.scopes),
        connectedAt: timestampToIso(row.connected_at),
        updatedAt: timestampToIso(row.updated_at),
        allowedWorkspaceCount: toSafeCount(row.allowed_workspace_count),
      });
    }
    return [...connections.values()];
  } finally {
    await database.close();
  }
}

export async function disconnectDirectMcpConnection(
  userId: string,
  connectionId: string,
): Promise<DisconnectDirectMcpConnectionResult> {
  const database = await openDb();
  const revokedAt = Date.now();
  try {
    await database.run('BEGIN');
    const clientId = await findOwnedDirectMcpConnectionClientId({
      database,
      userId,
      connectionId,
    });
    if (!clientId) {
      await database.run('ROLLBACK');
      return { status: 'not_found' };
    }

    const sessionRows = await database.all(`
      SELECT DISTINCT session_id
      FROM oauth_refresh_token
      WHERE client_id = ? AND user_id = ? AND session_id IS NOT NULL
      UNION
      SELECT DISTINCT session_id
      FROM oauth_access_token
      WHERE client_id = ? AND user_id = ? AND session_id IS NOT NULL
    `, [clientId, userId, clientId, userId]) as Array<{ session_id: string }>;

    for (const sessionRow of sessionRows) {
      if (!sessionRow.session_id) continue;
      await database.run(`
        INSERT INTO mcp_direct_grant_revocation (
          client_id, session_id, user_id, revoked_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(client_id, session_id, user_id)
        DO UPDATE SET revoked_at = excluded.revoked_at
      `, [clientId, sessionRow.session_id, userId, revokedAt]);
    }

    await database.run(`
      UPDATE oauth_refresh_token
      SET revoked = COALESCE(revoked, ?)
      WHERE client_id = ? AND user_id = ?
    `, [revokedAt, clientId, userId]);
    await database.run(`
      UPDATE oauth_access_token
      SET expires_at = CASE WHEN expires_at > ? THEN ? ELSE expires_at END
      WHERE client_id = ? AND user_id = ?
    `, [revokedAt, revokedAt, clientId, userId]);
    await database.run(`
      DELETE FROM mcp_direct_workspace_grant
      WHERE client_id = ? AND user_id = ?
    `, [clientId, userId]);
    await database.run(`
      DELETE FROM oauth_consent
      WHERE client_id = ? AND user_id = ?
    `, [clientId, userId]);
    await database.run('COMMIT');
    return { status: 'disconnected' };
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back by the database.
    }
    throw error;
  } finally {
    await database.close();
  }
}
