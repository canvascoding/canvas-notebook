import 'server-only';

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

import { runMigrations } from '@/app/lib/db/migrate';
import { openDb } from '@/app/lib/db';
import {
  getDatabaseProviderProblemMessages,
  getDatabaseProvider,
  resolveDatabaseProviderGate,
  resolveSqlitePath,
} from '@/app/lib/db/provider';
import {
  areTeamFeaturesEnabled,
  ensureOrganizationBootstrapForUser,
  getDeploymentMode,
  LOCAL_ORGANIZATION_ID_PREFIX,
  OrganizationBootstrapError,
} from '@/app/lib/organization/bootstrap';
import { resolveWorkspaceDataRoot } from '@/app/lib/workspaces/context';

export const SETUP_PASSWORD_MIN_LENGTH = 8;
export const SETUP_PASSWORD_MAX_LENGTH = 128;

export type InitialOwnerInput = {
  name: string;
  email: string;
  password: string;
};

export type InitialOwner = {
  id: string;
  name: string;
  email: string;
};

type ValidationResult =
  | { ok: true; value: InitialOwnerInput }
  | { ok: false; error: string; field?: keyof InitialOwnerInput };

type UserRow = {
  id: string;
  email: string | null;
  role: string | null;
  created_at: number;
};

type OrganizationRow = {
  organization_id: string;
  owner_user_id: string;
  deployment_mode: string;
  team_features_enabled: number;
  created_at: number;
  updated_at: number;
};

export class InitialOwnerSetupError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'ALREADY_CONFIGURED'
      | 'DATABASE_PROVIDER_BLOCKED'
      | 'DATABASE_ERROR',
    message: string,
    public readonly field?: keyof InitialOwnerInput,
  ) {
    super(message);
    this.name = 'InitialOwnerSetupError';
  }
}

function getSqlitePath(): string {
  return resolveSqlitePath();
}

function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function normalizeName(name: unknown): string {
  return typeof name === 'string' ? name.trim() : '';
}

function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateInitialOwnerInput(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid setup payload.' };
  }

  const payload = input as Partial<Record<keyof InitialOwnerInput, unknown>>;
  const name = normalizeName(payload.name);
  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!name || name.length > 100) {
    return { ok: false, field: 'name', error: 'Name must be between 1 and 100 characters.' };
  }

  if (!isValidEmail(email)) {
    return { ok: false, field: 'email', error: 'Enter a valid email address.' };
  }

  if (password.length < SETUP_PASSWORD_MIN_LENGTH || password.length > SETUP_PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      field: 'password',
      error: `Password must be between ${SETUP_PASSWORD_MIN_LENGTH} and ${SETUP_PASSWORD_MAX_LENGTH} characters.`,
    };
  }

  return { ok: true, value: { name, email, password } };
}

function openSetupDatabase() {
  const sqlitePath = getSqlitePath();
  mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = new Database(sqlitePath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  runMigrations(sqlite);
  return sqlite;
}

function assertSetupDatabaseProviderAllowed(): void {
  const deploymentMode = getDeploymentMode();
  const gate = resolveDatabaseProviderGate({
    teamFeaturesEnabled: areTeamFeaturesEnabled(deploymentMode),
  });

  if (!gate.ok) {
    throw new InitialOwnerSetupError(
      'DATABASE_PROVIDER_BLOCKED',
      getDatabaseProviderProblemMessages(gate.blockers).join(' '),
    );
  }
}

function countUsers(sqlite: Database.Database): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM user').get() as { count?: number } | undefined;
  return Number(row?.count || 0);
}

async function getPostgresAuthUserCount(): Promise<number> {
  const database = await openDb();
  try {
    const row = await database.get('SELECT COUNT(*) AS count FROM user') as { count?: string | number } | undefined;
    return Number(row?.count || 0);
  } finally {
    await database.close();
  }
}

export async function getAuthUserCount(): Promise<number> {
  if (getDatabaseProvider() === 'postgres') {
    return getPostgresAuthUserCount();
  }

  const sqlite = openSetupDatabase();
  try {
    return countUsers(sqlite);
  } finally {
    sqlite.close();
  }
}

export async function hasAnyAuthUser(): Promise<boolean> {
  return (await getAuthUserCount()) > 0;
}

async function getPostgresUser(database: Awaited<ReturnType<typeof openDb>>, userId: string) {
  return await database.get(
    'SELECT id, email, role, created_at FROM user WHERE id = ? LIMIT 1',
    [userId],
  ) as UserRow | undefined || null;
}

async function ensurePostgresPermissionRow(
  database: Awaited<ReturnType<typeof openDb>>,
  organizationId: string,
  userId: string,
  requestedRole: 'owner' | 'admin',
): Promise<void> {
  const existing = await database.get(
    'SELECT role FROM organization_user_permissions WHERE organization_id = ? AND user_id = ? LIMIT 1',
    [organizationId, userId],
  ) as { role?: string } | undefined;
  const role = existing?.role === 'owner' ? 'owner' : requestedRole;
  const isOwner = role === 'owner';
  const now = Date.now();

  await database.run(
    `
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role,
        can_write_team_workspace, can_create_public_links, can_create_team_automations,
        can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
        can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, user_id) DO UPDATE SET
        role = excluded.role,
        updated_at = excluded.updated_at
    `,
    [
      organizationId,
      userId,
      role,
      isOwner ? 1 : 0,
      1,
      isOwner ? 1 : 0,
      isOwner ? 1 : 0,
      isOwner ? 1 : 0,
      isOwner ? 1 : 0,
      1,
      isOwner ? 1 : 0,
      isOwner ? 1 : 0,
      isOwner ? 1 : 0,
      isOwner ? 1 : 0,
      now,
      now,
    ],
  );
}

function ensureSetupWorkspaceDirectory(rootRelativePath: string): void {
  const dataRoot = resolveWorkspaceDataRoot();
  const segments = rootRelativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Invalid workspace root path');
  }
  mkdirSync(path.join(dataRoot, ...segments), { recursive: true });
}

async function ensurePostgresWorkspaceRecord(
  database: Awaited<ReturnType<typeof openDb>>,
  input: {
    organizationId: string;
    type: 'personal' | 'team';
    ownerUserId: string | null;
    rootRelativePath: string;
    displayName: string;
  },
): Promise<void> {
  const existing = input.type === 'personal'
    ? await database.get(
        "SELECT id FROM canvas_workspaces WHERE type = 'personal' AND owner_user_id = ? LIMIT 1",
        [input.ownerUserId],
      ) as { id: string } | undefined
    : await database.get(
        "SELECT id FROM canvas_workspaces WHERE type = 'team' AND organization_id = ? LIMIT 1",
        [input.organizationId],
      ) as { id: string } | undefined;
  const now = Date.now();

  if (existing) {
    await database.run(
      'UPDATE canvas_workspaces SET root_relative_path = ?, display_name = ?, updated_at = ? WHERE id = ?',
      [input.rootRelativePath, input.displayName, now, existing.id],
    );
    ensureSetupWorkspaceDirectory(input.rootRelativePath);
    return;
  }

  await database.run(
    `
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `,
    [
      `ws_${randomUUID()}`,
      input.organizationId,
      input.type,
      input.ownerUserId,
      input.rootRelativePath,
      input.displayName,
      now,
      now,
    ],
  );
  ensureSetupWorkspaceDirectory(input.rootRelativePath);
}

async function ensurePostgresOrganizationBootstrapForUser(
  database: Awaited<ReturnType<typeof openDb>>,
  userId: string,
): Promise<void> {
  const targetUser = await getPostgresUser(database, userId);
  if (!targetUser) {
    throw new OrganizationBootstrapError('NO_USERS', 'Cannot bootstrap organization without a valid user.');
  }

  const deploymentMode = getDeploymentMode();
  const teamFeaturesEnabled = areTeamFeaturesEnabled(deploymentMode);
  const now = Date.now();
  let organization = await database.get(
    `
      SELECT organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      FROM canvas_organization_settings
      ORDER BY created_at ASC
      LIMIT 1
    `,
  ) as OrganizationRow | undefined || null;

  if (organization) {
    const configuredOrganizationId = process.env.CANVAS_ORGANIZATION_ID?.trim();
    if (configuredOrganizationId && configuredOrganizationId !== organization.organization_id) {
      throw new OrganizationBootstrapError(
        'ORGANIZATION_ID_CONFLICT',
        `Persisted organization ${organization.organization_id} does not match CANVAS_ORGANIZATION_ID ${configuredOrganizationId}.`,
      );
    }
    await database.run(
      'UPDATE canvas_organization_settings SET deployment_mode = ?, team_features_enabled = ?, updated_at = ? WHERE organization_id = ?',
      [deploymentMode, teamFeaturesEnabled ? 1 : 0, now, organization.organization_id],
    );
  } else {
    const organizationId = process.env.CANVAS_ORGANIZATION_ID?.trim() || `${LOCAL_ORGANIZATION_ID_PREFIX}${randomUUID()}`;
    await database.run(
      `
        INSERT INTO canvas_organization_settings (
          organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [organizationId, userId, deploymentMode, teamFeaturesEnabled ? 1 : 0, now, now],
    );
    organization = {
      organization_id: organizationId,
      owner_user_id: userId,
      deployment_mode: deploymentMode,
      team_features_enabled: teamFeaturesEnabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
  }

  const ownerUser = await getPostgresUser(database, organization.owner_user_id) || targetUser;
  await database.run('UPDATE user SET role = ?, updated_at = ? WHERE id = ?', ['admin', now, ownerUser.id]);
  await ensurePostgresPermissionRow(database, organization.organization_id, ownerUser.id, 'owner');
  if (targetUser.id !== ownerUser.id) {
    await database.run('UPDATE user SET role = ?, updated_at = ? WHERE id = ?', ['admin', now, targetUser.id]);
    await ensurePostgresPermissionRow(database, organization.organization_id, targetUser.id, 'admin');
  }

  await ensurePostgresWorkspaceRecord(database, {
    organizationId: organization.organization_id,
    type: 'personal',
    ownerUserId: ownerUser.id,
    rootRelativePath: path.posix.join('workspaces', 'personal', ownerUser.id, 'files'),
    displayName: 'Personal Workspace',
  });
  if (teamFeaturesEnabled) {
    await ensurePostgresWorkspaceRecord(database, {
      organizationId: organization.organization_id,
      type: 'team',
      ownerUserId: null,
      rootRelativePath: path.posix.join('workspaces', 'team', organization.organization_id, 'files'),
      displayName: 'Team Workspace',
    });
  }
}

async function createInitialOwnerPostgres(input: InitialOwnerInput): Promise<InitialOwner> {
  const { name, email, password } = input;
  assertSetupDatabaseProviderAllowed();
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const accountId = randomUUID();
  const now = Date.now();
  const database = await openDb();

  try {
    await database.run('BEGIN');

    const count = await database.get('SELECT COUNT(*) AS count FROM user') as { count?: string | number } | undefined;
    if (Number(count?.count || 0) > 0) {
      await database.run('ROLLBACK');
      throw new InitialOwnerSetupError('ALREADY_CONFIGURED', 'Initial setup is already complete.');
    }

    await database.run(
      `
        INSERT INTO user (
          id, name, email, email_verified, image, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [userId, name, email, 1, null, 'admin', now, now],
    );

    await database.run(
      `
        INSERT INTO account (
          id, account_id, provider_id, user_id, password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [accountId, userId, 'credential', userId, passwordHash, now, now],
    );

    await ensurePostgresOrganizationBootstrapForUser(database, userId);

    await database.run('COMMIT');
    return { id: userId, name, email };
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Ignore rollback errors after a handled rollback.
    }
    if (error instanceof InitialOwnerSetupError) {
      throw error;
    }
    throw new InitialOwnerSetupError('DATABASE_ERROR', 'Could not create initial owner.');
  } finally {
    await database.close();
  }
}

export async function createInitialOwner(input: unknown): Promise<InitialOwner> {
  const validation = validateInitialOwnerInput(input);
  if (!validation.ok) {
    throw new InitialOwnerSetupError('INVALID_INPUT', validation.error, validation.field);
  }

  const { name, email, password } = validation.value;
  if (getDatabaseProvider() === 'postgres') {
    return createInitialOwnerPostgres({ name, email, password });
  }

  assertSetupDatabaseProviderAllowed();
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const accountId = randomUUID();
  const now = Date.now();
  const sqlite = openSetupDatabase();

  try {
    sqlite.exec('BEGIN IMMEDIATE');

    if (countUsers(sqlite) > 0) {
      sqlite.exec('ROLLBACK');
      throw new InitialOwnerSetupError('ALREADY_CONFIGURED', 'Initial setup is already complete.');
    }

    sqlite.prepare(`
      INSERT INTO user (
        id, name, email, email_verified, image, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, name, email, 1, null, 'admin', now, now);

    sqlite.prepare(`
      INSERT INTO account (
        id, account_id, provider_id, user_id, password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, userId, 'credential', userId, passwordHash, now, now);

    ensureOrganizationBootstrapForUser(sqlite, userId);

    sqlite.exec('COMMIT');
    return { id: userId, name, email };
  } catch (error) {
    if (sqlite.inTransaction) {
      sqlite.exec('ROLLBACK');
    }
    if (error instanceof InitialOwnerSetupError) {
      throw error;
    }
    throw new InitialOwnerSetupError('DATABASE_ERROR', 'Could not create initial owner.');
  } finally {
    sqlite.close();
  }
}
