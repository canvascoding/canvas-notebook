import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import { openDb } from '@/app/lib/db';
import {
  assertUserSeatAccess,
  SeatLimitGuardError,
} from '@/app/lib/license/seat-limit';
import {
  DIRECT_MCP_OAUTH_SCOPES,
  DIRECT_MCP_RESOURCE_SCOPES,
  type DirectMcpOAuthScope,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import { directMcpClientDisplayName } from '@/app/lib/mcp/server/client-name';
import { readDirectMcpConnectionUsage } from '@/app/lib/mcp/server/connection-usage';
import {
  evaluateDirectMcpConnectionUsability,
  type DirectMcpRefreshGrantState,
  type DirectMcpSessionState,
} from '@/app/lib/mcp/server/connection-usability';
import { listDirectMcpSelectableWorkspaces } from '@/app/lib/mcp/server/workspace-access-policy';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';

const MAX_CONNECTIONS = 50;
const MAX_AUTHORIZATION_EVIDENCE = 500;
const MAX_CONNECTION_REFERENCE_LENGTH = 2048;

type DirectMcpConnectionRow = {
  consent_id: string;
  client_id: string;
  client_name: string | null;
  scopes: unknown;
  resource_id: string | null;
  resource_disabled: unknown;
  resource_scopes: unknown;
  client_disabled: unknown;
  user_banned: unknown;
  consent_updated_at: unknown;
  connected_at: unknown;
  updated_at: unknown;
  allowed_workspace_count: unknown;
};

type DirectMcpSessionRow = {
  session_id: unknown;
  expires_at: unknown;
};

type DirectMcpGrantRevocationRow = {
  client_id: unknown;
  session_id: unknown;
  revoked_at: unknown;
};

type DirectMcpRefreshGrantRow = {
  id: unknown;
  client_id: unknown;
  session_id: unknown;
  created_at: unknown;
  expires_at: unknown;
  revoked: unknown;
  resources: unknown;
  scopes: unknown;
};

type DirectMcpWorkspaceGrantRow = {
  client_id: unknown;
  workspace_id: unknown;
};

type DirectMcpRevokedTokenRow = {
  client_id: unknown;
  token_hash: unknown;
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
  effectiveScopes: DirectMcpOAuthScope[];
  resourcePolicyStatus: 'active' | 'disabled' | 'missing';
  connectedAt: string | null;
  updatedAt: string | null;
  allowedWorkspaceCount: number;
  authorizationStatus: 'usable' | 'expired' | 'revoked' | 'access_denied' | 'authorization_required' | 'unknown';
  usableGrantCount: number;
  sessionExpiresAt: string | null;
  refreshExpiresAt: string | null;
  lastSuccessfulRequestAt: string | null;
};

export type DisconnectDirectMcpConnectionResult =
  | { status: 'disconnected' }
  | { status: 'not_found' };

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

function isDatabaseBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function parseStringArray(value: unknown): string[] {
  let parsed: unknown = value;
  for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function directMcpGrantKey(clientId: string, sessionId: string): string {
  return JSON.stringify([clientId, sessionId]);
}

function parseScopes(value: unknown): DirectMcpOAuthScope[] {
  let parsed: unknown = value;
  for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
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
    WHERE oauth_consent.id = $1
      AND oauth_consent.user_id = $2
      AND oauth_client_resource.resource_id = $3
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
      WHERE oauth_consent.client_id = $1
        AND oauth_consent.user_id = $2
        AND oauth_client_resource.resource_id = $3
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
        resource_policy.id AS resource_id,
        resource_policy.disabled AS resource_disabled,
        resource_policy.allowed_scopes AS resource_scopes,
        oauth_client.disabled AS client_disabled,
        local_user.banned AS user_banned,
        oauth_consent.updated_at AS consent_updated_at,
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
      INNER JOIN "user" local_user
        ON local_user.id = oauth_consent.user_id
      INNER JOIN oauth_client_resource
        ON oauth_client_resource.client_id = oauth_client.client_id
      LEFT JOIN oauth_resource resource_policy
        ON resource_policy.identifier = oauth_client_resource.resource_id
      WHERE oauth_consent.user_id = $1
        AND oauth_client_resource.resource_id = $2
        AND oauth_client.token_endpoint_auth_method = 'none'
      ORDER BY
        oauth_consent.updated_at DESC,
        oauth_consent.created_at DESC,
        oauth_consent.id DESC
      LIMIT $3
    `, [userId, directMcpResource(), MAX_CONNECTIONS]) as DirectMcpConnectionRow[];

    const rowsByClient = new Map<string, DirectMcpConnectionRow>();
    for (const row of rows) {
      if (typeof row.client_id === 'string' && row.client_id && !rowsByClient.has(row.client_id)) {
        rowsByClient.set(row.client_id, row);
      }
    }
    const clientIds = [...rowsByClient.keys()];
    if (!clientIds.length) return [];

    const clientPlaceholders = clientIds.map((_, index) => `$${index + 2}`).join(', ');
    const [refreshGrantResult, workspaceGrantRows, usageResults] = await Promise.all([
      database.all(`
        SELECT id, client_id, session_id, created_at, expires_at, revoked, resources, scopes
        FROM oauth_refresh_token
        WHERE user_id = $1 AND client_id IN (${clientPlaceholders})
        ORDER BY client_id ASC, created_at DESC, id DESC
        LIMIT $${clientIds.length + 2}
      `, [userId, ...clientIds, MAX_AUTHORIZATION_EVIDENCE + 1]) as Promise<DirectMcpRefreshGrantRow[]>,
      database.all(`
        SELECT client_id, workspace_id
        FROM mcp_direct_workspace_grant
        WHERE user_id = $1 AND client_id IN (${clientPlaceholders})
      `, [userId, ...clientIds]) as Promise<DirectMcpWorkspaceGrantRow[]>,
      Promise.all(clientIds.map(async (clientId) => {
        try {
          return [clientId, { known: true as const, usage: await readDirectMcpConnectionUsage(userId, clientId) }] as const;
        } catch {
          // A private history file is only supporting evidence. A read failure
          // must not turn a connected client into an assumed active grant.
          return [clientId, { known: false as const, usage: null }] as const;
        }
      })),
    ]);
    const refreshEvidenceTruncated = refreshGrantResult.length > MAX_AUTHORIZATION_EVIDENCE;
    const refreshGrantRows = refreshGrantResult.slice(0, MAX_AUTHORIZATION_EVIDENCE);
    const usageByClient = new Map<string, {
      known: boolean;
      usage: Awaited<ReturnType<typeof readDirectMcpConnectionUsage>> | null;
    }>(usageResults);

    const evidencePairs = new Map<string, { clientId: string; sessionId: string }>();
    const evidenceTruncatedClients = new Set<string>();
    const addEvidencePair = (clientId: string, sessionId: string) => {
      const key = directMcpGrantKey(clientId, sessionId);
      if (evidencePairs.has(key)) return;
      if (evidencePairs.size >= MAX_AUTHORIZATION_EVIDENCE) {
        evidenceTruncatedClients.add(clientId);
        return;
      }
      evidencePairs.set(key, { clientId, sessionId });
    };
    for (const row of refreshGrantRows) {
      if (typeof row.client_id === 'string' && typeof row.session_id === 'string') {
        addEvidencePair(row.client_id, row.session_id);
      }
    }
    for (const [clientId, result] of usageResults) {
      for (const grant of result.usage?.grants ?? []) addEvidencePair(clientId, grant.sessionId);
    }
    const evidence = [...evidencePairs.values()];
    const sessionIds = [...new Set(evidence.map((pair) => pair.sessionId))];
    const [sessionRows, grantRevocationRows] = sessionIds.length === 0
      ? [[], []] as const
      : await Promise.all([
        database.all(`
          SELECT id AS session_id, expires_at
          FROM "session"
          WHERE user_id = $1 AND id IN (${sessionIds.map((_, index) => `$${index + 2}`).join(', ')})
        `, [userId, ...sessionIds]) as Promise<DirectMcpSessionRow[]>,
        database.all(`
          WITH expected(client_id, session_id) AS (
            VALUES ${evidence.map((_, index) => `($${index * 2 + 2}, $${index * 2 + 3})`).join(', ')}
          )
          SELECT revocation.client_id, revocation.session_id, revocation.revoked_at
          FROM mcp_direct_grant_revocation revocation
          INNER JOIN expected
            ON expected.client_id = revocation.client_id
           AND expected.session_id = revocation.session_id
          WHERE revocation.user_id = $1
        `, [userId, ...evidence.flatMap((pair) => [pair.clientId, pair.sessionId])]) as Promise<DirectMcpGrantRevocationRow[]>,
      ]);
    const tokenHashes = [...new Set(usageResults.flatMap(([, value]) => (
      value.usage?.grants.map((grant) => grant.tokenHash) ?? []
    )))];
    const revokedTokenRows = tokenHashes.length === 0 ? [] : await database.all(`
      SELECT client_id, token_hash
      FROM mcp_revoked_access_token
      WHERE user_id = $1
        AND client_id IN (${clientPlaceholders})
        AND token_hash IN (${tokenHashes.map((_, index) => `$${clientIds.length + index + 2}`).join(', ')})
    `, [userId, ...clientIds, ...tokenHashes]) as DirectMcpRevokedTokenRow[];

    let seatAllowed: boolean | null = true;
    try {
      await assertUserSeatAccess({ userId });
    } catch (error) {
      seatAllowed = error instanceof SeatLimitGuardError ? false : null;
    }
    let selectableWorkspaceIds: Set<string> | null;
    try {
      selectableWorkspaceIds = new Set((await listDirectMcpSelectableWorkspaces(userId))
        .map((workspace) => workspace.workspaceId));
    } catch {
      selectableWorkspaceIds = null;
    }

    const sessions = sessionRows.flatMap((row): DirectMcpSessionState[] => (
      typeof row.session_id === 'string' && row.session_id
        ? [{ sessionId: row.session_id, expiresAt: row.expires_at, grantRevokedAt: null }]
        : []
    ));
    const grantRevokedAtByClientSession = new Map<string, unknown>();
    for (const row of grantRevocationRows) {
      if (typeof row.client_id === 'string' && typeof row.session_id === 'string') {
        grantRevokedAtByClientSession.set(directMcpGrantKey(row.client_id, row.session_id), row.revoked_at);
      }
    }
    const refreshGrantsByClient = new Map<string, DirectMcpRefreshGrantRow[]>();
    for (const row of refreshGrantRows) {
      if (typeof row.client_id !== 'string') continue;
      const grants = refreshGrantsByClient.get(row.client_id) ?? [];
      grants.push(row);
      refreshGrantsByClient.set(row.client_id, grants);
    }
    const workspaceIdsByClient = new Map<string, Set<string>>();
    for (const row of workspaceGrantRows) {
      if (typeof row.client_id !== 'string' || typeof row.workspace_id !== 'string') continue;
      const workspaceIds = workspaceIdsByClient.get(row.client_id) ?? new Set<string>();
      workspaceIds.add(row.workspace_id);
      workspaceIdsByClient.set(row.client_id, workspaceIds);
    }
    const revokedTokenHashesByClient = new Map<string, Set<string>>();
    for (const row of revokedTokenRows) {
      if (typeof row.client_id !== 'string' || typeof row.token_hash !== 'string') continue;
      const hashes = revokedTokenHashesByClient.get(row.client_id) ?? new Set<string>();
      hashes.add(row.token_hash);
      revokedTokenHashesByClient.set(row.client_id, hashes);
    }

    const connections = new Map<string, DirectMcpConnection>();
    for (const [clientId, row] of rowsByClient) {
      const scopes = parseScopes(row.scopes);
      const resourcePolicyStatus = !row.resource_id ? 'missing'
        : [true, 1, '1'].includes(row.resource_disabled as boolean | number | string)
          ? 'disabled' : 'active';
      const resourceScopes = row.resource_scopes == null
        ? DIRECT_MCP_OAUTH_SCOPES : parseScopes(row.resource_scopes);
      const effectiveScopes = resourcePolicyStatus === 'active'
        ? scopes.filter((scope) => resourceScopes.includes(scope)) : [];
      const effectiveResourceScopes = effectiveScopes.filter((scope) => (
        (DIRECT_MCP_RESOURCE_SCOPES as readonly string[]).includes(scope)
      ));
      const allowedWorkspaceIds = workspaceIdsByClient.get(clientId) ?? new Set<string>();
      const usage = usageByClient.get(clientId) ?? { known: false as const, usage: null };
      const refreshGrants = (refreshGrantsByClient.get(clientId) ?? []).flatMap((grant): DirectMcpRefreshGrantState[] => (
        typeof grant.id === 'string' && grant.id && (typeof grant.session_id === 'string' || grant.session_id === null)
          ? [{
            id: grant.id,
            sessionId: grant.session_id,
            issuedAt: grant.created_at,
            expiresAt: grant.expires_at,
            revokedAt: grant.revoked,
            resourceAllowed: parseStringArray(grant.resources).includes(directMcpResource()),
            scopes: parseScopes(grant.scopes),
          }]
          : []
      ));
      const usability = evaluateDirectMcpConnectionUsability({
        effectiveScopeCount: effectiveResourceScopes.length,
        effectiveResourceScopes,
        resourcePolicyActive: resourcePolicyStatus === 'active',
        clientDisabled: isDatabaseBoolean(row.client_disabled),
        userBanned: isDatabaseBoolean(row.user_banned),
        seatAllowed,
        workspaceStateKnown: selectableWorkspaceIds !== null,
        usageStateKnown: usage.known,
        grantStateKnown: !refreshEvidenceTruncated && !evidenceTruncatedClients.has(clientId),
        allowedWorkspaceCount: allowedWorkspaceIds.size,
        usableWorkspaceCount: selectableWorkspaceIds === null ? 0
          : [...allowedWorkspaceIds].filter((workspaceId) => selectableWorkspaceIds.has(workspaceId)).length,
        consentUpdatedAt: row.consent_updated_at,
        observedGrants: usage.usage?.grants ?? [],
        revokedTokenHashes: revokedTokenHashesByClient.get(clientId) ?? new Set(),
        sessions: sessions.map((session) => ({
          ...session,
          grantRevokedAt: grantRevokedAtByClientSession.get(directMcpGrantKey(clientId, session.sessionId)) ?? null,
        })),
        refreshGrants,
      });
      connections.set(clientId, {
        connectionId: encodeConnectionReference(userId, row.consent_id),
        clientName: directMcpClientDisplayName(row.client_name),
        scopes,
        effectiveScopes,
        resourcePolicyStatus,
        connectedAt: timestampToIso(row.connected_at),
        updatedAt: timestampToIso(row.updated_at),
        allowedWorkspaceCount: toSafeCount(row.allowed_workspace_count),
        ...usability,
        lastSuccessfulRequestAt: usage.usage?.lastSuccessfulRequestAt ?? null,
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

    // JWT access tokens are self-contained and do not have an
    // oauth_access_token row. Revoke this client/user grant across every
    // surviving user session so a token remains inactive even when the client
    // never received (or already discarded) a refresh token.
    const sessionRows = await database.all(`
      SELECT id AS session_id
      FROM "session"
      WHERE user_id = $1
    `, [userId]) as Array<{ session_id: string }>;

    for (const sessionRow of sessionRows) {
      if (!sessionRow.session_id) continue;
      await database.run(`
        INSERT INTO mcp_direct_grant_revocation (
          client_id, session_id, user_id, revoked_at
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT(client_id, session_id, user_id)
        DO UPDATE SET revoked_at = excluded.revoked_at
      `, [clientId, sessionRow.session_id, userId, revokedAt]);
    }

    await database.run(`
      UPDATE oauth_refresh_token
      SET revoked = COALESCE(revoked, $1)
      WHERE client_id = $2 AND user_id = $3
    `, [revokedAt, clientId, userId]);
    await database.run(`
      UPDATE oauth_access_token
      SET expires_at = CASE WHEN expires_at > $1 THEN $2 ELSE expires_at END
      WHERE client_id = $3 AND user_id = $4
    `, [revokedAt, revokedAt, clientId, userId]);
    await database.run(`
      DELETE FROM mcp_direct_workspace_grant
      WHERE client_id = $1 AND user_id = $2
    `, [clientId, userId]);
    await database.run(`
      DELETE FROM oauth_consent
      WHERE client_id = $1 AND user_id = $2
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
