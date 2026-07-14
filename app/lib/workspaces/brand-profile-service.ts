import 'server-only';

import { openDb } from '@/app/lib/db';
import {
  DEFAULT_WORKSPACE_BRAND_PROFILE,
  cloneWorkspaceBrandProfile,
  normalizeWorkspaceBrandProfile,
  validateWorkspaceBrandProfile,
  type WorkspaceBrandProfile,
  type ResolvedWorkspaceBrandProfileState,
  type WorkspaceBrandProfileState,
} from './brand-profile';

type WorkspaceBrandProfileRow = {
  settings_json: string;
  revision: number;
  updated_at: number;
};

function defaultState(): WorkspaceBrandProfileState {
  return {
    profile: cloneWorkspaceBrandProfile(DEFAULT_WORKSPACE_BRAND_PROFILE),
    configured: false,
    revision: 0,
    updatedAt: null,
  };
}

function stateFromRow(
  row: WorkspaceBrandProfileRow | undefined,
  scope: 'workspace' | 'organization',
): WorkspaceBrandProfileState {
  if (!row) return defaultState();

  try {
    return {
      profile: normalizeWorkspaceBrandProfile(JSON.parse(row.settings_json)),
      configured: true,
      revision: Number(row.revision) || 1,
      updatedAt: Number(row.updated_at) || null,
    };
  } catch (error) {
    console.warn(`[${scope}-brand] Invalid persisted profile, using defaults:`, error);
    return {
      ...defaultState(),
      configured: true,
      revision: Number(row.revision) || 1,
      updatedAt: Number(row.updated_at) || null,
    };
  }
}

export async function readWorkspaceBrandProfile(workspaceId: string): Promise<WorkspaceBrandProfileState> {
  const database = await openDb();
  try {
    const row = await database.get(
      `SELECT settings_json, revision, updated_at
       FROM workspace_brand_profiles
       WHERE workspace_id = ?
       LIMIT 1`,
      [workspaceId],
    ) as WorkspaceBrandProfileRow | undefined;
    return stateFromRow(row, 'workspace');
  } finally {
    await database.close();
  }
}

export async function updateWorkspaceBrandProfile(input: {
  workspaceId: string;
  userId: string;
  profile: unknown;
}): Promise<WorkspaceBrandProfileState> {
  const profile = validateWorkspaceBrandProfile(input.profile);
  const database = await openDb();
  const now = Date.now();

  try {
    await database.run(
      `INSERT INTO workspace_brand_profiles (
         workspace_id, settings_json, revision, updated_by_user_id, created_at, updated_at
       ) VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         revision = workspace_brand_profiles.revision + 1,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`,
      [input.workspaceId, JSON.stringify(profile), input.userId, now, now],
    );

    const row = await database.get(
      `SELECT settings_json, revision, updated_at
       FROM workspace_brand_profiles
       WHERE workspace_id = ?
       LIMIT 1`,
      [input.workspaceId],
    ) as WorkspaceBrandProfileRow | undefined;
    return stateFromRow(row, 'workspace');
  } finally {
    await database.close();
  }
}

export async function resetWorkspaceBrandProfile(workspaceId: string): Promise<WorkspaceBrandProfileState> {
  const database = await openDb();
  try {
    await database.run('DELETE FROM workspace_brand_profiles WHERE workspace_id = ?', [workspaceId]);
    return defaultState();
  } finally {
    await database.close();
  }
}

export async function readOrganizationBrandProfile(organizationId: string): Promise<WorkspaceBrandProfileState> {
  const database = await openDb();
  try {
    const row = await database.get(
      `SELECT settings_json, revision, updated_at
       FROM organization_brand_profiles
       WHERE organization_id = ?
       LIMIT 1`,
      [organizationId],
    ) as WorkspaceBrandProfileRow | undefined;
    return stateFromRow(row, 'organization');
  } finally {
    await database.close();
  }
}

export async function updateOrganizationBrandProfile(input: {
  organizationId: string;
  userId: string;
  profile: unknown;
}): Promise<WorkspaceBrandProfileState> {
  const profile = validateWorkspaceBrandProfile(input.profile);
  const database = await openDb();
  const now = Date.now();

  try {
    await database.run(
      `INSERT INTO organization_brand_profiles (
         organization_id, settings_json, revision, updated_by_user_id, created_at, updated_at
       ) VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         revision = organization_brand_profiles.revision + 1,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`,
      [input.organizationId, JSON.stringify(profile), input.userId, now, now],
    );

    const row = await database.get(
      `SELECT settings_json, revision, updated_at
       FROM organization_brand_profiles
       WHERE organization_id = ?
       LIMIT 1`,
      [input.organizationId],
    ) as WorkspaceBrandProfileRow | undefined;
    return stateFromRow(row, 'organization');
  } finally {
    await database.close();
  }
}

export async function resetOrganizationBrandProfile(organizationId: string): Promise<WorkspaceBrandProfileState> {
  const database = await openDb();
  try {
    await database.run('DELETE FROM organization_brand_profiles WHERE organization_id = ?', [organizationId]);
    return defaultState();
  } finally {
    await database.close();
  }
}

async function readWorkspaceOrganizationId(workspaceId: string): Promise<string | null> {
  const database = await openDb();
  try {
    const row = await database.get(
      `SELECT organization_id
       FROM canvas_workspaces
       WHERE id = ?
       LIMIT 1`,
      [workspaceId],
    ) as { organization_id?: string | null } | undefined;
    return row?.organization_id?.trim() || null;
  } finally {
    await database.close();
  }
}

export async function resolveWorkspaceBrandProfile(
  workspaceId: string,
  providedOrganizationId?: string | null,
): Promise<ResolvedWorkspaceBrandProfileState> {
  const workspaceOverride = await readWorkspaceBrandProfile(workspaceId);
  const organizationId = providedOrganizationId === undefined
    ? await readWorkspaceOrganizationId(workspaceId)
    : providedOrganizationId?.trim() || null;
  const organizationDefault = organizationId
    ? await readOrganizationBrandProfile(organizationId)
    : defaultState();

  const source = workspaceOverride.configured
    ? 'workspace'
    : organizationDefault.configured ? 'organization' : 'default';
  const effective = source === 'workspace'
    ? workspaceOverride
    : source === 'organization' ? organizationDefault : defaultState();

  return {
    ...effective,
    source,
    organizationId,
    workspaceOverride,
    organizationDefault,
  };
}

function profileStateCacheKey(state: WorkspaceBrandProfileState): string {
  return state.configured ? `${state.revision}:${state.updatedAt || 0}` : 'default';
}

export function workspaceBrandProfileCacheKey(
  state: WorkspaceBrandProfileState | ResolvedWorkspaceBrandProfileState,
): string {
  if ('source' in state) {
    return `brand:${state.source}:workspace:${profileStateCacheKey(state.workspaceOverride)}:organization:${profileStateCacheKey(state.organizationDefault)}`;
  }
  return `brand:${profileStateCacheKey(state)}`;
}

export function isWorkspaceBrandProfileActive(profile: WorkspaceBrandProfile): boolean {
  return profile.enabled;
}
