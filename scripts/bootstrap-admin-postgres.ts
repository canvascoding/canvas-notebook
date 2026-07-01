import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { hashPassword } from 'better-auth/crypto';
import type { PoolClient } from 'pg';

import {
  createPostgresPool,
  runPostgresMigrations,
} from '../app/lib/db/postgres';

const require = createRequire(import.meta.url);
const { loadAppEnv } = require('../server/load-app-env.js') as {
  loadAppEnv: (cwd?: string) => string | null;
};

loadAppEnv(process.cwd());

function normalizeEmail(email: string | undefined): string | null {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return normalized || null;
}

function getBootstrapAdminConfig() {
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator').trim() || 'Administrator';
  if (!email || !password) return null;
  return { email, password, name };
}

function getDataRoot(): string {
  const dataDir = process.env.DATA || path.resolve(process.cwd(), 'data');
  return path.isAbsolute(dataDir) ? dataDir : path.resolve(process.cwd(), dataDir);
}

function getDeploymentMode(): string {
  const explicit = process.env.CANVAS_DEPLOYMENT_MODE?.trim();
  if (explicit) return explicit;
  if (process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' || process.env.CANVAS_INSTANCE_TOKEN?.trim()) {
    return 'managed-single';
  }
  return 'single_user';
}

function normalizeDeploymentMode(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function isSingleUserDeploymentMode(deploymentMode: string): boolean {
  const normalized = normalizeDeploymentMode(deploymentMode);
  return normalized === 'community' ||
    normalized === 'single-user' ||
    normalized === 'singleuser' ||
    normalized === 'managed-single' ||
    normalized === 'local' ||
    normalized === 'development' ||
    normalized === 'dev';
}

function isTeamDeploymentMode(deploymentMode: string): boolean {
  const normalized = normalizeDeploymentMode(deploymentMode);
  if (isSingleUserDeploymentMode(normalized)) return false;
  return normalized.includes('team') ||
    normalized.includes('enterprise') ||
    normalized.includes('advanced');
}

function teamFeaturesEnabled(deploymentMode: string): boolean {
  if (isSingleUserDeploymentMode(deploymentMode)) return false;
  return isTruthyEnv(process.env.CANVAS_TEAM_FEATURES_ENABLED) || isTeamDeploymentMode(deploymentMode);
}

function workspaceAbsoluteRoot(rootRelativePath: string): string {
  if (path.isAbsolute(rootRelativePath) || rootRelativePath.includes('\0')) {
    throw new Error('Invalid workspace root path.');
  }
  const segments = rootRelativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Invalid workspace root path.');
  }
  return path.join(getDataRoot(), ...segments);
}

function ensureWorkspaceDirectory(rootRelativePath: string): void {
  mkdirSync(workspaceAbsoluteRoot(rootRelativePath), { recursive: true });
}

function ensureScopedDirectories(organizationId: string, userId: string, includeTeamWorkspace: boolean): void {
  const dataRoot = getDataRoot();
  const directories = [
    path.join(dataRoot, 'workspaces', 'personal', userId, 'files'),
    path.join(dataRoot, 'users', userId, 'settings'),
    path.join(dataRoot, 'users', userId, 'secrets'),
    path.join(dataRoot, 'users', userId, 'agents'),
    path.join(dataRoot, 'users', userId, 'skills'),
    path.join(dataRoot, 'users', userId, 'plugins'),
    path.join(dataRoot, 'users', userId, 'mcp'),
    path.join(dataRoot, 'users', userId, 'mail'),
    path.join(dataRoot, 'organizations', organizationId, 'secrets'),
    path.join(dataRoot, 'organizations', organizationId, 'policies'),
    path.join(dataRoot, 'organizations', organizationId, 'agent-templates'),
    path.join(dataRoot, 'organizations', organizationId, 'mcp-templates'),
    path.join(dataRoot, 'organizations', organizationId, 'skill-templates'),
    path.join(dataRoot, 'organizations', organizationId, 'plugin-templates'),
    path.join(dataRoot, 'system', 'backups'),
    path.join(dataRoot, 'system', 'migration'),
    path.join(dataRoot, 'system', 'logs'),
    path.join(dataRoot, 'system', 'settings'),
  ];
  if (includeTeamWorkspace) {
    directories.push(path.join(dataRoot, 'workspaces', 'team', organizationId, 'files'));
  }
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
  }
}

async function findUserByEmail(client: PoolClient, email: string) {
  const result = await client.query(
    'SELECT id, email, role, name FROM "user" WHERE lower(email) = $1 LIMIT 1',
    [email],
  );
  return result.rows[0] || null;
}

async function findUserById(client: PoolClient, userId: string) {
  const result = await client.query(
    'SELECT id, email, role, created_at FROM "user" WHERE id = $1 LIMIT 1',
    [userId],
  );
  return result.rows[0] || null;
}

async function findBootstrapTargetUser(client: PoolClient) {
  const result = await client.query(`
    SELECT id, email, role, name
    FROM "user"
    ORDER BY
      CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
      created_at ASC
    LIMIT 1
  `);
  return result.rows[0] || null;
}

function permissionValues(role: 'owner' | 'admin') {
  const isOwner = role === 'owner';
  return [
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
  ];
}

async function ensurePermissionRow(client: PoolClient, organizationId: string, userId: string, requestedRole: 'owner' | 'admin') {
  const existing = await client.query(
    'SELECT role FROM organization_user_permissions WHERE organization_id = $1 AND user_id = $2 LIMIT 1',
    [organizationId, userId],
  );
  const role = existing.rows[0]?.role === 'owner' ? 'owner' : requestedRole;
  const now = Date.now();
  await client.query(
    `
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role,
        can_write_team_workspace, can_create_public_links, can_create_team_automations,
        can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
        can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT(organization_id, user_id) DO UPDATE SET
        role = excluded.role,
        updated_at = excluded.updated_at
    `,
    [organizationId, userId, role, ...permissionValues(role), now, now],
  );
}

async function ensureWorkspaceRecord(client: PoolClient, input: {
  organizationId: string;
  type: 'personal' | 'team';
  ownerUserId: string | null;
  rootRelativePath: string;
  displayName: string;
}) {
  const existing = input.type === 'personal'
    ? await client.query(
        "SELECT id FROM canvas_workspaces WHERE type = 'personal' AND owner_user_id = $1 LIMIT 1",
        [input.ownerUserId],
      )
    : await client.query(
        "SELECT id FROM canvas_workspaces WHERE type = 'team' AND organization_id = $1 LIMIT 1",
        [input.organizationId],
      );
  const now = Date.now();

  if (existing.rows[0]) {
    await client.query(
      'UPDATE canvas_workspaces SET root_relative_path = $1, display_name = $2, updated_at = $3 WHERE id = $4',
      [input.rootRelativePath, input.displayName, now, existing.rows[0].id],
    );
    ensureWorkspaceDirectory(input.rootRelativePath);
    return existing.rows[0];
  }

  const id = `ws_${randomUUID()}`;
  await client.query(
    `
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
    `,
    [id, input.organizationId, input.type, input.ownerUserId, input.rootRelativePath, input.displayName, now, now],
  );
  ensureWorkspaceDirectory(input.rootRelativePath);
  return { id };
}

async function ensureOrganizationBootstrap(client: PoolClient, userId: string) {
  const targetUser = await findUserById(client, userId);
  if (!targetUser) {
    throw new Error('Cannot bootstrap organization without a valid user.');
  }

  const deploymentMode = getDeploymentMode();
  const includeTeamWorkspace = teamFeaturesEnabled(deploymentMode);
  const now = Date.now();
  const existing = await client.query(`
    SELECT organization_id, owner_user_id, deployment_mode, team_features_enabled
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `);
  let organization = existing.rows[0] || null;

  if (organization) {
    const configuredOrganizationId = process.env.CANVAS_ORGANIZATION_ID?.trim();
    if (configuredOrganizationId && configuredOrganizationId !== organization.organization_id) {
      throw new Error(`Persisted organization ${organization.organization_id} does not match CANVAS_ORGANIZATION_ID ${configuredOrganizationId}.`);
    }
    await client.query(
      'UPDATE canvas_organization_settings SET deployment_mode = $1, team_features_enabled = $2, updated_at = $3 WHERE organization_id = $4',
      [deploymentMode, includeTeamWorkspace ? 1 : 0, now, organization.organization_id],
    );
  } else {
    const organizationId = process.env.CANVAS_ORGANIZATION_ID?.trim() || `org_${randomUUID()}`;
    await client.query(
      `
        INSERT INTO canvas_organization_settings (
          organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [organizationId, userId, deploymentMode, includeTeamWorkspace ? 1 : 0, now, now],
    );
    organization = { organization_id: organizationId, owner_user_id: userId };
  }

  const ownerUser = await findUserById(client, organization.owner_user_id) || targetUser;
  await client.query('UPDATE "user" SET role = $1, updated_at = $2 WHERE id = $3', ['admin', now, ownerUser.id]);
  await ensurePermissionRow(client, organization.organization_id, ownerUser.id, 'owner');
  if (targetUser.id !== ownerUser.id) {
    await client.query('UPDATE "user" SET role = $1, updated_at = $2 WHERE id = $3', ['admin', now, targetUser.id]);
    await ensurePermissionRow(client, organization.organization_id, targetUser.id, 'admin');
  }

  ensureScopedDirectories(organization.organization_id, ownerUser.id, includeTeamWorkspace);
  await ensureWorkspaceRecord(client, {
    organizationId: organization.organization_id,
    type: 'personal',
    ownerUserId: ownerUser.id,
    rootRelativePath: path.posix.join('workspaces', 'personal', ownerUser.id, 'files'),
    displayName: 'Personal Workspace',
  });
  if (includeTeamWorkspace) {
    await ensureWorkspaceRecord(client, {
      organizationId: organization.organization_id,
      type: 'team',
      ownerUserId: null,
      rootRelativePath: path.posix.join('workspaces', 'team', organization.organization_id, 'files'),
      displayName: 'Team Workspace',
    });
  }
}

async function ensureCredentialPassword(client: PoolClient, userId: string, passwordHash: string) {
  const existingAccount = await client.query(
    'SELECT id FROM account WHERE user_id = $1 AND provider_id = $2 LIMIT 1',
    [userId, 'credential'],
  );
  const now = Date.now();

  if (existingAccount.rows[0]) {
    await client.query(
      'UPDATE account SET account_id = $1, password = $2, updated_at = $3 WHERE id = $4',
      [userId, passwordHash, now, existingAccount.rows[0].id],
    );
    return;
  }

  await client.query(
    `
      INSERT INTO account (
        id, account_id, provider_id, user_id, password, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [randomUUID(), userId, 'credential', userId, passwordHash, now, now],
  );
}

async function updateExistingUser(client: PoolClient, userId: string, email: string, name: string) {
  await client.query(
    'UPDATE "user" SET name = $1, email = $2, role = $3, updated_at = $4 WHERE id = $5',
    [name, email, 'admin', Date.now(), userId],
  );
}

async function insertUser(client: PoolClient, email: string, name: string) {
  const userId = randomUUID();
  const now = Date.now();
  await client.query(
    `
      INSERT INTO "user" (
        id, name, email, email_verified, image, role, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [userId, name, email, 1, null, 'admin', now, now],
  );
  return userId;
}

async function main() {
  const bootstrapAdmin = getBootstrapAdminConfig();
  if (!bootstrapAdmin) {
    console.log('[bootstrap-admin] Skipped (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set).');
    return;
  }

  const pool = createPostgresPool();
  await runPostgresMigrations(pool);
  const client = await pool.connect();
  console.log('[bootstrap-admin] Using Postgres database.');

  try {
    const { email, password, name } = bootstrapAdmin;
    const passwordHash = await hashPassword(password);
    await client.query('BEGIN');

    const existingUser = await findUserByEmail(client, email);
    if (existingUser) {
      await updateExistingUser(client, existingUser.id, email, name);
      await ensureCredentialPassword(client, existingUser.id, passwordHash);
      await ensureOrganizationBootstrap(client, existingUser.id);
      await client.query('COMMIT');
      console.log(`[bootstrap-admin] Synced bootstrap admin user: ${email}`);
      return;
    }

    const targetUser = await findBootstrapTargetUser(client);
    if (targetUser) {
      await updateExistingUser(client, targetUser.id, email, name);
      await ensureCredentialPassword(client, targetUser.id, passwordHash);
      await ensureOrganizationBootstrap(client, targetUser.id);
      await client.query('COMMIT');
      console.log(`[bootstrap-admin] Updated existing admin credentials: ${targetUser.email} -> ${email}`);
      return;
    }

    const userId = await insertUser(client, email, name);
    await ensureCredentialPassword(client, userId, passwordHash);
    await ensureOrganizationBootstrap(client, userId);
    await client.query('COMMIT');
    console.log(`[bootstrap-admin] Created admin user: ${email}`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors; the original error is more useful.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[bootstrap-admin] Failed:', error);
  process.exit(1);
});
