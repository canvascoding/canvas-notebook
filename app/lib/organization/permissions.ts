import 'server-only';

import { NextResponse } from 'next/server';

import { isAdminUser, type AdminUserCandidate } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import { isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';
import { openDb } from '@/app/lib/db';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import {
  getOrganizationPermissionForUser,
  openOrganizationBootstrapDatabase,
  type OrganizationPermissionSnapshot,
  type OrganizationPermissionState,
} from '@/app/lib/organization/bootstrap';
import {
  ensureOrganizationPermissionRow,
  organizationPermissionDefaults,
} from '@/app/lib/organization/permission-provisioning';
import { updateTeamMembershipRole } from '@/app/lib/organization/team-membership';
import {
  findPostgresPermissionUserCandidate,
  getPostgresOrganizationPermissionForUser,
} from '@/app/lib/workspaces/postgres-runtime';

export type OrganizationPermissionKey = Exclude<keyof OrganizationPermissionSnapshot, 'role' | 'status'>;

export const ORGANIZATION_PERMISSION_KEYS = [
  'canWriteTeamWorkspace',
  'canCreatePublicLinks',
  'canCreateTeamAutomations',
  'canSharePluginsAndSkills',
  'canExport',
  'canDeleteTeamFiles',
  'canDeleteStudioAssets',
  'canManageBackups',
  'canManageOrganizationMemory',
  'canMigrateDatabase',
  'canEnableKnowledge',
  'canRecoverWorkspaces',
] as const satisfies readonly OrganizationPermissionKey[];

export type OrganizationPermissionPatch = Partial<Record<OrganizationPermissionKey, boolean>>;

export type OrganizationPermissionUserDetails = {
  organizationId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: OrganizationPermissionSnapshot['role'];
  status: OrganizationPermissionSnapshot['status'];
  permissions: Record<OrganizationPermissionKey, boolean>;
  updatedAt: number | null;
};

export type OrganizationPermissionGuardResult =
  | {
      ok: true;
      session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
      state: OrganizationPermissionState;
      permission: OrganizationPermissionSnapshot;
    }
  | {
      ok: false;
      response: NextResponse;
    };

type PermissionGuardOptions = {
  errorMessage?: string;
  legacyAdminFallback?: boolean;
};

type PermissionUserCandidate = AdminUserCandidate & {
  id?: string | null;
};

type PermissionDatabase = {
  get: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  run: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  all: (sql: string, params?: unknown[]) => unknown[] | Promise<unknown[]>;
  close?: () => void | Promise<void>;
};

type OrganizationRow = {
  organization_id: string;
  owner_user_id: string;
};

type PermissionDetailsRow = {
  organization_id: string;
  user_id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  status: string | null;
  can_write_team_workspace: number | boolean | null;
  can_create_public_links: number | boolean | null;
  can_create_team_automations: number | boolean | null;
  can_share_plugins_and_skills: number | boolean | null;
  can_export: number | boolean | null;
  can_delete_team_files: number | boolean | null;
  can_delete_studio_assets: number | boolean | null;
  can_manage_backups: number | boolean | null;
  can_manage_organization_memory: number | boolean | null;
  can_migrate_database: number | boolean | null;
  can_enable_knowledge: number | boolean | null;
  can_recover_workspaces: number | boolean | null;
  updated_at: number | null;
};

type PermissionUserRow = {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  banned?: number | boolean | null;
};

const PERMISSION_COLUMNS: Record<OrganizationPermissionKey, string> = {
  canWriteTeamWorkspace: 'can_write_team_workspace',
  canCreatePublicLinks: 'can_create_public_links',
  canCreateTeamAutomations: 'can_create_team_automations',
  canSharePluginsAndSkills: 'can_share_plugins_and_skills',
  canExport: 'can_export',
  canDeleteTeamFiles: 'can_delete_team_files',
  canDeleteStudioAssets: 'can_delete_studio_assets',
  canManageBackups: 'can_manage_backups',
  canManageOrganizationMemory: 'can_manage_organization_memory',
  canMigrateDatabase: 'can_migrate_database',
  canEnableKnowledge: 'can_enable_knowledge',
  canRecoverWorkspaces: 'can_recover_workspaces',
};

const LEGACY_ADMIN_PERMISSION: OrganizationPermissionSnapshot = {
  role: 'admin',
  status: 'active',
  canWriteTeamWorkspace: true,
  canCreatePublicLinks: true,
  canCreateTeamAutomations: true,
  canSharePluginsAndSkills: true,
  canExport: true,
  canDeleteTeamFiles: true,
  canDeleteStudioAssets: true,
  canManageBackups: true,
  canManageOrganizationMemory: true,
  canMigrateDatabase: true,
  canEnableKnowledge: true,
  canRecoverWorkspaces: true,
};

export class OrganizationPermissionError extends Error {
  readonly status = 403;
  readonly code = 'ORGANIZATION_PERMISSION_DENIED';

  constructor(
    public readonly permission: OrganizationPermissionKey,
    message = `Missing organization permission: ${permission}`,
  ) {
    super(message);
    this.name = 'OrganizationPermissionError';
  }
}

export class OrganizationPermissionMutationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'OrganizationPermissionMutationError';
  }
}

function forbiddenResponse(permission: OrganizationPermissionKey, message?: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      code: 'ORGANIZATION_PERMISSION_DENIED',
      permission,
      error: message || `Missing organization permission: ${permission}`,
    },
    { status: 403 },
  );
}

export function hasOrganizationPermission(
  permission: OrganizationPermissionSnapshot | null | undefined,
  key: OrganizationPermissionKey,
): boolean {
  return permission?.status === 'active' && permission?.[key] === true;
}

export function assertOrganizationPermission(
  permission: OrganizationPermissionSnapshot | null | undefined,
  key: OrganizationPermissionKey,
  message?: string,
): asserts permission is OrganizationPermissionSnapshot {
  if (!hasOrganizationPermission(permission, key)) {
    throw new OrganizationPermissionError(key, message);
  }
}

export async function readOrganizationPermissionForUser(userId: string): Promise<OrganizationPermissionState> {
  if (getDatabaseProvider() === 'postgres') {
    return getPostgresOrganizationPermissionForUser(userId);
  }
  const sqlite = openOrganizationBootstrapDatabase();
  try {
    return getOrganizationPermissionForUser(sqlite, userId);
  } finally {
    sqlite.close();
  }
}

async function readPermissionUserCandidate(userId: string): Promise<PermissionUserCandidate | null> {
  if (getDatabaseProvider() === 'postgres') {
    return findPostgresPermissionUserCandidate(userId);
  }
  const sqlite = openOrganizationBootstrapDatabase();
  try {
    const candidate = sqlite.prepare(`
      SELECT id, email, role
      FROM user
      WHERE id = ?
      LIMIT 1
    `).get(userId) as PermissionUserCandidate | undefined;
    return candidate ?? null;
  } finally {
    sqlite.close();
  }
}

function warnLegacyAdminFallback(userId: string, key: OrganizationPermissionKey, databaseProvider: string): void {
  console.warn('[OrganizationPermission] Legacy admin fallback granted organization permission.', {
    userId,
    permission: key,
    databaseProvider,
  });
}

export async function assertUserOrganizationPermission(
  userId: string,
  key: OrganizationPermissionKey,
  message?: string,
  user?: PermissionUserCandidate | null,
): Promise<OrganizationPermissionState> {
  const state = await readOrganizationPermissionForUser(userId);
  if (!state.configured) {
    const candidate = user ?? (await readPermissionUserCandidate(userId));
    if (isAdminUser(candidate)) {
      warnLegacyAdminFallback(userId, key, state.databaseProvider);
      return legacyFallbackState();
    }
  }

  assertOrganizationPermission(state.permission, key, message);
  return state;
}

function legacyFallbackState(): OrganizationPermissionState {
  return {
    configured: false,
    organizationId: null,
    ownerUserId: null,
    teamFeaturesEnabled: false,
    databaseProvider: getDatabaseProvider(),
    permission: LEGACY_ADMIN_PERMISSION,
  };
}

export async function requireOrganizationPermission(
  request: { headers: Headers },
  key: OrganizationPermissionKey,
  options: PermissionGuardOptions = {},
): Promise<OrganizationPermissionGuardResult> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const state = await readOrganizationPermissionForUser(session.user.id);
  if (!state.configured && options.legacyAdminFallback !== false && isAdminUser(session.user)) {
    warnLegacyAdminFallback(session.user.id, key, state.databaseProvider);

    return {
      ok: true,
      session,
      state: legacyFallbackState(),
      permission: LEGACY_ADMIN_PERMISSION,
    };
  }

  const permission = state.permission;
  if (!permission || permission[key] !== true) {
    return {
      ok: false,
      response: forbiddenResponse(key, options.errorMessage),
    };
  }

  return {
    ok: true,
    session,
    state,
    permission,
  };
}

export function isOrganizationAdminLike(permission: OrganizationPermissionSnapshot | null | undefined): boolean {
  return permission?.status === 'active' && (permission?.role === 'owner' || permission?.role === 'admin');
}

export function isOrganizationBillingApprover(
  permission: OrganizationPermissionSnapshot | null | undefined,
): boolean {
  return permission?.status === 'active' && permission.role === 'owner';
}

/**
 * Guards host-level capabilities that are not safe to delegate through a
 * granular member permission. Examples include configuring MCP stdio servers,
 * which can start a process with the Canvas service account.
 */
export async function assertUserOrganizationAdmin(
  userId: string,
  message = 'Organization admin permission required.',
): Promise<OrganizationPermissionState> {
  const state = await readOrganizationPermissionForUser(userId);
  if (!state.configured) {
    const user = await readPermissionUserCandidate(userId);
    if (isAdminUser(user)) {
      warnLegacyAdminFallback(userId, 'canSharePluginsAndSkills', state.databaseProvider);
      return legacyFallbackState();
    }
  }

  if (!isOrganizationAdminLike(state.permission)) {
    throw new Error(message);
  }
  return state;
}

function booleanFromDb(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function normalizeOrganizationRole(role: unknown): OrganizationPermissionSnapshot['role'] {
  if (role === 'owner' || role === 'admin' || role === 'external') return role;
  return 'member';
}

function normalizeOrganizationStatus(status: unknown): OrganizationPermissionSnapshot['status'] {
  if (status === 'disabled' || status === 'archived' || status === 'recovery_locked') return status;
  return 'active';
}

function snapshotPermissions(snapshot: OrganizationPermissionSnapshot): Record<OrganizationPermissionKey, boolean> {
  return ORGANIZATION_PERMISSION_KEYS.reduce((permissions, key) => {
    permissions[key] = snapshot[key] === true;
    return permissions;
  }, {} as Record<OrganizationPermissionKey, boolean>);
}

function detailsFromRow(row: PermissionDetailsRow): OrganizationPermissionUserDetails {
  const status = normalizeOrganizationStatus(row.status);
  const enabled = status === 'active';
  const snapshot: OrganizationPermissionSnapshot = {
    role: normalizeOrganizationRole(row.role),
    status,
    canWriteTeamWorkspace: enabled && booleanFromDb(row.can_write_team_workspace),
    canCreatePublicLinks: enabled && booleanFromDb(row.can_create_public_links),
    canCreateTeamAutomations: enabled && booleanFromDb(row.can_create_team_automations),
    canSharePluginsAndSkills: enabled && booleanFromDb(row.can_share_plugins_and_skills),
    canExport: enabled && booleanFromDb(row.can_export),
    canDeleteTeamFiles: enabled && booleanFromDb(row.can_delete_team_files),
    canDeleteStudioAssets: enabled && booleanFromDb(row.can_delete_studio_assets),
    canManageBackups: enabled && booleanFromDb(row.can_manage_backups),
    canManageOrganizationMemory: enabled && booleanFromDb(row.can_manage_organization_memory),
    canMigrateDatabase: enabled && booleanFromDb(row.can_migrate_database),
    canEnableKnowledge: enabled && booleanFromDb(row.can_enable_knowledge),
    canRecoverWorkspaces: enabled && booleanFromDb(row.can_recover_workspaces),
  };

  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: snapshot.role,
    status: snapshot.status,
    permissions: snapshotPermissions(snapshot),
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : null,
  };
}

async function getPrimaryOrganization(database: PermissionDatabase): Promise<OrganizationRow> {
  const organization = await database.get(`
    SELECT organization_id, owner_user_id
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `) as OrganizationRow | undefined;

  if (!organization) {
    throw new OrganizationPermissionMutationError(
      'ORGANIZATION_NOT_CONFIGURED',
      'Organization bootstrap has not been configured.',
      404,
    );
  }

  return organization;
}

async function getPermissionUser(database: PermissionDatabase, userId: string): Promise<PermissionUserRow> {
  const user = await database.get(`
    SELECT id, name, email, role, banned
    FROM "user"
    WHERE id = ?
    LIMIT 1
  `, [userId]) as PermissionUserRow | undefined;

  if (!user) {
    throw new OrganizationPermissionMutationError('USER_NOT_FOUND', 'User not found.', 404);
  }

  return user;
}

async function getPermissionDetails(
  database: PermissionDatabase,
  organizationId: string,
  userId: string,
): Promise<OrganizationPermissionUserDetails> {
  const row = await database.get(`
    SELECT
      p.user_id,
      p.organization_id,
      u.name,
      u.email,
      p.role,
      p.status,
      p.can_write_team_workspace,
      p.can_create_public_links,
      p.can_create_team_automations,
      p.can_share_plugins_and_skills,
      p.can_export,
      p.can_delete_team_files,
      p.can_delete_studio_assets,
      p.can_manage_backups,
      p.can_manage_organization_memory,
      p.can_migrate_database,
      p.can_enable_knowledge,
      p.can_recover_workspaces,
      p.updated_at
    FROM organization_user_permissions p
    INNER JOIN "user" u ON u.id = p.user_id
    WHERE p.organization_id = ? AND p.user_id = ?
    LIMIT 1
  `, [organizationId, userId]) as PermissionDetailsRow | undefined;

  if (!row) {
    throw new OrganizationPermissionMutationError('USER_NOT_FOUND', 'User permission row not found.', 404);
  }

  return detailsFromRow(row);
}

async function ensurePermissionDetails(
  database: PermissionDatabase,
  organization: OrganizationRow,
  user: PermissionUserRow,
): Promise<OrganizationPermissionUserDetails> {
  const defaultRole = organization.owner_user_id === user.id
    ? 'owner'
    : isAdminUser(user) ? 'admin' : 'member';
  await ensureOrganizationPermissionRow(database, {
    organizationId: organization.organization_id,
    userId: user.id,
    role: defaultRole,
    activateExisting: false,
  });

  return getPermissionDetails(database, organization.organization_id, user.id);
}

function assertActorCanMutate(actor: OrganizationPermissionUserDetails): void {
  if (actor.status !== 'active' || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new OrganizationPermissionMutationError(
      'ORGANIZATION_PERMISSION_DENIED',
      'Only organization owners or administrators can manage permissions.',
      403,
    );
  }
}

function assertTargetActive(target: OrganizationPermissionUserDetails): void {
  if (target.status !== 'active') {
    throw new OrganizationPermissionMutationError('USER_ARCHIVED', 'Archived users cannot be modified.', 409);
  }
}

function assertDelegatedPermissions(
  actor: OrganizationPermissionUserDetails,
  patch: OrganizationPermissionPatch,
): void {
  if (actor.role === 'owner') return;

  for (const key of ORGANIZATION_PERMISSION_KEYS) {
    if (patch[key] === true && actor.permissions[key] !== true) {
      throw new OrganizationPermissionMutationError(
        'PERMISSION_NOT_OWNED',
        `Cannot grant permission not owned by actor: ${key}`,
        403,
      );
    }
  }
}

function assertBootstrapAdminPermissionPatch(target: OrganizationPermissionUserDetails, patch: OrganizationPermissionPatch): void {
  if (!isBootstrapAdminEmail(target.email)) return;

  for (const key of ORGANIZATION_PERMISSION_KEYS) {
    if (patch[key] === false) {
      throw new OrganizationPermissionMutationError(
        'BOOTSTRAP_ADMIN_LOCKED',
        'The bootstrap admin cannot be downgraded.',
        409,
      );
    }
  }
}

function assertExternalPermissionPatch(targetRole: OrganizationPermissionSnapshot['role'], patch: OrganizationPermissionPatch): void {
  if (targetRole !== 'external') return;

  for (const key of ORGANIZATION_PERMISSION_KEYS) {
    if (patch[key] === true) {
      throw new OrganizationPermissionMutationError(
        'EXTERNAL_NO_ORG_PERMISSIONS',
        'External users cannot receive organization permissions.',
        409,
      );
    }
  }
}

async function assertAnotherAdminLikeExists(
  database: PermissionDatabase,
  organizationId: string,
  targetUserId: string,
): Promise<void> {
  const row = await database.get(`
    SELECT COUNT(*) AS count
    FROM organization_user_permissions
    WHERE organization_id = ?
      AND user_id <> ?
      AND status = 'active'
      AND role IN ('owner', 'admin')
  `, [organizationId, targetUserId]) as { count: number | string } | undefined;
  const count = typeof row?.count === 'number' ? row.count : Number(row?.count || 0);
  if (count < 1) {
    throw new OrganizationPermissionMutationError(
      'LAST_ADMIN_USER',
      'The last admin-capable user cannot be downgraded.',
      409,
    );
  }
}

async function withPermissionDatabase<T>(operation: (database: PermissionDatabase) => Promise<T>): Promise<T> {
  const database = await openDb();
  try {
    return await operation(database);
  } finally {
    await database.close?.();
  }
}

function changesFromRunResult(result: unknown): number {
  if (result && typeof result === 'object' && 'changes' in result) {
    return Number((result as { changes?: unknown }).changes || 0);
  }
  return 0;
}

export async function revokeOrganizationPermissionSessions(targetUserId: string): Promise<number> {
  return withPermissionDatabase(async (database) => {
    const result = await database.run('DELETE FROM session WHERE user_id = ?', [targetUserId]);
    return changesFromRunResult(result);
  });
}

export async function getOrganizationUserPermissionDetails(
  targetUserId: string,
  actorUserId?: string,
): Promise<OrganizationPermissionUserDetails> {
  return withPermissionDatabase(async (database) => {
    const organization = await getPrimaryOrganization(database);
    const targetUser = await getPermissionUser(database, targetUserId);
    const target = await ensurePermissionDetails(database, organization, targetUser);

    if (actorUserId && actorUserId !== targetUserId) {
      const actorUser = await getPermissionUser(database, actorUserId);
      const actor = await ensurePermissionDetails(database, organization, actorUser);
      assertActorCanMutate(actor);
    }

    return target;
  });
}

export async function updateOrganizationPermissions(params: {
  actorUserId: string;
  targetUserId: string;
  permissions: OrganizationPermissionPatch;
}): Promise<OrganizationPermissionUserDetails> {
  return withPermissionDatabase(async (database) => {
    await database.run('BEGIN');
    try {
      const organization = await getPrimaryOrganization(database);
      const actorUser = await getPermissionUser(database, params.actorUserId);
      const targetUser = await getPermissionUser(database, params.targetUserId);
      const actor = await ensurePermissionDetails(database, organization, actorUser);
      const target = await ensurePermissionDetails(database, organization, targetUser);

      assertActorCanMutate(actor);
      assertTargetActive(target);
      assertDelegatedPermissions(actor, params.permissions);
      assertBootstrapAdminPermissionPatch(target, params.permissions);
      assertExternalPermissionPatch(target.role, params.permissions);

      if (target.role === 'owner') {
        assertBootstrapAdminPermissionPatch(target, params.permissions);
        for (const key of ORGANIZATION_PERMISSION_KEYS) {
          if (params.permissions[key] === false) {
            throw new OrganizationPermissionMutationError('LAST_OWNER', 'The owner cannot be downgraded.', 409);
          }
        }
      }

      const changedKeys = ORGANIZATION_PERMISSION_KEYS.filter((key) => typeof params.permissions[key] === 'boolean');
      if (changedKeys.length > 0) {
        const assignments = changedKeys.map((key) => `${PERMISSION_COLUMNS[key]} = ?`).join(', ');
        await database.run(`
          UPDATE organization_user_permissions
          SET ${assignments}, updated_at = ?
          WHERE organization_id = ? AND user_id = ?
        `, [
          ...changedKeys.map((key) => params.permissions[key] === true ? 1 : 0),
          Date.now(),
          organization.organization_id,
          params.targetUserId,
        ]);
      }

      const updated = await getPermissionDetails(database, organization.organization_id, params.targetUserId);
      await database.run('COMMIT');
      return updated;
    } catch (error) {
      try {
        await database.run('ROLLBACK');
      } catch {
        // Preserve the original mutation error.
      }
      throw error;
    }
  });
}

export async function updateOrganizationRole(params: {
  actorUserId: string;
  targetUserId: string;
  role: Exclude<OrganizationPermissionSnapshot['role'], 'owner'>;
  externalUsersEnabled?: boolean;
}): Promise<OrganizationPermissionUserDetails> {
  return withPermissionDatabase(async (database) => {
    await database.run('BEGIN');
    try {
      const organization = await getPrimaryOrganization(database);
      const actorUser = await getPermissionUser(database, params.actorUserId);
      const targetUser = await getPermissionUser(database, params.targetUserId);
      const actor = await ensurePermissionDetails(database, organization, actorUser);
      const target = await ensurePermissionDetails(database, organization, targetUser);
      const role = params.role;

      assertActorCanMutate(actor);
      assertTargetActive(target);

      if (role === 'external' && !params.externalUsersEnabled) {
        throw new OrganizationPermissionMutationError(
          'EXTERNAL_USERS_DISABLED',
          'External users are not enabled.',
          403,
        );
      }
      if (target.role === 'owner') {
        throw new OrganizationPermissionMutationError('LAST_OWNER', 'The owner cannot be downgraded.', 409);
      }
      if (params.actorUserId === params.targetUserId && target.role === 'admin' && role !== 'admin') {
        throw new OrganizationPermissionMutationError('SELF_DOWNGRADE', 'You cannot downgrade yourself.', 409);
      }
      if (isBootstrapAdminEmail(target.email) && role !== 'admin') {
        throw new OrganizationPermissionMutationError(
          'BOOTSTRAP_ADMIN_LOCKED',
          'The bootstrap admin cannot be downgraded.',
          409,
        );
      }
      if (target.role === 'admin' && role !== 'admin') {
        await assertAnotherAdminLikeExists(database, organization.organization_id, params.targetUserId);
      }

      const defaults = organizationPermissionDefaults(role);
      const now = Date.now();
      await database.run(`
        UPDATE organization_user_permissions
        SET role = ?,
          can_write_team_workspace = ?,
          can_create_public_links = ?,
          can_create_team_automations = ?,
          can_share_plugins_and_skills = ?,
          can_export = ?,
          can_delete_team_files = ?,
          can_delete_studio_assets = ?,
          can_manage_backups = ?,
          can_manage_organization_memory = ?,
          can_migrate_database = ?,
          can_enable_knowledge = ?,
          can_recover_workspaces = ?,
          updated_at = ?
        WHERE organization_id = ? AND user_id = ?
      `, [
        role,
        defaults.canWriteTeamWorkspace ? 1 : 0,
        defaults.canCreatePublicLinks ? 1 : 0,
        defaults.canCreateTeamAutomations ? 1 : 0,
        defaults.canSharePluginsAndSkills ? 1 : 0,
        defaults.canExport ? 1 : 0,
        defaults.canDeleteTeamFiles ? 1 : 0,
        defaults.canDeleteStudioAssets ? 1 : 0,
        defaults.canManageBackups ? 1 : 0,
        defaults.canManageOrganizationMemory ? 1 : 0,
        defaults.canMigrateDatabase ? 1 : 0,
        defaults.canEnableKnowledge ? 1 : 0,
        defaults.canRecoverWorkspaces ? 1 : 0,
        now,
        organization.organization_id,
        params.targetUserId,
      ]);
      await database.run(
        'UPDATE "user" SET role = ?, updated_at = ? WHERE id = ?',
        [role === 'admin' ? 'admin' : 'user', now, params.targetUserId],
      );
      await updateTeamMembershipRole(database, {
        organizationId: organization.organization_id,
        userId: params.targetUserId,
        role,
        actorUserId: params.actorUserId,
        transactionMode: 'existing',
        now,
        databaseProvider: getDatabaseProvider(),
      });

      const updated = await getPermissionDetails(database, organization.organization_id, params.targetUserId);
      await database.run('COMMIT');
      return updated;
    } catch (error) {
      try {
        await database.run('ROLLBACK');
      } catch {
        // Preserve the original mutation error.
      }
      throw error;
    }
  });
}
