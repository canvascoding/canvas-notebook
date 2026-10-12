import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { assertSharedIntegrationOwnershipManagement } from '@/app/lib/integration-tools/connections/ownership';
import { IntegrationConnectionError, type AuthorizedIntegrationConnection, type IntegrationConnectionActor,
  type SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';
import { createScopedComposioProfileIdentity, normalizeComposioProfileName } from './composio-profiles';

export type SharedComposioProfile = {
  id: string;
  ownerUserId: null;
  ownership: SharedIntegrationConnectionOwnership;
  name: string;
  composioUserId: string;
  providerMode: 'local' | 'managed';
  profileRevision: number;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
};

type SharedProfileRow = { id: string; owner_user_id: string | null; scope_type: string; organization_id: string | null;
  workspace_id: string | null; name: string; composio_user_id: string; provider_mode: string | null; profile_revision: number;
  created_by_user_id: string | null; updated_by_user_id: string | null; status: string; created_at: number; updated_at: number };

function profileFromSharedRow(row: SharedProfileRow): SharedComposioProfile {
  if (row.owner_user_id !== null || !row.organization_id || !['organization', 'workspace'].includes(row.scope_type)
    || row.scope_type === 'workspace' && !row.workspace_id || !['local', 'managed'].includes(row.provider_mode || '')) {
    throw new IntegrationConnectionError('connection_not_found', 'The shared Composio profile was not found.', 404);
  }
  return { id: row.id, ownerUserId: null, ownership: row.scope_type === 'workspace'
    ? { type: 'team', organizationId: row.organization_id, workspaceId: row.workspace_id! }
    : { type: 'organization', organizationId: row.organization_id }, name: row.name, composioUserId: row.composio_user_id,
    providerMode: row.provider_mode as 'local' | 'managed', profileRevision: Number(row.profile_revision),
    createdByUserId: row.created_by_user_id, updatedByUserId: row.updated_by_user_id,
    status: row.status === 'archived' ? 'archived' : 'active', createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

function sameOwnership(left: SharedIntegrationConnectionOwnership, right: SharedIntegrationConnectionOwnership): boolean {
  return left.type === right.type && left.organizationId === right.organizationId
    && (left.type !== 'team' || right.type === 'team' && left.workspaceId === right.workspaceId);
}

async function readSharedProfile(id: string, connection?: SqlConnection): Promise<SharedComposioProfile> {
  const database = connection ?? await openDb();
  try {
    const row = await database.get(`SELECT * FROM composio_connection_profiles WHERE id = $1 AND owner_user_id IS NULL
      AND scope_type IN ('organization','workspace')`, [id]) as SharedProfileRow | undefined;
    if (!row) throw new IntegrationConnectionError('connection_not_found', 'The shared Composio profile was not found.', 404);
    return profileFromSharedRow(row);
  } finally { if (!connection) await database.close(); }
}

export async function createSharedComposioProfile(input: { actor: IntegrationConnectionActor; ownership: SharedIntegrationConnectionOwnership;
  name: unknown; providerMode: 'local' | 'managed' }): Promise<SharedComposioProfile> {
  await assertSharedIntegrationOwnershipManagement(input.actor, input.ownership);
  if (!['local', 'managed'].includes(input.providerMode)) throw new IntegrationConnectionError('invalid_request', 'Choose a Composio provider mode.');
  const name = normalizeComposioProfileName(input.name);
  const identity = createScopedComposioProfileIdentity();
  const now = Date.now();
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await assertSharedIntegrationOwnershipManagement(input.actor, input.ownership, { database });
    await database.run(`INSERT INTO composio_connection_profiles (id, owner_user_id, scope_type, organization_id, workspace_id,
      created_by_user_id, updated_by_user_id, provider_mode, profile_revision, name, composio_user_id, is_default, status, created_at, updated_at)
      VALUES ($1, NULL, $2, $3, $4, $5, $5, $6, 1, $7, $8, 0, 'active', $9, $9)`,
    [identity.id, input.ownership.type === 'team' ? 'workspace' : 'organization', input.ownership.organizationId,
      input.ownership.type === 'team' ? input.ownership.workspaceId : null, input.actor.userId, input.providerMode, name, identity.composioUserId, now]);
    await database.run('COMMIT');
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error;
  } finally { await database.close(); }
  return readSharedProfile(identity.id);
}

export async function inspectSharedComposioProfile(actor: IntegrationConnectionActor, profileId: string): Promise<SharedComposioProfile> {
  const profile = await readSharedProfile(profileId);
  await assertSharedIntegrationOwnershipManagement(actor, profile.ownership);
  return profile;
}

export async function listSharedComposioProfiles(actor: IntegrationConnectionActor, ownership: SharedIntegrationConnectionOwnership): Promise<SharedComposioProfile[]> {
  await assertSharedIntegrationOwnershipManagement(actor, ownership);
  const database = await openDb();
  try {
    const rows = await database.all(`SELECT * FROM composio_connection_profiles WHERE scope_type = $1 AND organization_id = $2
      AND workspace_id IS NOT DISTINCT FROM $3 AND owner_user_id IS NULL AND status = 'active' ORDER BY created_at, id`,
    [ownership.type === 'team' ? 'workspace' : 'organization', ownership.organizationId, ownership.type === 'team' ? ownership.workspaceId : null]) as SharedProfileRow[];
    return rows.map(profileFromSharedRow);
  } finally { await database.close(); }
}

export async function readAuthorizedSharedComposioProfile(authorized: AuthorizedIntegrationConnection,
  connection?: SqlConnection): Promise<SharedComposioProfile> {
  if (authorized.backend.source !== 'composio') throw new IntegrationConnectionError('connection_not_found', 'The Composio connection was not found.', 404);
  const profile = await readSharedProfile(authorized.backend.profileId, connection);
  if (profile.status !== 'active' || !sameOwnership(profile.ownership, authorized.resource.ownership)
    || profile.providerMode !== authorized.backend.mode) throw new IntegrationConnectionError('binding_changed', 'The shared Composio profile changed.', 409);
  return profile;
}

export function toPublicSharedComposioProfile(profile: SharedComposioProfile) {
  return { id: profile.id, name: profile.name, ownership: profile.ownership, providerMode: profile.providerMode, status: profile.status,
    profileRevision: profile.profileRevision, createdByUserId: profile.createdByUserId, updatedByUserId: profile.updatedByUserId,
    createdAt: new Date(profile.createdAt).toISOString(), updatedAt: new Date(profile.updatedAt).toISOString(), canManage: true as const };
}

export async function mutateSharedComposioProfile(input: { actor: IntegrationConnectionActor; profileId: string;
  expectedProfileRevision: number; name?: unknown; status?: 'active' | 'archived' }): Promise<SharedComposioProfile> {
  const prior = await readSharedProfile(input.profileId);
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await assertSharedIntegrationOwnershipManagement(input.actor, prior.ownership, { database });
    const row = await database.get(`SELECT * FROM composio_connection_profiles WHERE id = $1 AND owner_user_id IS NULL FOR UPDATE`, [input.profileId]) as SharedProfileRow | undefined;
    if (!row) throw new IntegrationConnectionError('connection_not_found', 'The shared Composio profile was not found.', 404);
    const profile = profileFromSharedRow(row);
    if (!sameOwnership(profile.ownership, prior.ownership)) throw new IntegrationConnectionError('binding_changed', 'The profile scope changed.', 409);
    if (!Number.isSafeInteger(input.expectedProfileRevision) || profile.profileRevision !== input.expectedProfileRevision) {
      throw new IntegrationConnectionError('binding_changed', 'The shared Composio profile changed. Reload it.', 409);
    }
    const name = input.name === undefined ? profile.name : normalizeComposioProfileName(input.name);
    const status = input.status || profile.status;
    if (!['active', 'archived'].includes(status)) throw new IntegrationConnectionError('invalid_request', 'The profile status is invalid.');
    if (status === 'archived') {
      const count = await database.get(`SELECT COUNT(*) AS count FROM integration_connection_resources
        WHERE backend_profile_id = $1 AND status = 'active'`, [profile.id]) as { count: number };
      if (Number(count.count) > 0) throw new IntegrationConnectionError('profile_in_use', 'Archive the active shared connections before archiving their profile.', 409);
    }
    await database.run(`UPDATE composio_connection_profiles SET name = $1, status = $2, updated_by_user_id = $3,
      profile_revision = profile_revision + 1, updated_at = $4 WHERE id = $5 AND profile_revision = $6`,
    [name, status, input.actor.userId, Date.now(), profile.id, input.expectedProfileRevision]);
    await database.run('COMMIT');
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error;
  } finally { await database.close(); }
  return inspectSharedComposioProfile(input.actor, input.profileId);
}
