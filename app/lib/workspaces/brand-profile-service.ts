import 'server-only';

import { openDb } from '@/app/lib/db';
import {
  DEFAULT_WORKSPACE_BRAND_PROFILE,
  cloneWorkspaceBrandProfile,
  normalizeWorkspaceBrandProfile,
  validateWorkspaceBrandProfile,
  type WorkspaceBrandProfile,
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

function stateFromRow(row: WorkspaceBrandProfileRow | undefined): WorkspaceBrandProfileState {
  if (!row) return defaultState();

  try {
    return {
      profile: normalizeWorkspaceBrandProfile(JSON.parse(row.settings_json)),
      configured: true,
      revision: Number(row.revision) || 1,
      updatedAt: Number(row.updated_at) || null,
    };
  } catch (error) {
    console.warn('[workspace-brand] Invalid persisted profile, using defaults:', error);
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
    return stateFromRow(row);
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
    return stateFromRow(row);
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

export function workspaceBrandProfileCacheKey(state: WorkspaceBrandProfileState): string {
  return state.configured ? `brand:${state.revision}:${state.updatedAt || 0}` : 'brand:default';
}

export function isWorkspaceBrandProfileActive(profile: WorkspaceBrandProfile): boolean {
  return profile.enabled;
}
