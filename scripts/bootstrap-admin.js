const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const Database = require('better-sqlite3');
const { hashPassword } = require('better-auth/crypto');
const { loadAppEnv } = require('../server/load-app-env.js');

loadAppEnv(process.cwd());

function normalizeEmail(email) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return normalized || null;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      value += chunk;
    });
    process.stdin.on('end', () => {
      resolve(value.replace(/\r?\n$/, ''));
    });
    process.stdin.on('error', reject);
  });
}

function printCliUsage() {
  console.log(`Usage:
  node scripts/bootstrap-admin.js
  node scripts/bootstrap-admin.js --email <email> [--name <name>] --password-stdin

Without CLI options, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are read from the environment.`);
}

async function getBootstrapAdminConfigFromArgs(args) {
  let email = null;
  let name = 'Administrator';
  let passwordStdin = false;
  let hasCliOptions = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--email') {
      hasCliOptions = true;
      index += 1;
      if (index >= args.length) {
        throw new Error('--email requires a value.');
      }
      email = args[index];
      continue;
    }

    if (arg.startsWith('--email=')) {
      hasCliOptions = true;
      email = arg.slice('--email='.length);
      continue;
    }

    if (arg === '--name') {
      hasCliOptions = true;
      index += 1;
      if (index >= args.length) {
        throw new Error('--name requires a value.');
      }
      name = args[index];
      continue;
    }

    if (arg.startsWith('--name=')) {
      hasCliOptions = true;
      name = arg.slice('--name='.length);
      continue;
    }

    if (arg === '--password-stdin') {
      hasCliOptions = true;
      passwordStdin = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      printCliUsage();
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!hasCliOptions) {
    return null;
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('--email is required when using CLI bootstrap options.');
  }

  if (!passwordStdin) {
    throw new Error('--password-stdin is required when using CLI bootstrap options.');
  }

  const password = await readStdin();
  if (!password) {
    throw new Error('Password stdin was empty.');
  }

  return {
    email: normalizedEmail,
    password,
    name: name.trim() || 'Administrator',
  };
}

async function getBootstrapAdminConfig() {
  const cliConfig = await getBootstrapAdminConfigFromArgs(process.argv.slice(2));
  if (cliConfig) {
    return cliConfig;
  }

  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator').trim() || 'Administrator';

  if (!email || !password) {
    return null;
  }

  return { email, password, name };
}

function getSqlitePath() {
  const dataDir = process.env.DATA || path.resolve(process.cwd(), 'data');
  return path.join(dataDir, 'sqlite.db');
}

function ensureBootstrapTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL,
  image TEXT,
  role TEXT,
  banned INTEGER,
  ban_reason TEXT,
  ban_expires INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_unique ON user (email);

CREATE TABLE IF NOT EXISTS canvas_organization_settings (
  organization_id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  deployment_mode TEXT NOT NULL DEFAULT 'single_user',
  team_features_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES user(id)
);

CREATE TABLE IF NOT EXISTS organization_user_permissions (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  can_write_team_workspace INTEGER NOT NULL DEFAULT 0,
  can_create_public_links INTEGER NOT NULL DEFAULT 1,
  can_create_team_automations INTEGER NOT NULL DEFAULT 0,
  can_share_plugins_and_skills INTEGER NOT NULL DEFAULT 0,
  can_export INTEGER NOT NULL DEFAULT 0,
  can_delete_team_files INTEGER NOT NULL DEFAULT 0,
  can_delete_studio_assets INTEGER NOT NULL DEFAULT 1,
  can_manage_backups INTEGER NOT NULL DEFAULT 0,
  can_migrate_database INTEGER NOT NULL DEFAULT 0,
  can_enable_knowledge INTEGER NOT NULL DEFAULT 0,
  can_recover_workspaces INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE INDEX IF NOT EXISTS idx_canvas_org_settings_owner ON canvas_organization_settings (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_org_user_permissions_user ON organization_user_permissions (user_id);
CREATE INDEX IF NOT EXISTS idx_org_user_permissions_role ON organization_user_permissions (organization_id, role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_user_permissions_single_owner ON organization_user_permissions (organization_id) WHERE role = 'owner';
`);

  for (const [column, definition] of [
    ['banned', 'INTEGER'],
    ['ban_reason', 'TEXT'],
    ['ban_expires', 'INTEGER'],
  ]) {
    const exists = db.prepare('PRAGMA table_info(user)').all().some((row) => row.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE user ADD COLUMN ${column} ${definition}`);
    }
  }
}

function openDatabase() {
  const sqlitePath = getSqlitePath();
  const db = new Database(sqlitePath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  ensureBootstrapTables(db);
  return { db, sqlitePath };
}

function findUserByEmail(db, email) {
  return db.prepare('SELECT id, email, role, name FROM user WHERE lower(email) = ? LIMIT 1').get(email) || null;
}

function findBootstrapTargetUser(db) {
  return db.prepare(`
    SELECT id, email, role, name
    FROM user
    ORDER BY
      CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
      created_at ASC
    LIMIT 1
  `).get() || null;
}

function getDataRoot() {
  const dataDir = process.env.DATA || path.resolve(process.cwd(), 'data');
  return path.isAbsolute(dataDir) ? dataDir : path.resolve(process.cwd(), dataDir);
}

function getConfiguredOrganizationId() {
  const value = process.env.CANVAS_ORGANIZATION_ID?.trim();
  return value || null;
}

function getDeploymentMode() {
  const explicit = process.env.CANVAS_DEPLOYMENT_MODE?.trim();
  if (explicit) return explicit;
  if (process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' || process.env.CANVAS_INSTANCE_TOKEN?.trim()) {
    return 'managed-single';
  }
  return 'single_user';
}

function teamFeaturesEnabled(deploymentMode) {
  const explicit = process.env.CANVAS_TEAM_FEATURES_ENABLED;
  return explicit === 'true' || explicit === '1' || explicit === 'yes' || deploymentMode.toLowerCase().includes('team');
}

function getPrimaryOrganization(db) {
  return db.prepare(`
    SELECT organization_id, owner_user_id, deployment_mode, team_features_enabled
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `).get() || null;
}

function findUserById(db, userId) {
  return db.prepare('SELECT id, email, role, created_at FROM user WHERE id = ? LIMIT 1').get(userId) || null;
}

function assertOrganizationIdMatchesEnvironment(organizationId) {
  const configuredOrganizationId = getConfiguredOrganizationId();
  if (configuredOrganizationId && configuredOrganizationId !== organizationId) {
    throw new Error(`Persisted organization ${organizationId} does not match CANVAS_ORGANIZATION_ID ${configuredOrganizationId}.`);
  }
}

function permissionDefaults(role) {
  const isAdminLike = role === 'owner' || role === 'admin';
  const isInternal = role !== 'external';
  return {
    role,
    canWriteTeamWorkspace: isAdminLike,
    canCreatePublicLinks: isInternal,
    canCreateTeamAutomations: isAdminLike,
    canSharePluginsAndSkills: isAdminLike,
    canExport: isAdminLike,
    canDeleteTeamFiles: isAdminLike,
    canDeleteStudioAssets: isInternal,
    canManageBackups: isAdminLike,
    canMigrateDatabase: isAdminLike,
    canEnableKnowledge: isAdminLike,
    canRecoverWorkspaces: isAdminLike,
  };
}

function ensurePermissionRow(db, organizationId, userId, requestedRole) {
  const existing = db.prepare(`
    SELECT role
    FROM organization_user_permissions
    WHERE organization_id = ? AND user_id = ?
    LIMIT 1
  `).get(organizationId, userId);
  const role = existing?.role === 'owner' ? 'owner' : requestedRole;
  const defaults = permissionDefaults(role);
  const now = Date.now();

  db.prepare(`
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
  `).run(
    organizationId,
    userId,
    defaults.role,
    defaults.canWriteTeamWorkspace ? 1 : 0,
    defaults.canCreatePublicLinks ? 1 : 0,
    defaults.canCreateTeamAutomations ? 1 : 0,
    defaults.canSharePluginsAndSkills ? 1 : 0,
    defaults.canExport ? 1 : 0,
    defaults.canDeleteTeamFiles ? 1 : 0,
    defaults.canDeleteStudioAssets ? 1 : 0,
    defaults.canManageBackups ? 1 : 0,
    defaults.canMigrateDatabase ? 1 : 0,
    defaults.canEnableKnowledge ? 1 : 0,
    defaults.canRecoverWorkspaces ? 1 : 0,
    now,
    now,
  );
}

function ensureScopedDirectories(organizationId, userId, includeTeamWorkspace) {
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
  ];
  if (includeTeamWorkspace) {
    directories.push(path.join(dataRoot, 'workspaces', 'team', organizationId, 'files'));
  }
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
  }
}

function ensureOrganizationBootstrap(db, userId) {
  const targetUser = findUserById(db, userId);
  if (!targetUser) {
    throw new Error('Cannot bootstrap organization without a valid user.');
  }

  const deploymentMode = getDeploymentMode();
  const includeTeamWorkspace = teamFeaturesEnabled(deploymentMode);
  const now = Date.now();
  let organization = getPrimaryOrganization(db);

  if (organization) {
    assertOrganizationIdMatchesEnvironment(organization.organization_id);
    db.prepare(`
      UPDATE canvas_organization_settings
      SET deployment_mode = ?, team_features_enabled = ?, updated_at = ?
      WHERE organization_id = ?
    `).run(deploymentMode, includeTeamWorkspace ? 1 : 0, now, organization.organization_id);
  } else {
    const organizationId = getConfiguredOrganizationId() || `org_${randomUUID()}`;
    db.prepare(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(organizationId, userId, deploymentMode, includeTeamWorkspace ? 1 : 0, now, now);
    organization = {
      organization_id: organizationId,
      owner_user_id: userId,
    };
  }

  const ownerUser = findUserById(db, organization.owner_user_id) || targetUser;
  db.prepare('UPDATE user SET role = ?, updated_at = ? WHERE id = ?').run('admin', now, ownerUser.id);
  ensurePermissionRow(db, organization.organization_id, ownerUser.id, 'owner');
  if (targetUser.id !== ownerUser.id) {
    db.prepare('UPDATE user SET role = ?, updated_at = ? WHERE id = ?').run('admin', now, targetUser.id);
    ensurePermissionRow(db, organization.organization_id, targetUser.id, 'admin');
  }
  ensureScopedDirectories(organization.organization_id, ownerUser.id, includeTeamWorkspace);
  if (targetUser.id !== ownerUser.id) {
    ensureScopedDirectories(organization.organization_id, targetUser.id, includeTeamWorkspace);
  }
}

function ensureCredentialPassword(db, userId, passwordHash) {
  const existingAccount = db
    .prepare('SELECT id FROM account WHERE user_id = ? AND provider_id = ? LIMIT 1')
    .get(userId, 'credential');

  const now = Date.now();

  if (existingAccount) {
    db.prepare(`
      UPDATE account
      SET account_id = ?, password = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, passwordHash, now, existingAccount.id);
    return;
  }

  db.prepare(`
    INSERT INTO account (
      id, account_id, provider_id, user_id, password, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, 'credential', userId, passwordHash, now, now);
}

function updateExistingUser(db, userId, email, name) {
  db.prepare(`
    UPDATE user
    SET name = ?, email = ?, role = ?, updated_at = ?
    WHERE id = ?
  `).run(name, email, 'admin', Date.now(), userId);
}

function insertUser(db, email, name) {
  const userId = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, image, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, name, email, 1, null, 'admin', now, now);

  return userId;
}

async function main() {
  const bootstrapAdmin = await getBootstrapAdminConfig();

  if (!bootstrapAdmin) {
    console.log('[bootstrap-admin] Skipped (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set).');
    return;
  }

  const { db, sqlitePath } = openDatabase();
  console.log(`[bootstrap-admin] Using SQLite database: ${sqlitePath}`);

  try {
    const { email, password, name } = bootstrapAdmin;
    const passwordHash = await hashPassword(password);
    db.exec('BEGIN IMMEDIATE');

    const existingUser = findUserByEmail(db, email);
    if (existingUser) {
      updateExistingUser(db, existingUser.id, email, name);
      ensureCredentialPassword(db, existingUser.id, passwordHash);
      ensureOrganizationBootstrap(db, existingUser.id);
      db.exec('COMMIT');

      const verifiedUser = findUserByEmail(db, email);
      if (!verifiedUser) {
        throw new Error(`Bootstrap admin missing after sync: ${email}`);
      }

      console.log(`[bootstrap-admin] Synced bootstrap admin user: ${email}`);
      return;
    }

    const targetUser = findBootstrapTargetUser(db);
    if (targetUser) {
      updateExistingUser(db, targetUser.id, email, name);
      ensureCredentialPassword(db, targetUser.id, passwordHash);
      ensureOrganizationBootstrap(db, targetUser.id);
      db.exec('COMMIT');

      const verifiedUser = findUserByEmail(db, email);
      if (!verifiedUser) {
        throw new Error(`Bootstrap admin missing after override: ${email}`);
      }

      console.log(`[bootstrap-admin] Updated existing admin credentials: ${targetUser.email} -> ${email}`);
      return;
    }

    const userId = insertUser(db, email, name);
    ensureCredentialPassword(db, userId, passwordHash);
    ensureOrganizationBootstrap(db, userId);
    db.exec('COMMIT');

    const verifiedUser = findUserByEmail(db, email);
    if (!verifiedUser) {
      throw new Error(`Bootstrap admin missing after creation: ${email}`);
    }

    console.log(`[bootstrap-admin] Created admin user: ${email}`);
  } catch (error) {
    if (db.inTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('[bootstrap-admin] Failed:', error);
  process.exit(1);
});
