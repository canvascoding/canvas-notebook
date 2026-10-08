import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { IntegrationConnectionError, type AuthorizedIntegrationConnection, type IntegrationConnectionRevisions } from '@/app/lib/integration-tools/connections/contracts';
import { authorizeIntegrationConnection, publishIntegrationConnectionBinding, validateIntegrationConnectionRef, withAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { openMcpSecret, sealMcpSecret, type McpSecretBinding } from '@/app/lib/mcp/secret-store';
import { resolveAuthorizedComposioConnectionContext } from './composio-shared-context';
import { sharedComposioCredentialRevision } from './composio-shared-backend';
import { linkPreparedSharedComposioOAuthProvider, prepareSharedComposioOAuthProviderStart, verifySharedComposioOAuthAccount, type PreparedSharedComposioOAuthProviderStart } from './composio-shared-connections';
import { deriveSharedComposioDesktopOAuthState, parseSharedComposioDesktopInitiator, parseSharedComposioDesktopOAuthSnapshot,
  sharedComposioDesktopActorFingerprint, sharedComposioDesktopSessionFingerprint, sharedComposioDesktopSnapshotFingerprint, sharedComposioDesktopStateHash,
  type SharedComposioDesktopInitiator, type SharedComposioDesktopOAuthSnapshot, type SharedComposioDesktopOAuthSummary } from './composio-shared-desktop-oauth-contract';

const FLOW_TABLE = 'composio_shared_desktop_oauth_transactions';
const COMMIT_TABLE = 'composio_shared_desktop_oauth_commits';
const CANCELLATION_TABLE = 'composio_shared_desktop_oauth_cancellations';
const PURPOSE = 'shared-composio-desktop-snapshot-v1';
const TTL = 15 * 60_000;
const RETENTION = 60 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const rowSchema = z.object({
  state_hash: digest, contract_version: z.literal(1), connection_ref: z.string(), initiating_user_id: z.string(),
  ownership_type: z.enum(['organization', 'team']), organization_id: z.string(), owner_workspace_id: z.string().nullable(),
  actor_hash: digest, auth_session_hash: digest, snapshot_hash: digest, sealed_snapshot: z.string().min(1).max(65_536),
  authorization_url_hash: digest.nullable(), status: z.enum(['starting', 'waiting', 'callback_received', 'completed', 'cancelled', 'expired', 'failed']),
  created_at: epoch, expires_at: epoch, updated_at: epoch, callback_received_at: epoch.nullable(), terminal_at: epoch.nullable(),
  terminal_code: z.enum(['CONNECTION_DESKTOP_OAUTH_CANCELLED', 'CONNECTION_DESKTOP_OAUTH_EXPIRED', 'CONNECTION_DESKTOP_OAUTH_FAILED']).nullable(),
}).strict().refine(row => row.expires_at > row.created_at
  && (row.ownership_type === 'team' ? row.owner_workspace_id !== null : row.owner_workspace_id === null));
type FlowRow = z.infer<typeof rowSchema>;
const cancellationSchema = z.object({
  state_hash: digest, connection_ref: z.string(), initiating_user_id: z.string(), actor_hash: digest, auth_session_hash: digest,
  metadata_revision: epoch, grants_revision: epoch, binding_revision: epoch, created_at: epoch, expires_at: epoch,
}).strict().refine(row => row.expires_at > row.created_at);
type CancellationRow = z.infer<typeof cancellationSchema>;
type HeldFlow = { row: FlowRow; snapshot: SharedComposioDesktopOAuthSnapshot; authorization: AuthorizedIntegrationConnection;
  context: Awaited<ReturnType<typeof resolveAuthorizedComposioConnectionContext>>; database: SqlConnection };

function fail(code: string, message: string, status = 409): never { throw new IntegrationConnectionError(code, message, status); }
function parseRow(value: unknown): FlowRow {
  if (!value) fail('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'This shared app sign-in is unavailable.', 404);
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) fail('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'The shared app sign-in record is invalid.');
  return parsed.data;
}
function secretBinding(row: Pick<FlowRow, 'state_hash' | 'connection_ref' | 'ownership_type' | 'organization_id' | 'owner_workspace_id' | 'initiating_user_id'>): McpSecretBinding {
  return { ownerUserId: row.initiating_user_id, connectionId: row.state_hash, purpose: PURPOSE,
    shared: { connectionRef: row.connection_ref, ownership: row.ownership_type === 'team'
      ? { type: 'team', organizationId: row.organization_id, workspaceId: row.owner_workspace_id! }
      : { type: 'organization', organizationId: row.organization_id } } };
}
function assertInitiator(row: Pick<FlowRow, 'connection_ref' | 'initiating_user_id' | 'actor_hash' | 'auth_session_hash'>,
  initiator: SharedComposioDesktopInitiator, ref: string): void {
  if (row.connection_ref !== ref || row.initiating_user_id !== initiator.actor.userId
    || row.actor_hash !== sharedComposioDesktopActorFingerprint(initiator.actor)
    || row.auth_session_hash !== sharedComposioDesktopSessionFingerprint(initiator.authSessionId)) {
    fail('CONNECTION_ACCESS_DENIED', 'This shared app sign-in belongs to another manager session or context.', 403);
  }
}
async function assertSession(database: SqlConnection, initiator: SharedComposioDesktopInitiator): Promise<void> {
  const row = await database.get('SELECT user_id,expires_at FROM "session" WHERE id=$1 FOR SHARE', [initiator.authSessionId]) as Record<string, unknown> | undefined;
  if (!row || row.user_id !== initiator.actor.userId || !Number.isSafeInteger(Number(row.expires_at)) || Number(row.expires_at) <= Date.now()) {
    fail('CONNECTION_ACCESS_DENIED', 'The original shared app sign-in session is no longer active.', 403);
  }
}
async function lockProfile(context: HeldFlow['context'], database: SqlConnection): Promise<void> {
  const row = await database.get('SELECT * FROM composio_connection_profiles WHERE id=$1 FOR SHARE', [context.profileId]) as Record<string, unknown> | undefined;
  const ownership = context.profileOwnership;
  if (!row || !ownership || row.owner_user_id !== null || row.status !== 'active' || row.provider_mode !== context.providerMode
    || row.composio_user_id !== context.composioUserId || Number(row.profile_revision) !== context.sharedBinding?.profileRevision
    || row.organization_id !== ownership.organizationId || row.scope_type !== (ownership.type === 'team' ? 'workspace' : 'organization')
    || (row.workspace_id ?? null) !== (ownership.type === 'team' ? ownership.workspaceId : null)) {
    fail('binding_changed', 'The shared app profile changed. Reload the connection.');
  }
}
async function readRow(state: string, database?: SqlConnection, lock = false): Promise<FlowRow> {
  const stateHash = sharedComposioDesktopStateHash(state);
  const lease = database ?? await openDb();
  try { return parseRow(await lease.get(`SELECT * FROM ${FLOW_TABLE} WHERE state_hash=$1${lock ? ' FOR UPDATE' : ''}`, [stateHash])); }
  finally { if (!database) await lease.close(); }
}
async function openSnapshot(row: FlowRow): Promise<SharedComposioDesktopOAuthSnapshot> {
  const snapshot = parseSharedComposioDesktopOAuthSnapshot(await openMcpSecret(row.sealed_snapshot, secretBinding(row)));
  if (sharedComposioDesktopSnapshotFingerprint(snapshot) !== row.snapshot_hash
    || snapshot.connectionRef !== row.connection_ref || !isDeepStrictEqual(snapshot.ownership, secretBinding(row).shared!.ownership)
    || snapshot.initiator.actor.userId !== row.initiating_user_id || sharedComposioDesktopActorFingerprint(snapshot.initiator.actor) !== row.actor_hash
    || sharedComposioDesktopSessionFingerprint(snapshot.initiator.authSessionId) !== row.auth_session_hash
    || (snapshot.authorizationUrl ? hash(snapshot.authorizationUrl) : null) !== row.authorization_url_hash) {
    fail('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'The shared app sign-in snapshot changed.');
  }
  return snapshot;
}
function summary(row: FlowRow, state: string, snapshot?: SharedComposioDesktopOAuthSnapshot): SharedComposioDesktopOAuthSummary {
  const identity = { connectionRef: row.connection_ref, state, expiresAt: new Date(row.expires_at).toISOString() };
  if (row.status === 'waiting') {
    if (!snapshot?.authorizationUrl || !snapshot.pendingAccountId) fail('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'The shared app sign-in has no confirmed provider result.');
    return { ...identity, status: 'waiting', authorizationUrl: snapshot.authorizationUrl };
  }
  if (row.status === 'cancelled') return { ...identity, status: 'cancelled', code: 'CONNECTION_DESKTOP_OAUTH_CANCELLED', error: 'Shared sign-in was cancelled.' };
  if (row.status === 'expired') return { ...identity, status: 'expired', code: 'CONNECTION_DESKTOP_OAUTH_EXPIRED', error: 'Shared sign-in expired. Start again.' };
  if (row.status === 'failed') return { ...identity, status: 'failed', code: 'CONNECTION_DESKTOP_OAUTH_FAILED', error: 'Shared sign-in could not be completed. Reload and start again.' };
  if (row.status === 'starting') return { ...identity, status: 'starting', code: 'CONNECTION_DESKTOP_OAUTH_START_UNCONFIRMED', error: 'Shared sign-in start is unconfirmed. Reload and check this sign-in.' };
  return { ...identity, status: row.status };
}
async function finish(database: SqlConnection, row: FlowRow, status: 'completed' | 'cancelled' | 'expired' | 'failed'): Promise<void> {
  const code = status === 'completed' ? null : status === 'cancelled' ? 'CONNECTION_DESKTOP_OAUTH_CANCELLED'
    : status === 'expired' ? 'CONNECTION_DESKTOP_OAUTH_EXPIRED' : 'CONNECTION_DESKTOP_OAUTH_FAILED';
  const now = Date.now();
  await database.run(`UPDATE ${FLOW_TABLE} SET status=$1,terminal_code=$2,terminal_at=$3,updated_at=$3 WHERE state_hash=$4`, [status, code, now, row.state_hash]);
  Object.assign(row, { status, terminal_code: code, terminal_at: now, updated_at: now });
}
async function expire(database: SqlConnection, row: FlowRow): Promise<void> {
  if (['starting', 'waiting', 'callback_received'].includes(row.status) && row.expires_at <= Date.now()) await finish(database, row, 'expired');
}
function revisions(authorization: AuthorizedIntegrationConnection): IntegrationConnectionRevisions {
  const { metadataRevision, grantsRevision, bindingRevision } = authorization.resource;
  return { metadataRevision, grantsRevision, bindingRevision };
}
async function assertCurrent(held: HeldFlow, initiator: SharedComposioDesktopInitiator, published = false): Promise<void> {
  const { snapshot, authorization, context } = held;
  if (!published && held.row.expires_at <= Date.now()) fail('CONNECTION_DESKTOP_OAUTH_EXPIRED', 'Shared sign-in expired. Start again.');
  const backend = authorization.backend;
  const expected = published ? { ...snapshot.backend, accountBinding: 'account', connectedAccountId: snapshot.pendingAccountId } : snapshot.backend;
  const expectedRevisions = { ...snapshot.revisions, bindingRevision: snapshot.revisions.bindingRevision + (published ? 1 : 0) };
  if (backend.source !== 'composio' || !isDeepStrictEqual(backend, expected)
    || !isDeepStrictEqual(authorization.resource.ownership, snapshot.ownership) || !isDeepStrictEqual(revisions(authorization), expectedRevisions)
    || (!published && authorization.authorizationRevision !== snapshot.authorizationRevision)
    || context.profileId !== snapshot.backend.profileId || context.providerMode !== snapshot.backend.mode
    || context.composioUserId !== snapshot.composioUserId || context.sharedBinding?.profileRevision !== snapshot.profileRevision
    || await sharedComposioCredentialRevision(context) !== snapshot.credentialRevision) {
    fail('binding_changed', 'The shared app sign-in binding or provider configuration changed.');
  }
  await assertSession(held.database, initiator);
}
async function withFlow(input: SharedComposioDesktopInitiator, reference: string, state: string,
  operation: (held: HeldFlow, initiator: SharedComposioDesktopInitiator) => Promise<SharedComposioDesktopOAuthSummary>): Promise<SharedComposioDesktopOAuthSummary> {
  const initiator = parseSharedComposioDesktopInitiator(input), ref = validateIntegrationConnectionRef(reference);
  const stateHash = sharedComposioDesktopStateHash(state);
  return withAuthorizedIntegrationConnection(initiator.actor, ref, 'manage', undefined, async (authorization, database) => {
    await assertSession(database, initiator);
    const context = await resolveAuthorizedComposioConnectionContext(authorization, database); await lockProfile(context, database);
    const value = await database.get(`SELECT * FROM ${FLOW_TABLE} WHERE state_hash=$1 FOR UPDATE`, [stateHash]);
    if (!value) {
      const cancelled = await readCancellation(database, stateHash);
      if (!cancelled) fail('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'This shared app sign-in is unavailable.', 404);
      assertInitiator(cancelled, initiator, ref); await assertSession(database, initiator); return cancellationSummary(cancelled, state);
    }
    const row = parseRow(value); assertInitiator(row, initiator, ref);
    const snapshot = await openSnapshot(row);
    await expire(database, row);
    const result = await operation({ row, snapshot, authorization, context, database }, initiator);
    await assertSession(database, initiator); return result;
  });
}
function callbackUrl(state: string): string {
  const configured = process.env.BASE_URL || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`;
  const url = new URL('/api/composio/shared/desktop/callback', configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('invalid_request', 'The app return origin is invalid.', 400);
  url.searchParams.set('flow', state); return url.toString();
}

function captureExpectedIntent(expected: IntegrationConnectionRevisions & { intent: string }) {
  const captured = z.object({ metadataRevision: epoch, grantsRevision: epoch, bindingRevision: epoch,
    intent: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u) }).strict().parse(structuredClone(expected));
  return { intent: captured.intent, requested: { metadataRevision: captured.metadataRevision,
    grantsRevision: captured.grantsRevision, bindingRevision: captured.bindingRevision } };
}
async function readCancellation(database: SqlConnection, stateHash: string): Promise<CancellationRow | undefined> {
  const value = await database.get(`SELECT * FROM ${CANCELLATION_TABLE} WHERE state_hash=$1 FOR UPDATE`, [stateHash]);
  if (!value) return undefined;
  const parsed = cancellationSchema.safeParse(value);
  if (!parsed.success) fail('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'The shared app cancellation record is invalid.');
  return parsed.data;
}
function cancellationSummary(row: CancellationRow, state: string): SharedComposioDesktopOAuthSummary {
  return { connectionRef: row.connection_ref, state, expiresAt: new Date(row.expires_at).toISOString(), status: 'cancelled',
    code: 'CONNECTION_DESKTOP_OAUTH_CANCELLED', error: 'Shared sign-in was cancelled.' };
}
async function persistCancellation(database: SqlConnection, row: CancellationRow): Promise<void> {
  const existing = await readCancellation(database, row.state_hash);
  if (existing) {
    const identity = (value: CancellationRow) => ({ ...value, created_at: undefined, expires_at: undefined });
    if (!isDeepStrictEqual(identity(existing), identity(row))) fail('binding_changed', 'The original shared app cancellation changed.');
    return;
  }
  await database.run(`INSERT INTO ${CANCELLATION_TABLE} (state_hash,connection_ref,initiating_user_id,actor_hash,auth_session_hash,
    metadata_revision,grants_revision,binding_revision,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, Object.values(row));
}

/** A durable starting row is acknowledged before the single-use account-link mutation. */
export async function startSharedComposioDesktopOAuth(input: SharedComposioDesktopInitiator, reference: string,
  expected: IntegrationConnectionRevisions & { intent: string }): Promise<SharedComposioDesktopOAuthSummary | { connectionRef: string; noAuth: true }> {
  const initiator = parseSharedComposioDesktopInitiator(input), ref = validateIntegrationConnectionRef(reference);
  const { intent, requested } = captureExpectedIntent(expected);
  const state = deriveSharedComposioDesktopOAuthState(intent, initiator, ref), stateHash = sharedComposioDesktopStateHash(state);
  let preparation: PreparedSharedComposioOAuthProviderStart | undefined;
  const first = await withAuthorizedIntegrationConnection<SharedComposioDesktopOAuthSummary | { connectionRef: string; noAuth: true }>(initiator.actor, ref, 'manage', undefined, async (authorization, database) => {
    await assertSession(database, initiator);
    const context = await resolveAuthorizedComposioConnectionContext(authorization, database); await lockProfile(context, database);
    const existing = await database.get(`SELECT * FROM ${FLOW_TABLE} WHERE state_hash=$1 FOR UPDATE`, [stateHash]);
    if (existing) {
      const row = parseRow(existing); assertInitiator(row, initiator, ref); const snapshot = await openSnapshot(row);
      if (!isDeepStrictEqual(snapshot.revisions, requested)) fail('binding_changed', 'The original shared app start revisions must be retained.');
      await expire(database, row);
      const held = { row, snapshot, authorization, context, database };
      if (row.status === 'completed') await verifyCommit(held, initiator);
      else if (['starting', 'waiting', 'callback_received'].includes(row.status)) await assertCurrent(held, initiator);
      return summary(row, state, snapshot);
    }
    const cancelled = await readCancellation(database, stateHash);
    if (cancelled) {
      assertInitiator(cancelled, initiator, ref);
      if (!isDeepStrictEqual({ metadataRevision: cancelled.metadata_revision, grantsRevision: cancelled.grants_revision,
        bindingRevision: cancelled.binding_revision }, requested)) fail('binding_changed', 'The original shared app start revisions must be retained.');
      await assertSession(database, initiator);
      return cancellationSummary(cancelled, state);
    }
    if (!isDeepStrictEqual(revisions(authorization), requested)) fail('CONNECTION_REVISION_CONFLICT', 'This connection changed. Reload its current binding and permissions.');
    // All creators acquire the same user lock after common/session/profile locks.
    await database.get('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`shared-composio-desktop:${initiator.actor.userId}`]);
    await database.run(`DELETE FROM ${FLOW_TABLE} WHERE initiating_user_id=$1 AND expires_at<$2`, [initiator.actor.userId, Date.now() - RETENTION]);
    const count = await database.get(`SELECT COUNT(*)::integer AS count FROM ${FLOW_TABLE} WHERE initiating_user_id=$1
      AND status IN ('starting','waiting','callback_received') AND expires_at>$2`, [initiator.actor.userId, Date.now()]) as { count: number };
    if (count.count >= 8) fail('CONNECTION_DESKTOP_OAUTH_BUSY', 'Finish or cancel a pending shared app sign-in first.', 429);
    preparation = await prepareSharedComposioOAuthProviderStart(context, database);
    await assertSession(database, initiator);
    if (preparation.noAuth) {
      if (authorization.backend.source !== 'composio' || await sharedComposioCredentialRevision(context) !== preparation.credentialRevision) {
        fail('binding_changed', 'The shared app provider configuration changed.');
      }
      await assertSession(database, initiator);
      await publishIntegrationConnectionBinding(initiator.actor, ref, requested, { ...authorization.backend, accountBinding: 'no_auth', connectedAccountId: null });
      return { connectionRef: ref, noAuth: true as const };
    }
    const backend = authorization.backend; if (backend.source !== 'composio') fail('invalid_request', 'A shared app connection is required.', 400);
    const snapshot = parseSharedComposioDesktopOAuthSnapshot({ contractVersion: 1, initiator, connectionRef: ref, ownership: authorization.resource.ownership,
      revisions: requested, authorizationRevision: authorization.authorizationRevision, backend, profileRevision: context.sharedBinding!.profileRevision,
      composioUserId: context.composioUserId, credentialRevision: preparation.credentialRevision, pendingAccountId: null, authorizationUrl: null });
    const now = Date.now(), owner = snapshot.ownership;
    const row: FlowRow = { state_hash: stateHash, contract_version: 1, connection_ref: ref, initiating_user_id: initiator.actor.userId,
      ownership_type: owner.type, organization_id: owner.organizationId, owner_workspace_id: owner.type === 'team' ? owner.workspaceId : null,
      actor_hash: sharedComposioDesktopActorFingerprint(initiator.actor), auth_session_hash: sharedComposioDesktopSessionFingerprint(initiator.authSessionId),
      snapshot_hash: sharedComposioDesktopSnapshotFingerprint(snapshot), sealed_snapshot: '', authorization_url_hash: null,
      status: 'starting', created_at: now, expires_at: now + TTL, updated_at: now, callback_received_at: null, terminal_at: null, terminal_code: null };
    row.sealed_snapshot = await sealMcpSecret(snapshot, secretBinding(row));
    await assertSession(database, initiator);
    await database.run(`INSERT INTO ${FLOW_TABLE} (state_hash,contract_version,connection_ref,initiating_user_id,ownership_type,organization_id,owner_workspace_id,
      actor_hash,auth_session_hash,snapshot_hash,sealed_snapshot,authorization_url_hash,status,created_at,expires_at,updated_at,callback_received_at,terminal_at,terminal_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, Object.values(row));
    return summary(row, state);
  });
  if ('noAuth' in first || !preparation) return first;
  const prepared = preparation;
  return withFlow(initiator, ref, state, async (held, original) => {
    if (held.row.status !== 'starting') return summary(held.row, state, held.snapshot);
    await assertCurrent(held, original);
    const result = await linkPreparedSharedComposioOAuthProvider(prepared, callbackUrl(state), { database: held.database, assertAuthorization: () => assertSession(held.database, original) });
    await assertCurrent(held, original);
    const snapshot = parseSharedComposioDesktopOAuthSnapshot({ ...held.snapshot, pendingAccountId: result.pendingAccountId, authorizationUrl: result.redirectUrl });
    const sealed = await sealMcpSecret(snapshot, secretBinding(held.row));
    await assertSession(held.database, original);
    const now = Date.now();
    await held.database.run(`UPDATE ${FLOW_TABLE} SET sealed_snapshot=$1,snapshot_hash=$2,authorization_url_hash=$3,status='waiting',updated_at=$4 WHERE state_hash=$5`,
      [sealed, sharedComposioDesktopSnapshotFingerprint(snapshot), hash(result.redirectUrl), now, held.row.state_hash]);
    Object.assign(held.row, { sealed_snapshot: sealed, snapshot_hash: sharedComposioDesktopSnapshotFingerprint(snapshot), authorization_url_hash: hash(result.redirectUrl), status: 'waiting', updated_at: now });
    return summary(held.row, state, snapshot);
  });
}

/** Anonymous collection performs bounded SQL only, and cannot publish or select an account. */
export async function collectSharedComposioDesktopOAuthCallback(state: string, providerError?: string | null): Promise<void> {
  sharedComposioDesktopStateHash(state);
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const row = await readRow(state, database, true); await expire(database, row);
    if (['starting', 'waiting'].includes(row.status)) {
      if (providerError) await finish(database, row, providerError === 'access_denied' ? 'cancelled' : 'failed');
      else {
        const now = Date.now();
        await database.run(`UPDATE ${FLOW_TABLE} SET status='callback_received',callback_received_at=$1,updated_at=$1 WHERE state_hash=$2`, [now, row.state_hash]);
      }
    }
    await database.run('COMMIT');
  } catch (error) { try { await database.run('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
  finally { await database.close(); }
}

function commitProof(held: HeldFlow, post: AuthorizedIntegrationConnection): Record<string, string | number> {
  const { snapshot, row } = held;
  if (!snapshot.pendingAccountId || post.backend.source !== 'composio' || post.backend.connectedAccountId !== snapshot.pendingAccountId
    || post.backend.accountBinding !== 'account' || post.resource.bindingRevision !== snapshot.revisions.bindingRevision + 1) {
    fail('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'The shared app publication proof is invalid.');
  }
  return { state_hash: row.state_hash, snapshot_hash: row.snapshot_hash, actor_hash: row.actor_hash, auth_session_hash: row.auth_session_hash,
    connection_ref: row.connection_ref, initiating_user_id: row.initiating_user_id, profile_id_hash: hash(snapshot.backend.profileId),
    composio_user_id_hash: hash(snapshot.composioUserId), pending_account_hash: hash(snapshot.pendingAccountId), authorization_url_hash: hash(snapshot.authorizationUrl!), profile_revision: snapshot.profileRevision,
    toolkit: snapshot.backend.toolkit, provider_mode: snapshot.backend.mode, credential_revision: snapshot.credentialRevision,
    pre_metadata_revision: snapshot.revisions.metadataRevision, pre_grants_revision: snapshot.revisions.grantsRevision, pre_binding_revision: snapshot.revisions.bindingRevision,
    published_binding_revision: post.resource.bindingRevision, pre_authorization_revision: snapshot.authorizationRevision, post_authorization_revision: post.authorizationRevision };
}
async function verifyCommit(held: HeldFlow, initiator: SharedComposioDesktopInitiator): Promise<void> {
  await assertCurrent(held, initiator, true);
  const receipt = await held.database.get(`SELECT * FROM ${COMMIT_TABLE} WHERE state_hash=$1`, [held.row.state_hash]) as Record<string, unknown> | undefined;
  const expected = commitProof(held, held.authorization);
  if (!receipt || Object.entries(expected).some(([key, value]) => receipt[key] !== value)
    || !Number.isSafeInteger(Number(receipt.committed_at)) || Number(receipt.committed_at) < held.row.created_at
    || held.row.terminal_at !== Number(receipt.committed_at)) {
    fail('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'The shared app same-flow publication proof is unavailable.');
  }
  await verifySharedComposioOAuthAccount(held.context, held.snapshot.pendingAccountId!, held.snapshot.credentialRevision, held.database,
    { assertAuthorization: () => assertSession(held.database, initiator) });
  await assertCurrent(held, initiator, true);
}
export async function getSharedComposioDesktopOAuthStatus(initiator: SharedComposioDesktopInitiator, ref: string, state: string): Promise<SharedComposioDesktopOAuthSummary> {
  return withFlow(initiator, ref, state, async (held, original) => {
    if (held.row.status === 'completed') await verifyCommit(held, original);
    else if (['starting', 'waiting', 'callback_received'].includes(held.row.status)) await assertCurrent(held, original);
    return summary(held.row, state, held.snapshot);
  });
}
export async function finalizeSharedComposioDesktopOAuth(initiator: SharedComposioDesktopInitiator, ref: string, state: string): Promise<SharedComposioDesktopOAuthSummary> {
  return withFlow(initiator, ref, state, async (held, original) => {
    if (held.row.status === 'completed') { await verifyCommit(held, original); return summary(held.row, state); }
    if (['cancelled', 'expired', 'failed'].includes(held.row.status)) return summary(held.row, state);
    await assertCurrent(held, original);
    if (!held.snapshot.pendingAccountId || !held.snapshot.authorizationUrl) fail('outcome_unknown', 'The app provider start was not confirmed. Cancel this sign-in before starting again.');
    if (held.row.status !== 'callback_received') fail('auth_required', 'Finish the shared app sign-in in the system browser first.');
    await verifySharedComposioOAuthAccount(held.context, held.snapshot.pendingAccountId, held.snapshot.credentialRevision, held.database,
      { assertAuthorization: () => assertSession(held.database, original) });
    await assertCurrent(held, original);
    await publishIntegrationConnectionBinding(original.actor, ref, held.snapshot.revisions,
      { ...held.snapshot.backend, accountBinding: 'account', connectedAccountId: held.snapshot.pendingAccountId });
    const post = await authorizeIntegrationConnection(original.actor, ref, 'manage');
    const proof = commitProof(held, post), now = Date.now();
    await assertCurrent({ ...held, authorization: post }, original, true);
    await assertSession(held.database, original);
    const columns = [...Object.keys(proof), 'committed_at'];
    await held.database.run(`INSERT INTO ${COMMIT_TABLE} (${columns.join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, [...Object.values(proof), now]);
    await held.database.run(`UPDATE ${FLOW_TABLE} SET status='completed',terminal_code=NULL,terminal_at=$1,updated_at=$1 WHERE state_hash=$2`, [now, held.row.state_hash]);
    Object.assign(held.row, { status: 'completed', terminal_code: null, terminal_at: now, updated_at: now });
    await assertSession(held.database, original);
    return summary(held.row, state);
  });
}
export async function cancelSharedComposioDesktopOAuth(initiator: SharedComposioDesktopInitiator, ref: string, state: string): Promise<SharedComposioDesktopOAuthSummary> {
  return withFlow(initiator, ref, state, (held, original) => cancelHeldFlow(held, original, state));
}

async function cancelHeldFlow(held: HeldFlow, original: SharedComposioDesktopInitiator, state: string): Promise<SharedComposioDesktopOAuthSummary> {
  if (held.row.status === 'completed') await verifyCommit(held, original);
  else {
    await assertSession(held.database, original);
    if (['starting', 'waiting', 'callback_received'].includes(held.row.status)) await finish(held.database, held.row, 'cancelled');
    const row = held.row;
    await persistCancellation(held.database, { state_hash: row.state_hash, connection_ref: row.connection_ref,
      initiating_user_id: row.initiating_user_id, actor_hash: row.actor_hash, auth_session_hash: row.auth_session_hash,
      metadata_revision: held.snapshot.revisions.metadataRevision, grants_revision: held.snapshot.revisions.grantsRevision,
      binding_revision: held.snapshot.revisions.bindingRevision, created_at: row.created_at, expires_at: row.expires_at });
  }
  await assertSession(held.database, original);
  return summary(held.row, state);
}

/** Intent recovery uses the same held resource/session/profile locks as start. Never relinks an account. */
async function withIntentFlow(input: SharedComposioDesktopInitiator, reference: string, intent: string,
  requested?: IntegrationConnectionRevisions): Promise<SharedComposioDesktopOAuthSummary> {
  const initiator = parseSharedComposioDesktopInitiator(input), ref = validateIntegrationConnectionRef(reference);
  const state = deriveSharedComposioDesktopOAuthState(intent, initiator, ref), stateHash = sharedComposioDesktopStateHash(state);
  return withAuthorizedIntegrationConnection(initiator.actor, ref, 'manage', undefined, async (authorization, database) => {
    await assertSession(database, initiator);
    const context = await resolveAuthorizedComposioConnectionContext(authorization, database); await lockProfile(context, database);
    const value = await database.get(`SELECT * FROM ${FLOW_TABLE} WHERE state_hash=$1 FOR UPDATE`, [stateHash]);
    if (value) {
      const row = parseRow(value); assertInitiator(row, initiator, ref);
      const snapshot = await openSnapshot(row);
      if (requested && !isDeepStrictEqual(snapshot.revisions, requested)) fail('binding_changed', 'The original shared app start revisions must be retained.');
      await expire(database, row);
      const held = { row, snapshot, authorization, context, database };
      if (requested) return cancelHeldFlow(held, initiator, state);
      if (row.status === 'completed') await verifyCommit(held, initiator);
      else if (['starting', 'waiting', 'callback_received'].includes(row.status)) await assertCurrent(held, initiator);
      await assertSession(database, initiator);
      return summary(row, state, snapshot);
    }
    const existing = await readCancellation(database, stateHash);
    if (existing) {
      assertInitiator(existing, initiator, ref);
      if (requested && !isDeepStrictEqual({ metadataRevision: existing.metadata_revision, grantsRevision: existing.grants_revision,
        bindingRevision: existing.binding_revision }, requested)) fail('binding_changed', 'The original shared app start revisions must be retained.');
      await assertSession(database, initiator);
      return cancellationSummary(existing, state);
    }
    if (!requested) fail('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'This shared app sign-in is unavailable.', 404);
    if (!isDeepStrictEqual(revisions(authorization), requested)) fail('CONNECTION_REVISION_CONFLICT', 'This connection changed. Reload its current binding and permissions.');
    const now = Date.now();
    const cancelled: CancellationRow = { state_hash: stateHash, connection_ref: ref, initiating_user_id: initiator.actor.userId,
      actor_hash: sharedComposioDesktopActorFingerprint(initiator.actor), auth_session_hash: sharedComposioDesktopSessionFingerprint(initiator.authSessionId),
      metadata_revision: requested.metadataRevision, grants_revision: requested.grantsRevision, binding_revision: requested.bindingRevision,
      created_at: now, expires_at: now + TTL };
    await assertSession(database, initiator);
    await persistCancellation(database, cancelled);
    await assertSession(database, initiator);
    // Retain the marker with its resource: even a very late queued start must stay cancelled.
    return cancellationSummary(cancelled, state);
  });
}

export async function getSharedComposioDesktopOAuthStatusByIntent(initiator: SharedComposioDesktopInitiator, ref: string,
  intent: string): Promise<SharedComposioDesktopOAuthSummary> {
  return withIntentFlow(initiator, ref, intent);
}
export async function cancelSharedComposioDesktopOAuthIntent(initiator: SharedComposioDesktopInitiator, ref: string,
  expected: IntegrationConnectionRevisions & { intent: string }): Promise<SharedComposioDesktopOAuthSummary> {
  const { intent, requested } = captureExpectedIntent(expected);
  return withIntentFlow(initiator, ref, intent, requested);
}
