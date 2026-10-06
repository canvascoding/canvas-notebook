import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';
import { safeAppReturnTo } from '@/app/lib/auth/return-to';
import { IntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionRevisions,
  type SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';
import type { ResolvedComposioContext } from './composio-context';
import { isAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';

const actorSchema = z.object({ userId: z.string(), workspaceId: z.string().nullable().optional(), organizationId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(), sessionId: z.string().nullable().optional(), policyRevision: z.string().optional() }).strict();
const hashState = (value: string) => createHmac('sha256', resolveAuthSecret()).update(`shared-composio-flow-v1:${value}`).digest('hex');
const baseUrl = () => (process.env.BASE_URL || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`).replace(/\/+$/u, '');

export type SharedComposioOAuthFlow = {
  actor: IntegrationConnectionActor; ownership: SharedIntegrationConnectionOwnership; connectionRef: string;
  profileId: string; composioUserId: string; profileRevision: number; toolkit: string; providerMode: 'local' | 'managed';
  revisions: IntegrationConnectionRevisions; authorizationRevision: string; credentialRevision: string;
  pendingAccountId: string; returnPath: string; expiresAt: number;
};

export async function createSharedComposioOAuthFlowState(input: { context: ResolvedComposioContext; credentialRevision: string;
  returnPath?: string | null }, externalDatabase?: SqlConnection) {
  const shared = input.context.sharedBinding;
  if (!shared || !isAuthorizedIntegrationConnection(shared.authorization) || shared.authorization.operation !== 'manage'
    || !shared.authorization.access.canManage || shared.authorization.backend.source !== 'composio') {
    throw new IntegrationConnectionError('invalid_request', 'A managed app connection is required.');
  }
  const { resource, actor, backend, authorizationRevision } = shared.authorization;
  const state = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 15 * 60_000;
  const returnPath = safeAppReturnTo(input.returnPath || `/settings?tab=integrations&connectionRef=${encodeURIComponent(resource.connectionRef)}`);
  if (!returnPath) throw new IntegrationConnectionError('invalid_request', 'Choose a valid app return path.');
  const database = externalDatabase || await openDb();
  try {
    await database.run(`DELETE FROM composio_oauth_flow_states WHERE expires_at < $1 OR consumed_at < $2`, [Date.now(), Date.now() - 60 * 60_000]);
    await database.run(`INSERT INTO composio_oauth_flow_states (state_hash,user_id,workspace_id,profile_id,composio_user_id,toolkit_slug,
      return_path,expires_at,created_at,connection_ref,scope_type,organization_id,owner_workspace_id,profile_revision,
      metadata_revision,grants_revision,binding_revision,authorization_revision,provider_mode,credential_revision,actor_context)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [hashState(state), actor.userId, actor.workspaceId || null, input.context.profileId, input.context.composioUserId, backend.toolkit,
      returnPath, expiresAt, Date.now(), resource.connectionRef, resource.ownership.type, resource.ownership.organizationId,
      resource.ownership.type === 'team' ? resource.ownership.workspaceId : null, shared.profileRevision,
      resource.metadataRevision, resource.grantsRevision, resource.bindingRevision, authorizationRevision, backend.mode,
      input.credentialRevision, JSON.stringify(actorSchema.parse(actor))]);
  } finally { if (!externalDatabase) await database.close(); }
  const callbackUrl = new URL('/api/composio/shared/callback', baseUrl());
  callbackUrl.searchParams.set('flow', state);
  return { state, callbackUrl: callbackUrl.toString(), expiresAt };
}

export async function bindSharedComposioOAuthPendingAccount(state: string, accountId: string, externalDatabase?: SqlConnection): Promise<void> {
  if (!accountId.trim() || accountId.length > 256) throw new IntegrationConnectionError('provider_unavailable', 'The OAuth account could not be identified.', 503);
  const database = externalDatabase || await openDb();
  try {
    const result = await database.run(`UPDATE composio_oauth_flow_states SET pending_account_id = $1 WHERE state_hash = $2
      AND connection_ref IS NOT NULL AND consumed_at IS NULL AND pending_account_id IS NULL AND expires_at >= $3`, [accountId, hashState(state), Date.now()]) as { changes: number };
    if (Number(result.changes) !== 1) throw new IntegrationConnectionError('binding_changed', 'The OAuth setup changed. Start it again.', 409);
  } finally { if (!externalDatabase) await database.close(); }
}

export async function consumeSharedComposioOAuthFlowState(stateValue: string): Promise<SharedComposioOAuthFlow> {
  const state = stateValue.trim();
  if (!state || state.length > 256) throw new IntegrationConnectionError('invalid_request', 'The shared OAuth flow is invalid.');
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const row = await database.get(`SELECT flow.* FROM composio_oauth_flow_states flow
      JOIN composio_connection_profiles profile ON profile.id = flow.profile_id AND profile.owner_user_id IS NULL
      AND profile.composio_user_id = flow.composio_user_id AND profile.status = 'active'
      AND profile.organization_id = flow.organization_id AND profile.workspace_id IS NOT DISTINCT FROM flow.owner_workspace_id
      AND profile.scope_type = CASE WHEN flow.scope_type = 'team' THEN 'workspace' ELSE flow.scope_type END
      AND profile.provider_mode = flow.provider_mode AND profile.profile_revision = flow.profile_revision
      WHERE flow.state_hash = $1 AND flow.connection_ref IS NOT NULL FOR UPDATE OF flow`, [hashState(state)]) as Record<string, unknown> | undefined;
    if (!row || row.consumed_at !== null || Number(row.expires_at) < Date.now() || typeof row.pending_account_id !== 'string' || !row.pending_account_id) {
      throw new IntegrationConnectionError('binding_changed', 'The shared OAuth flow expired or changed. Start setup again.', 409);
    }
    const actor = actorSchema.parse(JSON.parse(String(row.actor_context)));
    if (actor.userId !== row.user_id || (actor.workspaceId || null) !== row.workspace_id) throw new IntegrationConnectionError('binding_changed', 'The shared OAuth actor changed.', 409);
    const flow: SharedComposioOAuthFlow = { actor, ownership: row.scope_type === 'team'
      ? { type: 'team', organizationId: String(row.organization_id), workspaceId: String(row.owner_workspace_id) }
      : { type: 'organization', organizationId: String(row.organization_id) }, connectionRef: String(row.connection_ref),
    profileId: String(row.profile_id), composioUserId: String(row.composio_user_id), profileRevision: Number(row.profile_revision),
    toolkit: String(row.toolkit_slug), providerMode: row.provider_mode as 'local' | 'managed',
    revisions: { metadataRevision: Number(row.metadata_revision), grantsRevision: Number(row.grants_revision), bindingRevision: Number(row.binding_revision) },
    authorizationRevision: String(row.authorization_revision), credentialRevision: String(row.credential_revision), pendingAccountId: row.pending_account_id,
    returnPath: String(row.return_path), expiresAt: Number(row.expires_at) };
    await database.run('UPDATE composio_oauth_flow_states SET consumed_at = $1 WHERE state_hash = $2', [Date.now(), hashState(state)]);
    await database.run('COMMIT');
    return flow;
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error;
  } finally { await database.close(); }
}
