import 'server-only';

import { randomUUID } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { readScopedEnvState } from '@/app/lib/integrations/env-config';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/context';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

const DEFAULT_PROFILE_NAME = 'Meine Verbindungen';
const PROFILE_NAME_MAX_LENGTH = 80;
const PROFILE_ID_PREFIX = 'cmp_profile_';
const COMPOSIO_USER_ID_PREFIX = 'canvas-profile-';

type ProfileRow = {
  id: string;
  owner_user_id: string;
  name: string;
  composio_user_id: string;
  is_default: number;
  status: string;
  created_at: number;
  updated_at: number;
};

type ProfileWithUsageRow = ProfileRow & {
  workspace_override_count: number;
};

type OverrideRow = {
  user_id: string;
  workspace_id: string;
  profile_id: string;
  created_at: number;
  updated_at: number;
};

export type ComposioConnectionProfileStatus = 'active' | 'archived';

export interface ComposioConnectionProfile {
  id: string;
  ownerUserId: string;
  name: string;
  composioUserId: string;
  isDefault: boolean;
  status: ComposioConnectionProfileStatus;
  workspaceOverrideCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EffectiveComposioProfile extends ComposioConnectionProfile {
  workspaceId: string;
  source: 'default' | 'workspace_override';
  cacheRevision: string;
}

export class ComposioProfileError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ComposioProfileError';
    this.code = code;
    this.status = status;
  }
}

function normalizeUserId(value: string): string {
  const userId = value.trim();
  if (!userId) {
    throw new ComposioProfileError('COMPOSIO_USER_REQUIRED', 'A user is required.', 401);
  }
  return userId;
}

function normalizeProfileId(value: string): string {
  const profileId = value.trim();
  if (!profileId) {
    throw new ComposioProfileError('COMPOSIO_PROFILE_REQUIRED', 'A connection profile is required.');
  }
  return profileId;
}

export function normalizeComposioProfileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ComposioProfileError('COMPOSIO_PROFILE_NAME_REQUIRED', 'A profile name is required.');
  }
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) {
    throw new ComposioProfileError('COMPOSIO_PROFILE_NAME_REQUIRED', 'A profile name is required.');
  }
  if (name.length > PROFILE_NAME_MAX_LENGTH) {
    throw new ComposioProfileError(
      'COMPOSIO_PROFILE_NAME_TOO_LONG',
      `Profile names must be ${PROFILE_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (name.includes('\0')) {
    throw new ComposioProfileError('COMPOSIO_PROFILE_NAME_INVALID', 'The profile name is invalid.');
  }
  return name;
}

function profileStatus(value: string): ComposioConnectionProfileStatus {
  return value === 'archived' ? 'archived' : 'active';
}

function profileFromRow(row: ProfileRow | ProfileWithUsageRow): ComposioConnectionProfile {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    composioUserId: row.composio_user_id,
    isDefault: row.is_default === 1,
    status: profileStatus(row.status),
    workspaceOverrideCount: 'workspace_override_count' in row
      ? Number(row.workspace_override_count) || 0
      : 0,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

async function withDatabase<T>(callback: (database: SqlConnection) => T | Promise<T>): Promise<T> {
  const database = await openDb();
  try {
    return await callback(database);
  } finally {
    await database.close();
  }
}

async function getDefaultProfileRow(
  database: SqlConnection,
  ownerUserId: string,
): Promise<ProfileRow | null> {
  return await database.get(`
    SELECT id, owner_user_id, name, composio_user_id, is_default, status, created_at, updated_at
    FROM composio_connection_profiles
    WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `, [ownerUserId]) as ProfileRow | undefined || null;
}

async function getOwnedProfileRow(
  database: SqlConnection,
  ownerUserId: string,
  profileId: string,
  options: { activeOnly?: boolean } = {},
): Promise<ProfileRow | null> {
  return await database.get(`
    SELECT id, owner_user_id, name, composio_user_id, is_default, status, created_at, updated_at
    FROM composio_connection_profiles
    WHERE id = ? AND owner_user_id = ?${options.activeOnly ? " AND status = 'active'" : ''}
    LIMIT 1
  `, [profileId, ownerUserId]) as ProfileRow | undefined || null;
}

async function assertUserExists(database: SqlConnection, userId: string): Promise<void> {
  const row = await database.get('SELECT id FROM user WHERE id = ? LIMIT 1', [userId]) as { id: string } | undefined;
  if (!row) {
    throw new ComposioProfileError('COMPOSIO_PROFILE_USER_NOT_FOUND', 'The profile owner does not exist.', 404);
  }
}

async function readLegacyComposioUserId(ownerUserId: string): Promise<string | null> {
  try {
    const state = await readScopedEnvState('integrations', { userId: ownerUserId });
    return state.entries.find((entry) => entry.key === 'COMPOSIO_USER_ID')?.value.trim() || null;
  } catch (error) {
    console.warn('[Composio] Could not read the legacy user identity during profile migration:', error);
    return null;
  }
}

function createProfileId(): string {
  return `${PROFILE_ID_PREFIX}${randomUUID()}`;
}

function createComposioUserId(): string {
  return `${COMPOSIO_USER_ID_PREFIX}${randomUUID()}`;
}

async function insertProfile(input: {
  ownerUserId: string;
  name: string;
  composioUserId: string;
  isDefault: boolean;
}): Promise<void> {
  await withDatabase(async (database) => {
    await assertUserExists(database, input.ownerUserId);
    const now = Date.now();
    await database.run(`
      INSERT INTO composio_connection_profiles (
        id, owner_user_id, name, composio_user_id, is_default, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT DO NOTHING
    `, [
      createProfileId(),
      input.ownerUserId,
      input.name,
      input.composioUserId,
      input.isDefault ? 1 : 0,
      now,
      now,
    ]);
  });
}

export async function ensureDefaultComposioProfile(ownerUserIdValue: string): Promise<ComposioConnectionProfile> {
  const ownerUserId = normalizeUserId(ownerUserIdValue);
  const existing = await withDatabase((database) => getDefaultProfileRow(database, ownerUserId));
  if (existing) return profileFromRow(existing);

  const legacyComposioUserId = await readLegacyComposioUserId(ownerUserId);
  const composioUserId = legacyComposioUserId || createComposioUserId();
  await insertProfile({
    ownerUserId,
    name: DEFAULT_PROFILE_NAME,
    composioUserId,
    isDefault: true,
  });

  return withDatabase(async (database) => {
    const created = await getDefaultProfileRow(database, ownerUserId);
    if (created) return profileFromRow(created);

    const conflictingIdentity = await database.get(`
      SELECT owner_user_id
      FROM composio_connection_profiles
      WHERE composio_user_id = ?
      LIMIT 1
    `, [composioUserId]) as { owner_user_id: string } | undefined;
    if (conflictingIdentity && conflictingIdentity.owner_user_id !== ownerUserId) {
      throw new ComposioProfileError(
        'COMPOSIO_LEGACY_IDENTITY_CONFLICT',
        'The existing Composio identity is assigned to another user and requires administrator repair.',
        409,
      );
    }

    throw new ComposioProfileError(
      'COMPOSIO_DEFAULT_PROFILE_CREATE_FAILED',
      'The default connection profile could not be created.',
      500,
    );
  });
}

export async function listComposioProfiles(ownerUserIdValue: string): Promise<ComposioConnectionProfile[]> {
  const ownerUserId = normalizeUserId(ownerUserIdValue);
  await ensureDefaultComposioProfile(ownerUserId);
  return withDatabase(async (database) => {
    const rows = await database.all(`
      SELECT
        profile.id,
        profile.owner_user_id,
        profile.name,
        profile.composio_user_id,
        profile.is_default,
        profile.status,
        profile.created_at,
        profile.updated_at,
        COUNT(workspace_override.workspace_id) AS workspace_override_count
      FROM composio_connection_profiles profile
      LEFT JOIN composio_workspace_profile_overrides workspace_override
        ON workspace_override.profile_id = profile.id
      WHERE profile.owner_user_id = ? AND profile.status = 'active'
      GROUP BY
        profile.id,
        profile.owner_user_id,
        profile.name,
        profile.composio_user_id,
        profile.is_default,
        profile.status,
        profile.created_at,
        profile.updated_at
      ORDER BY profile.is_default DESC, profile.created_at ASC, profile.id ASC
    `, [ownerUserId]) as ProfileWithUsageRow[];
    return rows.map(profileFromRow);
  });
}

export async function createComposioProfile(input: {
  ownerUserId: string;
  name: unknown;
}): Promise<ComposioConnectionProfile> {
  const ownerUserId = normalizeUserId(input.ownerUserId);
  const name = normalizeComposioProfileName(input.name);
  const composioUserId = createComposioUserId();
  await ensureDefaultComposioProfile(ownerUserId);
  await insertProfile({ ownerUserId, name, composioUserId, isDefault: false });

  return withDatabase(async (database) => {
    const row = await database.get(`
      SELECT id, owner_user_id, name, composio_user_id, is_default, status, created_at, updated_at
      FROM composio_connection_profiles
      WHERE owner_user_id = ? AND composio_user_id = ? AND status = 'active'
      LIMIT 1
    `, [ownerUserId, composioUserId]) as ProfileRow | undefined;
    if (!row) {
      throw new ComposioProfileError('COMPOSIO_PROFILE_CREATE_FAILED', 'The connection profile could not be created.', 500);
    }
    return profileFromRow(row);
  });
}

export async function renameComposioProfile(input: {
  ownerUserId: string;
  profileId: string;
  name: unknown;
}): Promise<ComposioConnectionProfile> {
  const ownerUserId = normalizeUserId(input.ownerUserId);
  const profileId = normalizeProfileId(input.profileId);
  const name = normalizeComposioProfileName(input.name);

  return withDatabase(async (database) => {
    const owned = await getOwnedProfileRow(database, ownerUserId, profileId, { activeOnly: true });
    if (!owned) {
      throw new ComposioProfileError('COMPOSIO_PROFILE_NOT_FOUND', 'Connection profile not found.', 404);
    }
    await database.run(`
      UPDATE composio_connection_profiles
      SET name = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'active'
    `, [name, Date.now(), profileId, ownerUserId]);
    const updated = await getOwnedProfileRow(database, ownerUserId, profileId, { activeOnly: true });
    if (!updated) {
      throw new ComposioProfileError('COMPOSIO_PROFILE_UPDATE_FAILED', 'The connection profile could not be updated.', 500);
    }
    return profileFromRow(updated);
  });
}

export async function archiveComposioProfile(input: {
  ownerUserId: string;
  profileId: string;
}): Promise<void> {
  const ownerUserId = normalizeUserId(input.ownerUserId);
  const profileId = normalizeProfileId(input.profileId);
  await withDatabase(async (database) => {
    const profile = await getOwnedProfileRow(database, ownerUserId, profileId, { activeOnly: true });
    if (!profile) {
      throw new ComposioProfileError('COMPOSIO_PROFILE_NOT_FOUND', 'Connection profile not found.', 404);
    }
    if (profile.is_default === 1) {
      throw new ComposioProfileError(
        'COMPOSIO_DEFAULT_PROFILE_ARCHIVE_FORBIDDEN',
        'The default connection profile cannot be archived.',
        409,
      );
    }
    const usage = await database.get(`
      SELECT COUNT(*) AS count
      FROM composio_workspace_profile_overrides
      WHERE profile_id = ?
    `, [profileId]) as { count: number } | undefined;
    if (Number(usage?.count || 0) > 0) {
      throw new ComposioProfileError(
        'COMPOSIO_PROFILE_IN_USE',
        'Remove this profile from its workspaces before archiving it.',
        409,
      );
    }
    const automationUsage = await database.get(`
      SELECT COUNT(*) AS count
      FROM automation_jobs
      WHERE composio_profile_id = ?
         OR (
           composio_profile_id IS NULL
           AND composio_user_id = ?
           AND COALESCE(responsible_user_id, owner_user_id, created_by_user_id) = ?
         )
    `, [profileId, profile.composio_user_id, ownerUserId]) as { count: number } | undefined;
    if (Number(automationUsage?.count || 0) > 0) {
      throw new ComposioProfileError(
        'COMPOSIO_PROFILE_AUTOMATION_IN_USE',
        'Repair or remove the automations bound to this profile before archiving it.',
        409,
      );
    }
    await database.run(`
      UPDATE composio_connection_profiles
      SET status = 'archived', updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'active'
    `, [Date.now(), profileId, ownerUserId]);
  });
}

async function resolveReadableWorkspace(userId: string, workspaceId?: string | null): Promise<WorkspaceContext> {
  try {
    return await resolveAgentSessionWorkspaceForUser({
      userId,
      workspaceId: workspaceId?.trim() || null,
      permissions: ['canRead'],
    });
  } catch (error) {
    throw new ComposioProfileError(
      'COMPOSIO_WORKSPACE_INACCESSIBLE',
      error instanceof Error ? error.message : 'Workspace not found or inaccessible.',
      404,
    );
  }
}

async function getWorkspaceOverride(
  database: SqlConnection,
  userId: string,
  workspaceId: string,
): Promise<OverrideRow | null> {
  return await database.get(`
    SELECT user_id, workspace_id, profile_id, created_at, updated_at
    FROM composio_workspace_profile_overrides
    WHERE user_id = ? AND workspace_id = ?
    LIMIT 1
  `, [userId, workspaceId]) as OverrideRow | undefined || null;
}

export async function resolveEffectiveComposioProfile(input: {
  userId: string;
  workspaceId?: string | null;
}): Promise<EffectiveComposioProfile> {
  const userId = normalizeUserId(input.userId);
  const workspace = await resolveReadableWorkspace(userId, input.workspaceId);
  const defaultProfile = await ensureDefaultComposioProfile(userId);

  if (workspace.workspaceId === LEGACY_PERSONAL_WORKSPACE_ID) {
    return {
      ...defaultProfile,
      workspaceId: workspace.workspaceId,
      source: 'default',
      cacheRevision: `${defaultProfile.id}:${defaultProfile.updatedAt.getTime()}:0`,
    };
  }

  return withDatabase(async (database) => {
    const override = await getWorkspaceOverride(database, userId, workspace.workspaceId);
    if (!override) {
      return {
        ...defaultProfile,
        workspaceId: workspace.workspaceId,
        source: 'default',
        cacheRevision: `${defaultProfile.id}:${defaultProfile.updatedAt.getTime()}:0`,
      };
    }

    const profile = await getOwnedProfileRow(database, userId, override.profile_id, { activeOnly: true });
    if (!profile) {
      throw new ComposioProfileError(
        'COMPOSIO_PROFILE_OVERRIDE_INVALID',
        'The workspace connection profile is invalid and must be repaired.',
        409,
      );
    }
    const resolved = profileFromRow(profile);
    return {
      ...resolved,
      workspaceId: workspace.workspaceId,
      source: 'workspace_override',
      cacheRevision: `${resolved.id}:${resolved.updatedAt.getTime()}:${override.updated_at}`,
    };
  });
}

export async function resolveOwnedComposioProfileBinding(input: {
  userId: string;
  workspaceId?: string | null;
  profileId?: string | null;
  composioUserId?: string | null;
}): Promise<EffectiveComposioProfile> {
  const userId = normalizeUserId(input.userId);
  const workspace = await resolveReadableWorkspace(userId, input.workspaceId);
  const profileId = input.profileId?.trim() || null;
  const composioUserId = input.composioUserId?.trim() || null;
  if (!profileId && !composioUserId) {
    throw new ComposioProfileError(
      'COMPOSIO_PROFILE_BINDING_REQUIRED',
      'The bound connection profile could not be identified.',
      409,
    );
  }

  return withDatabase(async (database) => {
    const row = profileId
      ? await getOwnedProfileRow(database, userId, profileId, { activeOnly: true })
      : await database.get(`
          SELECT id, owner_user_id, name, composio_user_id, is_default, status, created_at, updated_at
          FROM composio_connection_profiles
          WHERE owner_user_id = ? AND composio_user_id = ? AND status = 'active'
          LIMIT 1
        `, [userId, composioUserId]) as ProfileRow | undefined || null;
    if (!row || (composioUserId && row.composio_user_id !== composioUserId)) {
      throw new ComposioProfileError(
        'COMPOSIO_PROFILE_BINDING_INVALID',
        'The connection profile bound to this automation is unavailable.',
        409,
      );
    }
    const profile = profileFromRow(row);
    return {
      ...profile,
      workspaceId: workspace.workspaceId,
      source: profile.isDefault ? 'default' : 'workspace_override',
      cacheRevision: `${profile.id}:${profile.updatedAt.getTime()}:binding`,
    };
  });
}

export async function setComposioWorkspaceProfileOverride(input: {
  userId: string;
  workspaceId: string;
  profileId: string;
}): Promise<EffectiveComposioProfile> {
  const userId = normalizeUserId(input.userId);
  const profileId = normalizeProfileId(input.profileId);
  const workspace = await resolveReadableWorkspace(userId, input.workspaceId);
  if (workspace.workspaceId === LEGACY_PERSONAL_WORKSPACE_ID) {
    throw new ComposioProfileError(
      'COMPOSIO_WORKSPACE_NOT_PERSISTED',
      'A separate connection profile requires a persisted workspace.',
      409,
    );
  }

  const profile = await withDatabase((database) => getOwnedProfileRow(database, userId, profileId, { activeOnly: true }));
  if (!profile) {
    throw new ComposioProfileError('COMPOSIO_PROFILE_NOT_FOUND', 'Connection profile not found.', 404);
  }
  if (profile.is_default === 1) {
    return clearComposioWorkspaceProfileOverride({ userId, workspaceId: workspace.workspaceId });
  }

  await withDatabase(async (database) => {
    const now = Date.now();
    await database.run(`
      INSERT INTO composio_workspace_profile_overrides (
        user_id, workspace_id, profile_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, workspace_id) DO UPDATE SET
        profile_id = excluded.profile_id,
        updated_at = excluded.updated_at
    `, [userId, workspace.workspaceId, profileId, now, now]);
  });

  return resolveEffectiveComposioProfile({ userId, workspaceId: workspace.workspaceId });
}

export async function clearComposioWorkspaceProfileOverride(input: {
  userId: string;
  workspaceId: string;
}): Promise<EffectiveComposioProfile> {
  const userId = normalizeUserId(input.userId);
  const workspace = await resolveReadableWorkspace(userId, input.workspaceId);
  if (workspace.workspaceId !== LEGACY_PERSONAL_WORKSPACE_ID) {
    await withDatabase((database) => database.run(`
      DELETE FROM composio_workspace_profile_overrides
      WHERE user_id = ? AND workspace_id = ?
    `, [userId, workspace.workspaceId]));
  }
  return resolveEffectiveComposioProfile({ userId, workspaceId: workspace.workspaceId });
}
