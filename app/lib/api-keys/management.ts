import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { auth } from '@/app/lib/auth';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { normalizeDatabaseTimestamp } from '@/app/lib/db/timestamps';
import { getLicenseStatusOnConnection } from '@/app/lib/license';
import { getLicenseInstanceId } from '@/app/lib/license/instance';
import { assertUserSeatAccessInSingleSnapshotOnConnection } from '@/app/lib/license/seat-limit';
import { createPublicRateLimitStore } from '@/app/lib/security/public-rate-limit-store';
import { readPostgresWorkspaceForUserInSingleSnapshotOnConnection } from '@/app/lib/workspaces/postgres-runtime';
import {
  ApiKeyAccessError, apiCredentialPageSchema, apiIntegrationPageSchema, createApiIntegrationSchema, revokeApiKeySchema,
  rotateApiKeySchema, updateApiIntegrationSchema,
  type ApiIntegrationGrant, type ApiIntegrationMetadata, type ApiKeyMetadata,
} from './contracts';
import { issueApiKeySecret } from './secret';
import { storedGrant } from './grants';

type IntegrationRow = {
  id: string; name: string; workspace_ids_json: string; actions_json: string;
  creation_request_id: string; revision: number; created_at: number; updated_at: number;
};
type CredentialRow = {
  id: string; prefix: string; issuance_request_id: string; expires_at: number;
  revoked_at: number | null; last_used_at: number | null; created_at: number;
};
type Manager = { userId: string; sessionId: string; instanceId: string; expiresAt: number };
const credentialColumns = 'id,prefix,issuance_request_id,expires_at,revoked_at,last_used_at,created_at';
const policyTables = ['canvas_organization_settings', 'team_memberships', 'team_membership_sync_state',
  'user', 'session', 'organization_user_permissions', 'canvas_workspaces', 'canvas_projects',
  'canvas_workspace_members', 'canvas_project_members'];
const expiryWindow = 365 * 24 * 60 * 60 * 1000;
const consumeManagementBudget = createPublicRateLimitStore(openDb);

function credentialMetadata(row: CredentialRow): ApiKeyMetadata {
  return { id: row.id, prefix: row.prefix, issuanceRequestId: row.issuance_request_id,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at) };
}

function integrationMetadata(row: IntegrationRow, latest: CredentialRow | null | undefined): ApiIntegrationMetadata {
  return { id: row.id, name: row.name, creationRequestId: row.creation_request_id,
    ...storedGrant(row), revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    latestCredential: latest ? credentialMetadata(latest) : null };
}

async function readIntegrationMetadata(database: SqlConnection, row: IntegrationRow) {
  // Explicit projections never read a credential hash into a public DTO.
  const latest = await database.get(`SELECT ${credentialColumns} FROM canvas_api_keys
    WHERE integration_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [row.id]) as CredentialRow | undefined;
  return integrationMetadata(row, latest);
}

/** Only the actual auth provider can create a manager. Keys cannot mint keys. */
async function withManager<T>(headers: Headers, work: (database: SqlConnection, manager: Manager) => Promise<T>): Promise<T> {
  if (headers.has('x-canvas-api-key')) {
    throw new ApiKeyAccessError('API_KEY_MANAGEMENT_SESSION_REQUIRED', 'Sign in to manage API access.', 401);
  }
  const authenticated = await auth.api.getSession({ headers });
  if (!authenticated?.session.token) throw new ApiKeyAccessError('UNAUTHORIZED', 'Sign in to manage API access.', 401);
  const budget = await consumeManagementBudget([
    { key: `api-key-management:user:${createHash('sha256').update(authenticated.user.id).digest('hex')}`,
      limit: 120, windowMs: 60_000 },
  ]);
  if (!budget.ok) throw new ApiKeyAccessError('API_KEY_RATE_LIMITED', 'Too many requests.', 429, { retryAfter: budget.retryAfter });
  const tokenHash = createHash('sha256').update(authenticated.session.token).digest('hex');
  const database = await openDb();
  const phaseStartedAt = Date.now();
  let committed = false, commitAttempted = false, discard: Error | undefined;
  try {
    await database.run('BEGIN');
    await database.run("SET LOCAL statement_timeout='5s'");
    await database.run("SET LOCAL lock_timeout='1s'");
    // Management is a short phase. Prevent session/ACL changes between the
    // current check and credential issuance; document calls have their own phases.
    await database.run(`LOCK TABLE ${policyTables.map(name => `"${name}"`).join(',')} IN SHARE MODE`);
    const row = await database.get(`SELECT s.user_id,s.expires_at,s.impersonated_by,
      encode(sha256(convert_to(s.token,'UTF8')),'hex') AS token_hash
      FROM session s JOIN "user" u ON u.id=s.user_id WHERE s.id=$1`, [authenticated.session.id]) as {
        user_id: string; expires_at: number; token_hash: string; impersonated_by: string | null;
      } | undefined;
    if (!row || row.user_id !== authenticated.user.id || row.token_hash !== tokenHash
      || (row.impersonated_by ?? null) !== (authenticated.session.impersonatedBy ?? null)
      || normalizeDatabaseTimestamp(Number(row.expires_at)) <= Date.now()) {
      throw new ApiKeyAccessError('UNAUTHORIZED', 'Your session is no longer valid.', 401);
    }
    await assertUserSeatAccessInSingleSnapshotOnConnection(database, row.user_id, await getLicenseStatusOnConnection(database));
    const manager: Manager = { userId: row.user_id, sessionId: authenticated.session.id,
      expiresAt: normalizeDatabaseTimestamp(Number(row.expires_at)), instanceId: getLicenseInstanceId() };
    const result = await work(database, manager);
    if (Date.now() >= manager.expiresAt || getLicenseInstanceId() !== manager.instanceId) {
      throw new ApiKeyAccessError('UNAUTHORIZED', 'Your session is no longer valid.', 401);
    }
    if (Date.now() - phaseStartedAt > 5000) throw new ApiKeyAccessError('API_KEY_PHASE_EXPIRED',
      'The management operation exceeded its time limit. Reload the current metadata.', 503);
    commitAttempted = true;
    await database.run('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    if (!committed) {
      try { await database.run('ROLLBACK'); }
      catch { discard = error instanceof Error ? error : new Error('API access transaction failed.'); }
    }
    if (commitAttempted) throw new ApiKeyAccessError('API_KEY_OUTCOME_UNKNOWN',
      'The result could not be confirmed. Inspect the integration metadata before taking another action.', 503);
    throw error;
  } finally {
    await database.close(discard);
  }
}

async function ownedIntegration(database: SqlConnection, manager: Manager, id: string): Promise<IntegrationRow> {
  const row = await database.get(`SELECT id,name,workspace_ids_json,actions_json,creation_request_id,revision,created_at,updated_at
    FROM canvas_api_integrations WHERE id=$1 AND owner_user_id=$2 AND instance_id=$3 FOR UPDATE`,
  [id, manager.userId, manager.instanceId]) as IntegrationRow | undefined;
  if (!row) throw new ApiKeyAccessError('API_INTEGRATION_NOT_FOUND', 'Integration not found.', 404);
  return row;
}

function requireRevision(row: IntegrationRow, expected: number): void {
  if (Number(row.revision) !== expected) throw new ApiKeyAccessError('API_INTEGRATION_CHANGED',
    'The integration has changed. Reload its current metadata.', 409, { integrationId: row.id });
}

function requireExpiry(expiresAt: number): void {
  const now = Date.now();
  if (expiresAt < now + 60_000 || expiresAt > now + expiryWindow) {
    throw new ApiKeyAccessError('API_KEY_EXPIRY_INVALID', 'Choose an expiry between one minute and 365 days from now.', 400);
  }
}

async function requireGrant(database: SqlConnection, manager: Manager, grant: ApiIntegrationGrant): Promise<void> {
  for (const workspaceId of grant.workspaceIds) {
    const workspace = await readPostgresWorkspaceForUserInSingleSnapshotOnConnection(database, manager.userId, workspaceId);
    const needsWrite = grant.actions.some(action => ['create', 'import', 'edit', 'copy', 'move', 'recover'].includes(action));
    const needsDelete = grant.actions.includes('delete');
    // A Copy allowlist contains source as well as destination workspaces. A
    // read-only workspace can be a source. This grants no destination/write
    // right: each actual fixed operation intersects its roles with current ACL.
    const mayBeCopySource = grant.actions.includes('copy');
    if (!workspace?.permissions.canRead || !mayBeCopySource && needsWrite && !workspace.permissions.canWrite
      || !mayBeCopySource && needsDelete && !workspace.permissions.canDelete) {
      throw new ApiKeyAccessError('API_KEY_GRANT_DENIED', 'You cannot grant the requested workspace actions.', 403);
    }
  }
}

async function insertCredential(database: SqlConnection, manager: Manager, integrationId: string, requestId: string, expiresAt: number) {
  const issued = issueApiKeySecret(), now = Date.now();
  const row = await database.get(`INSERT INTO canvas_api_keys
    (id,integration_id,secret_hash,prefix,issuance_request_id,created_by_session_id,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${credentialColumns}`,
  [issued.id, integrationId, issued.secretHash, issued.prefix, requestId, manager.sessionId, expiresAt, now]) as CredentialRow;
  return { credential: credentialMetadata(row), key: issued.key };
}

function alreadyIssued(integrationId: string): never {
  throw new ApiKeyAccessError('API_KEY_ALREADY_ISSUED',
    'This request already issued a key. Inspect its metadata and revoke it if the secret was not received.', 409, { integrationId });
}

export async function createApiIntegration(headers: Headers, input: unknown) {
  const parsed = createApiIntegrationSchema.parse(input);
  return withManager(headers, async (database, manager) => {
    const prior = await database.get(`SELECT id FROM canvas_api_integrations
      WHERE owner_user_id=$1 AND instance_id=$2 AND creation_request_id=$3`,
    [manager.userId, manager.instanceId, parsed.requestId]) as { id: string } | undefined;
    if (prior) alreadyIssued(prior.id);
    requireExpiry(parsed.expiresAt);
    await requireGrant(database, manager, parsed);
    const id = randomUUID(), now = Date.now();
    const row = await database.get(`INSERT INTO canvas_api_integrations
      (id,owner_user_id,instance_id,name,workspace_ids_json,actions_json,creation_request_id,revision,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$8) ON CONFLICT(owner_user_id,instance_id,creation_request_id) DO NOTHING
      RETURNING id,name,workspace_ids_json,actions_json,creation_request_id,revision,created_at,updated_at`,
    [id, manager.userId, manager.instanceId, parsed.name, JSON.stringify(parsed.workspaceIds), JSON.stringify(parsed.actions), parsed.requestId, now]) as IntegrationRow | undefined;
    if (!row) {
      const duplicate = await database.get(`SELECT id FROM canvas_api_integrations
        WHERE owner_user_id=$1 AND instance_id=$2 AND creation_request_id=$3`,
      [manager.userId, manager.instanceId, parsed.requestId]) as { id: string };
      alreadyIssued(duplicate.id);
    }
    const issued = await insertCredential(database, manager, id, parsed.requestId, parsed.expiresAt);
    return { integration: await readIntegrationMetadata(database, row), ...issued };
  });
}

export async function listApiIntegrations(headers: Headers, input: unknown = {}) {
  const page = apiIntegrationPageSchema.parse(input);
  return withManager(headers, async (database, manager) => {
    const rows = await database.all(`SELECT integration.*,row_to_json(credential) AS latest_credential FROM (
      SELECT id,name,workspace_ids_json,actions_json,creation_request_id,revision,created_at,updated_at
      FROM canvas_api_integrations WHERE owner_user_id=$1 AND instance_id=$2 AND ($3::text IS NULL OR id>$3)
        AND ($5::text IS NULL OR creation_request_id=$5)
      ORDER BY id LIMIT $4
    ) integration LEFT JOIN LATERAL (
      SELECT ${credentialColumns} FROM canvas_api_keys WHERE integration_id=integration.id
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) credential ON true ORDER BY integration.id`,
    [manager.userId, manager.instanceId, page.afterId ?? null, page.limit + 1, page.creationRequestId ?? null]) as (IntegrationRow & { latest_credential: CredentialRow | null })[];
    const selected = rows.slice(0, page.limit);
    return { integrations: selected.map(row => integrationMetadata(row, row.latest_credential)),
      nextCursor: rows.length > page.limit ? selected.at(-1)!.id : null };
  });
}

export async function listApiIntegrationCredentials(headers: Headers, id: string, input: unknown = {}) {
  const page = apiCredentialPageSchema.parse(input);
  return withManager(headers, async (database, manager) => {
    const integration = await ownedIntegration(database, manager, id);
    const rows = await database.all(`SELECT ${credentialColumns} FROM canvas_api_keys
      WHERE integration_id=$1 AND ($2::text IS NULL OR id>$2)
        AND ($4::text IS NULL OR issuance_request_id=$4) ORDER BY id LIMIT $3`,
    [id, page.afterId ?? null, page.limit + 1, page.issuanceRequestId ?? null]) as CredentialRow[];
    const selected = rows.slice(0, page.limit);
    return { integration: await readIntegrationMetadata(database, integration), credentials: selected.map(credentialMetadata),
      nextCursor: rows.length > page.limit ? selected.at(-1)!.id : null };
  });
}

export async function updateApiIntegration(headers: Headers, id: string, input: unknown) {
  const parsed = updateApiIntegrationSchema.parse(input);
  return withManager(headers, async (database, manager) => {
    const row = await ownedIntegration(database, manager, id);
    requireRevision(row, parsed.expectedRevision);
    await requireGrant(database, manager, parsed);
    const updated = await database.get(`UPDATE canvas_api_integrations SET name=$2,workspace_ids_json=$3,actions_json=$4,
      revision=revision+1,updated_at=$5 WHERE id=$1
      RETURNING id,name,workspace_ids_json,actions_json,creation_request_id,revision,created_at,updated_at`,
    [id, parsed.name, JSON.stringify(parsed.workspaceIds), JSON.stringify(parsed.actions), Date.now()]) as IntegrationRow;
    return { integration: await readIntegrationMetadata(database, updated) };
  });
}

export async function rotateApiKey(headers: Headers, id: string, input: unknown) {
  const parsed = rotateApiKeySchema.parse(input);
  return withManager(headers, async (database, manager) => {
    const row = await ownedIntegration(database, manager, id);
    const prior = await database.get('SELECT id FROM canvas_api_keys WHERE integration_id=$1 AND issuance_request_id=$2',
      [id, parsed.requestId]);
    if (prior) alreadyIssued(id);
    requireRevision(row, parsed.expectedRevision);
    requireExpiry(parsed.expiresAt);
    await requireGrant(database, manager, storedGrant(row));
    const now = Date.now();
    await database.run('UPDATE canvas_api_keys SET revoked_at=$2 WHERE integration_id=$1 AND revoked_at IS NULL', [id, now]);
    const issued = await insertCredential(database, manager, id, parsed.requestId, parsed.expiresAt);
    await database.run('UPDATE canvas_api_integrations SET revision=revision+1,updated_at=$2 WHERE id=$1', [id, now]);
    return { integration: await readIntegrationMetadata(database, { ...row, revision: Number(row.revision) + 1, updated_at: now }), ...issued };
  });
}

export async function revokeApiKey(headers: Headers, id: string, input: unknown) {
  const parsed = revokeApiKeySchema.parse(input);
  return withManager(headers, async (database, manager) => {
    const row = await ownedIntegration(database, manager, id);
    requireRevision(row, parsed.expectedRevision);
    const key = await database.get(`SELECT ${credentialColumns} FROM canvas_api_keys WHERE integration_id=$1 AND id=$2`,
      [id, parsed.credentialId]) as CredentialRow | undefined;
    if (!key) throw new ApiKeyAccessError('API_KEY_NOT_FOUND', 'Credential not found.', 404);
    if (key.revoked_at == null) {
      const now = Date.now();
      await database.run('UPDATE canvas_api_keys SET revoked_at=$2 WHERE id=$1', [key.id, now]);
      await database.run('UPDATE canvas_api_integrations SET revision=revision+1,updated_at=$2 WHERE id=$1', [id, now]);
      row.revision = Number(row.revision) + 1; row.updated_at = now;
    }
    return { integration: await readIntegrationMetadata(database, row) };
  });
}
