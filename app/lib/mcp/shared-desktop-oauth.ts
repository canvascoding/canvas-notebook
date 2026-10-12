import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { SqlConnection } from '@/app/lib/db';
import { normalizeDatabaseTimestamp } from '@/app/lib/db/timestamps';
import { IntegrationConnectionError, type AuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/contracts';
import { authorizeIntegrationConnection, publishIntegrationConnectionBinding, validateIntegrationConnectionRef, withAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { readMcpCredentialJson, writeMcpCredentialJson } from './credential-storage';
import { readSharedMcpDesktopOAuthCommit, recordSharedMcpDesktopOAuthCommit } from './desktop-oauth-commit';
import { assertMcpDesktopOAuthSnapshot, collectSharedMcpDesktopOAuthState, completeStoredMcpOAuth, discardMcpDesktopOAuthState, getMcpOAuthStatus, type OAuthStateRecord, type OAuthTokenRecord } from './oauth';
import { closeMcpServer } from './manager';
import { sharedMcpScope } from './shared-access';
import { stageSharedMcpBindingPublication } from './shared-publication';
import { parseSharedMcpDesktopOAuthSnapshot, sharedMcpDesktopActorFingerprint, sharedMcpDesktopSessionFingerprint, sharedMcpDesktopSnapshotFingerprint,
  type SharedMcpDesktopInitiator, type SharedMcpDesktopOAuthSnapshot } from './shared-desktop-oauth-contract';
import { MCP_SYSTEM_SCOPE, requireMcpCredentialScope, type McpScope } from './scope';
import { removeMcpStoragePath, resolveMcpStoragePath } from './storage';
import { withMcpStorageLock } from './storage-lock';

const DIRECTORY = 'shared-desktop-oauth-transactions';
const MAX_PENDING = 8;
const TERMINAL_TTL = 60 * 60_000;
const STATE = /^desktop_[A-Za-z0-9_-]{32}$/u;
const STATUS = ['waiting', 'callback_received', 'completed', 'cancelled', 'expired', 'failed'] as const;
type Status = typeof STATUS[number];
const timestamp = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)));
const indexSchema = z.object({ connectionId: z.literal('shared-desktop-index'), organizationId: z.null(),
  states: z.array(z.object({ state: z.string().regex(STATE), expiresAt: timestamp }).strict()).max(MAX_PENDING)
    .refine(value => new Set(value.map(item => item.state)).size === value.length),
}).strict();
const transactionSchema = z.object({ version: z.literal(2), state: z.string().regex(STATE),
  target: z.object({ kind: z.literal('shared'), connectionRef: z.string() }).strict(),
  connectionId: z.string(), organizationId: z.string(), snapshot: z.unknown(),
  authorizationUrl: z.string().url().max(16_384), issuer: z.string().url().max(8192), requiresIssuer: z.boolean(),
  createdAt: timestamp, expiresAt: timestamp, status: z.enum(STATUS), exchangeAttempted: z.boolean(),
  code: z.enum(['CONNECTION_DESKTOP_OAUTH_CANCELLED', 'CONNECTION_DESKTOP_OAUTH_EXPIRED', 'CONNECTION_DESKTOP_OAUTH_FAILED']).optional(),
  response: z.object({ code: z.string().min(1).max(8192), stored: z.unknown() }).strict().optional(),
}).strict();
type Transaction = Omit<z.infer<typeof transactionSchema>, 'snapshot' | 'response'> & {
  snapshot: SharedMcpDesktopOAuthSnapshot; response?: { code: string; stored: OAuthStateRecord };
};
export type SharedMcpDesktopOAuthSummary = { connectionRef: string; state: string; status: Status; expiresAt: string;
  authorizationUrl?: string; code?: string; error?: string };

function transactionPath(state: string): string {
  if (!STATE.test(state)) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'The shared desktop sign-in state is invalid.', 400);
  return `${DIRECTORY}/${createHash('sha256').update(state).digest('hex')}.json`;
}
async function readTransaction(state: string, absent = false): Promise<Transaction | null> {
  const value = await readMcpCredentialJson<unknown>(transactionPath(state), MCP_SYSTEM_SCOPE);
  if (value === null && absent) return null;
  const parsed = transactionSchema.safeParse(value);
  if (!parsed.success) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'This shared desktop sign-in is unavailable.', 409);
  const snapshot = parseSharedMcpDesktopOAuthSnapshot(parsed.data.snapshot);
  if (parsed.data.state !== state || parsed.data.target.connectionRef !== snapshot.shared.connectionRef
    || parsed.data.connectionId !== snapshot.connectionId || parsed.data.organizationId !== snapshot.organizationId
    || Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.createdAt)) {
    throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'This shared desktop sign-in binding is invalid.', 409);
  }
  const response = parsed.data.response;
  if (response) {
    const stored = response.stored as OAuthStateRecord;
    if (!stored || stored.state !== state || stored.desktop !== true || sharedMcpDesktopSnapshotFingerprint(snapshot)
      !== sharedMcpDesktopSnapshotFingerprint(parseSharedMcpDesktopOAuthSnapshot({ connectionId: stored.connectionId, organizationId: stored.organizationId,
        authVersion: stored.authVersion, configHash: stored.configHash, lifecycleGeneration: stored.lifecycleGeneration,
        ...(stored.serverUrl === undefined ? {} : { serverUrl: stored.serverUrl }), shared: stored.shared, sharedDesktopInitiator: stored.sharedDesktopInitiator }))) {
      throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'The collected shared sign-in binding is invalid.', 409);
    }
  }
  if ((parsed.data.status === 'callback_received') !== Boolean(response)) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'The shared sign-in response state is invalid.', 409);
  const { snapshot: _snapshot, response: _response, ...record } = parsed.data;
  return { ...record, snapshot, ...(response ? { response: { code: response.code, stored: response.stored as OAuthStateRecord } } : {}) };
}
async function saveTransaction(transaction: Transaction): Promise<void> {
  await writeMcpCredentialJson(transactionPath(transaction.state), transaction, MCP_SYSTEM_SCOPE);
  const persisted = await readTransaction(transaction.state);
  if (!persisted || !isDeepStrictEqual(JSON.parse(JSON.stringify(persisted)), JSON.parse(JSON.stringify(transaction)))) {
    throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared sign-in storage acknowledgement failed.', 503);
  }
}
function summary(transaction: Transaction): SharedMcpDesktopOAuthSummary {
  return { connectionRef: transaction.target.connectionRef, state: transaction.state, status: transaction.status, expiresAt: transaction.expiresAt,
    ...(transaction.status === 'waiting' ? { authorizationUrl: transaction.authorizationUrl } : {}),
    ...(transaction.code ? { code: transaction.code, error: transaction.status === 'cancelled' ? 'Shared sign-in was cancelled.'
      : transaction.status === 'expired' ? 'Shared sign-in expired. Start again.' : 'Shared sign-in could not be completed. Reload and start again.' } : {}) };
}
function assertLocatorBinding(transaction: Transaction, initiator: SharedMcpDesktopInitiator, connectionRef: string, original?: Transaction): void {
  if (transaction.target.connectionRef !== validateIntegrationConnectionRef(connectionRef)
    || sharedMcpDesktopActorFingerprint(initiator.actor) !== sharedMcpDesktopActorFingerprint(transaction.snapshot.sharedDesktopInitiator.actor)
    || sharedMcpDesktopSessionFingerprint(initiator.authSessionId) !== sharedMcpDesktopSessionFingerprint(transaction.snapshot.sharedDesktopInitiator.authSessionId)) {
    throw new IntegrationConnectionError('CONNECTION_ACCESS_DENIED', 'This shared sign-in belongs to another manager session or context.', 403);
  }
  if (original && (sharedMcpDesktopSnapshotFingerprint(transaction.snapshot) !== sharedMcpDesktopSnapshotFingerprint(original.snapshot)
    || transaction.createdAt !== original.createdAt || transaction.expiresAt !== original.expiresAt || transaction.authorizationUrl !== original.authorizationUrl
    || transaction.issuer !== original.issuer || transaction.requiresIssuer !== original.requiresIssuer)) {
    throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'The shared desktop sign-in binding changed.', 409);
  }
}
async function assertSharedDesktopSessionOnConnection(database: SqlConnection, initiator: SharedMcpDesktopInitiator): Promise<void> {
  sharedMcpDesktopActorFingerprint(initiator.actor); sharedMcpDesktopSessionFingerprint(initiator.authSessionId);
  const row = await database.get('SELECT user_id,expires_at FROM "session" WHERE id=$1 FOR SHARE', [initiator.authSessionId]) as { user_id?: unknown; expires_at?: unknown } | undefined;
  const expiresAt = normalizeDatabaseTimestamp(Number(row?.expires_at));
  if (!row || row.user_id !== initiator.actor.userId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new IntegrationConnectionError('CONNECTION_ACCESS_DENIED', 'The original shared sign-in session is no longer active.', 403);
  }
}
export async function assertSharedMcpDesktopOAuthSession(database: SqlConnection, initiator: SharedMcpDesktopInitiator): Promise<void> {
  await assertSharedDesktopSessionOnConnection(database, initiator);
}
async function finishHeldTransaction(transaction: Transaction, status: 'completed' | 'cancelled' | 'expired' | 'failed'): Promise<void> {
  // Static sealed routing permits removal of this exact temporary state only. It grants no SQL/provider authority.
  const snapshot = transaction.snapshot;
  await discardMcpDesktopOAuthState(transaction.state, requireMcpCredentialScope({ shared: {
    connectionRef: snapshot.shared.connectionRef, connectionId: snapshot.connectionId, ownership: snapshot.shared.ownership,
    actor: snapshot.sharedDesktopInitiator.actor, operation: 'manage', revisions: snapshot.shared.revisions,
    authorizationRevision: snapshot.shared.authorizationRevision,
  } }));
  transaction.status = status; delete transaction.response;
  transaction.code = status === 'completed' ? undefined : status === 'cancelled' ? 'CONNECTION_DESKTOP_OAUTH_CANCELLED'
    : status === 'expired' ? 'CONNECTION_DESKTOP_OAUTH_EXPIRED' : 'CONNECTION_DESKTOP_OAUTH_FAILED';
  await saveTransaction(transaction);
}
async function expireHeldTransaction(transaction: Transaction): Promise<boolean> {
  if (!['waiting', 'callback_received'].includes(transaction.status) || Date.parse(transaction.expiresAt) > Date.now()) return false;
  await finishHeldTransaction(transaction, 'expired'); return true;
}
async function cleanupOldTransactions(): Promise<void> {
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try { directory = await fs.opendir(resolveMcpStoragePath(DIRECTORY, MCP_SYSTEM_SCOPE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let visited = 0;
  for await (const entry of directory) {
    if (++visited > 200) break;
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const value = await readMcpCredentialJson<{ state?: unknown }>(path.posix.join(DIRECTORY, entry.name), MCP_SYSTEM_SCOPE);
    if (!value || typeof value.state !== 'string' || transactionPath(value.state) !== path.posix.join(DIRECTORY, entry.name)) {
      throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared desktop sign-in storage is invalid.', 409);
    }
    const state = value.state;
    await withMcpStorageLock(`shared-desktop-${transactionPath(state)}`, MCP_SYSTEM_SCOPE, async () => {
      const transaction = await readTransaction(state); if (!transaction) return;
      if (Date.parse(transaction.expiresAt) + TERMINAL_TTL <= Date.now()) {
        await finishHeldTransaction(transaction, transaction.status === 'completed' ? 'completed' : 'expired');
        await removeMcpStoragePath(transactionPath(transaction.state), MCP_SYSTEM_SCOPE);
      }
      else await expireHeldTransaction(transaction);
    });
  }
}
export async function createSharedMcpDesktopOAuthTransaction(stored: OAuthStateRecord, authorizationUrl: string): Promise<void> {
  const snapshot = parseSharedMcpDesktopOAuthSnapshot({ connectionId: stored.connectionId, organizationId: stored.organizationId,
    authVersion: stored.authVersion, configHash: stored.configHash, lifecycleGeneration: stored.lifecycleGeneration,
    ...(stored.serverUrl === undefined ? {} : { serverUrl: stored.serverUrl }), shared: stored.shared, sharedDesktopInitiator: stored.sharedDesktopInitiator });
  transactionPath(stored.state);
  const url = new URL(authorizationUrl);
  if (stored.desktop !== true || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || authorizationUrl.length > 16_384
    || Date.parse(stored.expiresAt) <= Date.now()) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared desktop sign-in creation is invalid.', 400);
  await cleanupOldTransactions();
  const userHash = createHash('sha256').update(snapshot.shared.initiatingUserId).digest('hex');
  await withMcpStorageLock(`shared-desktop-owner-${userHash}`, MCP_SYSTEM_SCOPE, async () => {
    const indexPath = `shared-desktop-oauth-owner-index/${userHash}.json`;
    const rawIndex = await readMcpCredentialJson<unknown>(indexPath, MCP_SYSTEM_SCOPE), parsedIndex = rawIndex === null ? null : indexSchema.safeParse(rawIndex);
    if (parsedIndex && !parsedIndex.success) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared sign-in index is invalid.', 409);
    const index = parsedIndex?.success ? parsedIndex.data : null;
    const pending: Array<{ state: string; expiresAt: string }> = [];
    for (const item of index?.states ?? []) {
      const transaction = await readTransaction(item.state, true);
      if (transaction && (transaction.snapshot.shared.initiatingUserId !== snapshot.shared.initiatingUserId || transaction.expiresAt !== item.expiresAt)) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared sign-in index is invalid.', 409);
      if (transaction && ['waiting', 'callback_received'].includes(transaction.status) && Date.parse(transaction.expiresAt) > Date.now()) pending.push(item);
    }
    if (pending.length >= MAX_PENDING) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_BUSY', 'Finish or cancel a pending shared sign-in first.', 429);
    if (await readTransaction(stored.state, true)) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'This shared sign-in already exists.', 409);
    const nextIndex = { connectionId: 'shared-desktop-index', organizationId: null, states: [...pending, { state: stored.state, expiresAt: stored.expiresAt }] };
    await writeMcpCredentialJson(indexPath, nextIndex, MCP_SYSTEM_SCOPE);
    const persistedIndex = indexSchema.safeParse(await readMcpCredentialJson<unknown>(indexPath, MCP_SYSTEM_SCOPE));
    if (!persistedIndex.success || JSON.stringify(persistedIndex.data) !== JSON.stringify(nextIndex)) {
      throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared sign-in index acknowledgement failed.', 503);
    }
    await saveTransaction({ version: 2, state: stored.state, target: { kind: 'shared', connectionRef: snapshot.shared.connectionRef }, connectionId: snapshot.connectionId,
      organizationId: snapshot.organizationId, snapshot, authorizationUrl, issuer: stored.issuer, requiresIssuer: stored.authorizationResponseIssParameterSupported,
      createdAt: stored.createdAt, expiresAt: stored.expiresAt, status: 'waiting', exchangeAttempted: false });
  });
}

/** Public callback: sealed static binding and one-time code collection only; no SQL, provider call or publication. */
export async function tryReceiveSharedMcpDesktopOAuthCallback(input: { state: string; code?: string | null; error?: string | null; issuer?: string | null }): Promise<SharedMcpDesktopOAuthSummary | null> {
  transactionPath(input.state);
  return withMcpStorageLock(`shared-desktop-${transactionPath(input.state)}`, MCP_SYSTEM_SCOPE, async () => {
    const transaction = await readTransaction(input.state, true); if (!transaction) return null;
    if (await expireHeldTransaction(transaction)) return summary(transaction);
    if (transaction.status !== 'waiting') throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'This shared sign-in response was already used.', 409);
    if (transaction.requiresIssuer && !input.issuer || input.issuer && input.issuer !== transaction.issuer
      || (!input.code || input.code.length > 8192) && !input.error || input.code && input.error || input.error && input.error.length > 128) {
      await finishHeldTransaction(transaction, 'failed'); throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'The shared sign-in response is invalid.', 400);
    }
    const stored = await collectSharedMcpDesktopOAuthState(input.state, input.issuer, transaction.snapshot);
    if (input.error) await finishHeldTransaction(transaction, input.error === 'access_denied' ? 'cancelled' : 'failed');
    else { transaction.response = { code: input.code!, stored }; transaction.status = 'callback_received'; await saveTransaction(transaction); }
    return summary(transaction);
  });
}

type HeldResult = { transaction: Transaction; complete: boolean };
async function hasExactSharedDesktopToken(transaction: Transaction, scope: McpScope): Promise<boolean> {
  const snapshot = transaction.snapshot, status = await getMcpOAuthStatus(snapshot.connectionId, null, scope);
  if (!status.configured || !status.requiresAuth || !status.authorized || status.code !== undefined || status.lastCompletedState !== transaction.state) return false;
  const token = await readMcpCredentialJson<OAuthTokenRecord>(`connections/${snapshot.connectionId}/tokens.json`, scope);
  const url = new URL(transaction.authorizationUrl), clientIds = url.searchParams.getAll('client_id'), resources = url.searchParams.getAll('resource');
  if (!token || clientIds.length !== 1 || !clientIds[0] || resources.length !== 1 || !resources[0]) return false;
  const validLifetime = token.expiresAt === undefined || typeof token.expiresAt === 'string'
    && Number.isFinite(Date.parse(token.expiresAt)) && Date.parse(token.expiresAt) > Date.now() + 60_000
    || typeof token.refreshToken === 'string' && token.refreshToken.trim().length > 0;
  return token.authorizationState === transaction.state && token.connectionId === snapshot.connectionId
    && token.authVersion === snapshot.authVersion && token.lifecycleGeneration === snapshot.lifecycleGeneration
    && token.configHash === snapshot.configHash && token.serverUrl === snapshot.serverUrl && token.issuer === transaction.issuer
    && token.clientId === clientIds[0] && token.resource === resources[0] && typeof token.tokenType === 'string'
    && token.tokenType.toLowerCase() === 'bearer' && typeof token.accessToken === 'string' && /^[\x21-\x7e]+$/u.test(token.accessToken) && validLifetime;
}
async function withHeldSharedDesktopTransaction(initiator: SharedMcpDesktopInitiator, connectionRef: string, state: string,
  callback: (transaction: Transaction, authorization: AuthorizedIntegrationConnection, database: SqlConnection, published: boolean) => Promise<HeldResult>): Promise<SharedMcpDesktopOAuthSummary> {
  const original = await readTransaction(state); if (!original) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared sign-in is unavailable.', 409);
  assertLocatorBinding(original, initiator, connectionRef);
  // Original SQL authority and authentication session precede every desktop file lock.
  const result = await withAuthorizedIntegrationConnection(initiator.actor, connectionRef, 'manage', undefined, async (authorization, database) => {
    await assertSharedMcpDesktopOAuthSession(database, initiator);
    return withMcpStorageLock(`shared-desktop-${transactionPath(state)}`, MCP_SYSTEM_SCOPE, async () => {
      const transaction = await readTransaction(state); if (!transaction) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared sign-in is unavailable.', 409);
      assertLocatorBinding(transaction, initiator, connectionRef, original);
      const snapshot = transaction.snapshot, before = snapshot.shared.revisions, current = authorization.resource;
      if (authorization.backend.source !== 'mcp' || authorization.backend.connectionId !== snapshot.connectionId
        || JSON.stringify(current.ownership) !== JSON.stringify(snapshot.shared.ownership)
        || current.metadataRevision !== before.metadataRevision || current.grantsRevision !== before.grantsRevision) {
        throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'Shared sign-in setup or permissions changed. Start again.', 409);
      }
      const published = current.bindingRevision === before.bindingRevision + 1;
      if (!published && (current.bindingRevision !== before.bindingRevision || authorization.authorizationRevision !== snapshot.shared.authorizationRevision)) {
        throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'Shared sign-in binding changed. Start again.', 409);
      }
      if (published) {
        const receipt = await readSharedMcpDesktopOAuthCommit(database, state);
        const expected = { stateHash: createHash('sha256').update(state).digest('hex'), snapshotHash: sharedMcpDesktopSnapshotFingerprint(snapshot),
          authSessionHash: sharedMcpDesktopSessionFingerprint(initiator.authSessionId), actorHash: sharedMcpDesktopActorFingerprint(initiator.actor),
          connectionRef, backendConnectionId: snapshot.connectionId, initiatingUserId: initiator.actor.userId,
          preMetadataRevision: before.metadataRevision, preGrantsRevision: before.grantsRevision, preBindingRevision: before.bindingRevision,
          publishedBindingRevision: current.bindingRevision, preAuthorizationRevision: snapshot.shared.authorizationRevision,
          postAuthorizationRevision: authorization.authorizationRevision, authVersion: snapshot.authVersion, configHash: snapshot.configHash, lifecycleGeneration: snapshot.lifecycleGeneration };
        if (!receipt || Object.entries(expected).some(([key, value]) => Reflect.get(receipt, key) !== value)) {
          throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'This shared sign-in has no matching committed publication.', 409);
        }
      }
      const scope = sharedMcpScope(authorization);
      await assertMcpDesktopOAuthSnapshot({ ...snapshot, shared: { ...snapshot.shared,
        revisions: { metadataRevision: current.metadataRevision, grantsRevision: current.grantsRevision, bindingRevision: current.bindingRevision },
        authorizationRevision: authorization.authorizationRevision } }, scope);
      if (published) {
        if (!await hasExactSharedDesktopToken(transaction, scope)) throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'Shared sign-in publication no longer matches its authorization.', 409);
      }
      return callback(transaction, authorization, database, published);
    });
  });
  if (!result.complete) return summary(result.transaction);
  // Never record first completion until the outer SQL commit has returned successfully.
  return withMcpStorageLock(`shared-desktop-${transactionPath(state)}`, MCP_SYSTEM_SCOPE, async () => {
    const transaction = await readTransaction(state); if (!transaction) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'Shared sign-in is unavailable.', 409);
    assertLocatorBinding(transaction, initiator, connectionRef, result.transaction);
    if (!['callback_received', 'completed', 'expired'].includes(transaction.status)) throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'Shared sign-in completion changed.', 409);
    if (transaction.status !== 'completed') await finishHeldTransaction(transaction, 'completed');
    return summary(transaction);
  });
}
export async function getSharedMcpDesktopOAuthStatus(initiator: SharedMcpDesktopInitiator, connectionRef: string, state: string): Promise<SharedMcpDesktopOAuthSummary> {
  return withHeldSharedDesktopTransaction(initiator, connectionRef, state, async (transaction, authorization, _database, published) => {
    if (published) return { transaction, complete: true };
    if (!await expireHeldTransaction(transaction) && transaction.status === 'callback_received' && transaction.exchangeAttempted) {
      if (!await hasExactSharedDesktopToken(transaction, sharedMcpScope(authorization))) await finishHeldTransaction(transaction, 'failed');
    }
    return { transaction, complete: false };
  });
}
export async function cancelSharedMcpDesktopOAuth(initiator: SharedMcpDesktopInitiator, connectionRef: string, state: string): Promise<SharedMcpDesktopOAuthSummary> {
  return withHeldSharedDesktopTransaction(initiator, connectionRef, state, async (transaction, _authorization, _database, published) => {
    if (published) return { transaction, complete: true };
    if (['waiting', 'callback_received'].includes(transaction.status)) {
      await finishHeldTransaction(transaction, 'cancelled');
    }
    return { transaction, complete: false };
  });
}
export async function finalizeSharedMcpDesktopOAuth(initiator: SharedMcpDesktopInitiator, connectionRef: string, state: string): Promise<SharedMcpDesktopOAuthSummary> {
  return withHeldSharedDesktopTransaction(initiator, connectionRef, state, async (transaction, authorization, database, published) => {
    if (published) return { transaction, complete: true };
    if (await expireHeldTransaction(transaction) || transaction.status !== 'callback_received' || !transaction.response) return { transaction, complete: false };
    const scope = sharedMcpScope(authorization);
    const oauth = await getMcpOAuthStatus(transaction.snapshot.connectionId, null, scope);
    const exactToken = await hasExactSharedDesktopToken(transaction, scope);
    if (!exactToken && (transaction.exchangeAttempted || oauth.lastCompletedState === state || !oauth.configured
      || !oauth.requiresAuth || oauth.code !== undefined && oauth.code !== 'reauth_required')) {
      await finishHeldTransaction(transaction, 'failed'); return { transaction, complete: false };
    }
    await stageSharedMcpBindingPublication(authorization);
    if (!exactToken) {
      // A durably acknowledged intent precedes the one-time code POST. An ambiguous result never replays it.
      transaction.exchangeAttempted = true; await saveTransaction(transaction);
      await completeStoredMcpOAuth(transaction.response.code, state, transaction.response.stored, scope,
        { assertAuthorization: () => assertSharedMcpDesktopOAuthSession(database, initiator) });
    }
    if (!await hasExactSharedDesktopToken(transaction, scope)) {
      throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'Shared sign-in token publication could not be verified.', 409);
    }
    await assertSharedMcpDesktopOAuthSession(database, initiator);
    await closeMcpServer(transaction.snapshot.connectionId, scope);
    await publishIntegrationConnectionBinding(initiator.actor, connectionRef, transaction.snapshot.shared.revisions, authorization.backend);
    const authorizationAfter = await authorizeIntegrationConnection(initiator.actor, connectionRef, 'manage');
    await recordSharedMcpDesktopOAuthCommit(database, { state, snapshot: transaction.snapshot, authorizationBefore: authorization, authorizationAfter });
    return { transaction, complete: true };
  });
}
