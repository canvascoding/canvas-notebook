import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqlConnection } from '@/app/lib/db';
import { IntegrationConnectionError, type AuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/contracts';
import { isAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { parseSharedMcpDesktopOAuthSnapshot, sharedMcpDesktopActorFingerprint, sharedMcpDesktopSessionFingerprint,
  sharedMcpDesktopSnapshotFingerprint, type SharedMcpDesktopOAuthSnapshot } from './shared-desktop-oauth-contract';

/** Internal commit evidence only. This record never grants access and is never a public DTO. */
export type SharedMcpDesktopOAuthCommit = {
  stateHash: string; snapshotHash: string; authSessionHash: string; actorHash: string;
  connectionRef: string; backendConnectionId: string; initiatingUserId: string;
  preMetadataRevision: number; preGrantsRevision: number; preBindingRevision: number; publishedBindingRevision: number;
  preAuthorizationRevision: string; postAuthorizationRevision: string;
  authVersion: number; configHash: string; lifecycleGeneration: number; committedAt: number;
};

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const revision = z.union([z.number(), z.string().regex(/^\d+$/u)]).transform(Number)
  .refine(value => Number.isSafeInteger(value) && value >= 1);
const generation = z.union([z.number(), z.string().regex(/^\d+$/u)]).transform(Number)
  .refine(value => Number.isSafeInteger(value) && value >= 0);
const rowSchema = z.object({
  state_hash: hash, snapshot_hash: hash, auth_session_hash: hash, actor_hash: hash,
  connection_ref: z.string().regex(/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
  backend_connection_id: uuid,
  initiating_user_id: z.string().min(1).max(200).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value)),
  pre_metadata_revision: revision, pre_grants_revision: revision, pre_binding_revision: revision, published_binding_revision: revision,
  pre_authorization_revision: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), post_authorization_revision: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  auth_version: revision, config_hash: hash, lifecycle_generation: generation, committed_at: revision,
}).strict().refine(value => value.published_binding_revision === value.pre_binding_revision + 1
  && value.pre_authorization_revision !== value.post_authorization_revision);

function sharedDesktopStateHash(state: string): string {
  if (typeof state !== 'string' || !/^desktop_[A-Za-z0-9_-]{32}$/u.test(state)) {
    throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID', 'The shared desktop sign-in state is invalid.', 409);
  }
  return createHash('sha256').update(state).digest('hex');
}
function parseSharedMcpDesktopCommit(value: unknown): SharedMcpDesktopOAuthCommit {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID', 'The shared desktop sign-in commit evidence is invalid.', 409);
  const row = parsed.data;
  return Object.freeze({ stateHash: row.state_hash, snapshotHash: row.snapshot_hash, authSessionHash: row.auth_session_hash,
    actorHash: row.actor_hash, connectionRef: row.connection_ref, backendConnectionId: row.backend_connection_id,
    initiatingUserId: row.initiating_user_id, preMetadataRevision: row.pre_metadata_revision, preGrantsRevision: row.pre_grants_revision,
    preBindingRevision: row.pre_binding_revision, publishedBindingRevision: row.published_binding_revision,
    preAuthorizationRevision: row.pre_authorization_revision, postAuthorizationRevision: row.post_authorization_revision,
    authVersion: row.auth_version, configHash: row.config_hash, lifecycleGeneration: row.lifecycle_generation, committedAt: row.committed_at });
}
function validateSharedDesktopCommitAuthorizations(snapshot: SharedMcpDesktopOAuthSnapshot,
  before: AuthorizedIntegrationConnection, after: AuthorizedIntegrationConnection): void {
  if (!isAuthorizedIntegrationConnection(before) || !isAuthorizedIntegrationConnection(after)
    || before.operation !== 'manage' || after.operation !== 'manage' || !before.access.canManage || !after.access.canManage) {
    throw new IntegrationConnectionError('CONNECTION_ACCESS_DENIED', 'Current server-issued shared connection management authorizations are required.', 403);
  }
  const { shared, sharedDesktopInitiator } = snapshot;
  const beforeMetadata = { ...before.resource, bindingRevision: 0, updatedByUserId: null, updatedAt: 0 };
  const afterMetadata = { ...after.resource, bindingRevision: 0, updatedByUserId: null, updatedAt: 0 };
  if (before.backend.source !== 'mcp' || after.backend.source !== 'mcp'
    || before.backend.connectionId !== snapshot.connectionId || after.backend.connectionId !== snapshot.connectionId
    || before.resource.source !== 'mcp' || after.resource.source !== 'mcp'
    || before.resource.connectionRef !== shared.connectionRef || after.resource.connectionRef !== shared.connectionRef
    || JSON.stringify(before.resource.ownership) !== JSON.stringify(shared.ownership)
    || JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata)
    || sharedMcpDesktopActorFingerprint(before.actor) !== sharedMcpDesktopActorFingerprint(sharedDesktopInitiator.actor)
    || sharedMcpDesktopActorFingerprint(after.actor) !== sharedMcpDesktopActorFingerprint(before.actor)
    || before.resource.metadataRevision !== shared.revisions.metadataRevision || before.resource.grantsRevision !== shared.revisions.grantsRevision
    || before.resource.bindingRevision !== shared.revisions.bindingRevision
    || after.resource.bindingRevision !== before.resource.bindingRevision + 1
    || after.resource.updatedByUserId !== sharedDesktopInitiator.actor.userId
    || before.authorizationRevision !== shared.authorizationRevision || before.authorizationRevision === after.authorizationRevision) {
    throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID', 'The shared desktop sign-in publication does not match its original snapshot.', 409);
  }
}

/** Use the caller's connection only; absence is never inferred from provider files or generic bind history. */
export async function readSharedMcpDesktopOAuthCommit(database: SqlConnection, state: string): Promise<SharedMcpDesktopOAuthCommit | null> {
  const stateHash = sharedDesktopStateHash(state);
  const row = await database.get('SELECT * FROM mcp_shared_desktop_oauth_commits WHERE state_hash=$1', [stateHash]);
  if (row === undefined || row === null) return null;
  const record = parseSharedMcpDesktopCommit(row);
  if (record.stateHash !== stateHash) throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID', 'The shared desktop sign-in commit evidence is invalid.', 409);
  return record;
}

/** Must run in the SAME held common publication transaction, after publish + fresh post-publication authorization. */
export async function recordSharedMcpDesktopOAuthCommit(database: SqlConnection, input: {
  state: string; snapshot: SharedMcpDesktopOAuthSnapshot;
  authorizationBefore: AuthorizedIntegrationConnection; authorizationAfter: AuthorizedIntegrationConnection;
}): Promise<SharedMcpDesktopOAuthCommit> {
  const snapshot = parseSharedMcpDesktopOAuthSnapshot(input.snapshot);
  const stateHash = sharedDesktopStateHash(input.state);
  validateSharedDesktopCommitAuthorizations(snapshot, input.authorizationBefore, input.authorizationAfter);
  const proposed: Omit<SharedMcpDesktopOAuthCommit, 'committedAt'> = {
    stateHash, snapshotHash: sharedMcpDesktopSnapshotFingerprint(snapshot),
    authSessionHash: sharedMcpDesktopSessionFingerprint(snapshot.sharedDesktopInitiator.authSessionId),
    actorHash: sharedMcpDesktopActorFingerprint(snapshot.sharedDesktopInitiator.actor),
    connectionRef: snapshot.shared.connectionRef, backendConnectionId: snapshot.connectionId, initiatingUserId: snapshot.shared.initiatingUserId,
    preMetadataRevision: snapshot.shared.revisions.metadataRevision, preGrantsRevision: snapshot.shared.revisions.grantsRevision,
    preBindingRevision: snapshot.shared.revisions.bindingRevision, publishedBindingRevision: input.authorizationAfter.resource.bindingRevision,
    preAuthorizationRevision: snapshot.shared.authorizationRevision, postAuthorizationRevision: input.authorizationAfter.authorizationRevision,
    authVersion: snapshot.authVersion, configHash: snapshot.configHash, lifecycleGeneration: snapshot.lifecycleGeneration,
  };
  await database.run(`INSERT INTO mcp_shared_desktop_oauth_commits (state_hash,snapshot_hash,auth_session_hash,actor_hash,connection_ref,
    backend_connection_id,initiating_user_id,pre_metadata_revision,pre_grants_revision,pre_binding_revision,published_binding_revision,
    pre_authorization_revision,post_authorization_revision,auth_version,config_hash,lifecycle_generation,committed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (state_hash) DO NOTHING`,
  [proposed.stateHash, proposed.snapshotHash, proposed.authSessionHash, proposed.actorHash, proposed.connectionRef,
    proposed.backendConnectionId, proposed.initiatingUserId, proposed.preMetadataRevision, proposed.preGrantsRevision, proposed.preBindingRevision,
    proposed.publishedBindingRevision, proposed.preAuthorizationRevision, proposed.postAuthorizationRevision,
    proposed.authVersion, proposed.configHash, proposed.lifecycleGeneration, Date.now()]);
  const existing = await readSharedMcpDesktopOAuthCommit(database, input.state);
  if (!existing || Object.entries(proposed).some(([key, value]) => existing[key as keyof SharedMcpDesktopOAuthCommit] !== value)) {
    throw new IntegrationConnectionError('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID', 'This shared desktop sign-in already has different commit evidence.', 409);
  }
  return existing;
}
