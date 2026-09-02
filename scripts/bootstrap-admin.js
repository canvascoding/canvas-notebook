const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} = require('node:fs');
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
  node scripts/bootstrap-admin.js --ensure
  node scripts/bootstrap-admin.js --email <email> [--name <name>] --password-stdin

Without CLI options, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are read from the environment.
--ensure creates the first admin when needed without overwriting an existing user's login details.`);
}

async function getBootstrapAdminConfigFromArgs(args) {
  let email = null;
  let name = 'Administrator';
  let passwordStdin = false;
  let hasCliOptions = false;
  let ensureOnly = false;

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

    if (arg === '--ensure') {
      hasCliOptions = true;
      ensureOnly = true;
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

  if (ensureOnly) {
    if (args.length !== 1) {
      throw new Error('--ensure cannot be combined with other CLI bootstrap options.');
    }
    return { ensureOnly: true };
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
  if (cliConfig?.ensureOnly) {
    const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator').trim() || 'Administrator';
    if (!email || !password) return null;
    return { email, password, name, ensureOnly: true };
  }
  if (cliConfig) {
    return cliConfig;
  }

  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator').trim() || 'Administrator';

  if (!email || !password) {
    return null;
  }

  return { email, password, name, ensureOnly: false };
}

function getSqlitePath() {
  const dataDir = process.env.DATA || path.resolve(process.cwd(), 'data');
  return path.join(dataDir, 'sqlite.db');
}

function getDatabaseProvider() {
  const configured = (process.env.CANVAS_DATABASE_PROVIDER || '').trim().toLowerCase();
  if (configured) return configured;
  if (/^postgres(?:ql)?:\/\//i.test((process.env.DATABASE_URL || '').trim())) return 'postgres';
  if (process.env.NODE_ENV === 'production' && !existsSync(getSqlitePath())) return 'postgres';
  return 'sqlite';
}

function runPostgresBootstrapAdmin(bootstrapAdmin) {
  const tsxCli = path.join(path.dirname(require.resolve('tsx')), 'cli.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCli, '--conditions', 'react-server', 'scripts/bootstrap-admin-postgres.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOOTSTRAP_ADMIN_EMAIL: bootstrapAdmin.email,
        BOOTSTRAP_ADMIN_PASSWORD: bootstrapAdmin.password,
        BOOTSTRAP_ADMIN_NAME: bootstrapAdmin.name,
        BOOTSTRAP_ADMIN_ENSURE_ONLY: bootstrapAdmin.ensureOnly ? 'true' : '',
      },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
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
  issuer TEXT NOT NULL DEFAULT 'local:credential',
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_unique ON user (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_issuer_account_id ON account (issuer, account_id);
CREATE INDEX IF NOT EXISTS idx_account_user_provider ON account (user_id, provider_id);

CREATE TABLE IF NOT EXISTS canvas_organization_settings (
  organization_id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  deployment_mode TEXT NOT NULL DEFAULT 'single_user',
  team_features_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES user(id)
);

CREATE TABLE IF NOT EXISTS canvas_workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  type TEXT NOT NULL,
  owner_user_id TEXT,
  root_relative_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES user(id)
);

CREATE TABLE IF NOT EXISTS canvas_workspace_members (
  organization_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  can_read INTEGER NOT NULL DEFAULT 1,
  can_write INTEGER NOT NULL DEFAULT 0,
  can_manage INTEGER NOT NULL DEFAULT 0,
  invited_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
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

CREATE TABLE IF NOT EXISTS team_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  candidate_email TEXT NOT NULL,
  display_name TEXT,
  user_id TEXT,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member', 'external')),
  status TEXT NOT NULL
    CHECK (status IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')),
  external_invitation_id TEXT,
  control_plane_operation_id TEXT,
  invited_by_user_id TEXT,
  invited_at INTEGER,
  accepted_at INTEGER,
  activated_at INTEGER,
  suspended_at INTEGER,
  removed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (status != 'active' OR (user_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (status NOT IN ('invited', 'approval_required', 'billing_pending') OR user_id IS NULL),
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE RESTRICT,
  FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS team_membership_transitions (
  id TEXT PRIMARY KEY NOT NULL,
  membership_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  from_status TEXT
    CHECK (from_status IS NULL OR from_status IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('invited', 'approval_required', 'billing_pending', 'active', 'suspended', 'removed')),
  actor_user_id TEXT,
  source TEXT NOT NULL,
  reason TEXT,
  external_operation_id TEXT,
  membership_revision INTEGER,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (membership_id) REFERENCES team_memberships(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS team_membership_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  email_snapshot TEXT NOT NULL,
  role_snapshot TEXT NOT NULL
    CHECK (role_snapshot IN ('admin', 'member', 'external')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_user_id TEXT,
  expires_at INTEGER NOT NULL,
  accepted_request_id TEXT,
  accepted_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (status != 'accepted' OR (accepted_request_id IS NOT NULL AND accepted_at IS NOT NULL)),
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id) REFERENCES team_memberships(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_user_id) REFERENCES user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS team_membership_sync_state (
  organization_id TEXT PRIMARY KEY NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 0,
  current_observed_quantity INTEGER NOT NULL DEFAULT 0,
  latest_snapshot_hash TEXT,
  latest_snapshot_generated_at INTEGER,
  last_local_change_at INTEGER,
  acknowledged_revision INTEGER NOT NULL DEFAULT 0,
  acknowledged_snapshot_id TEXT,
  acknowledged_snapshot_hash TEXT,
  acknowledged_at INTEGER,
  control_plane_protocol_version TEXT,
  control_plane_observed_quantity INTEGER,
  approved_quantity INTEGER,
  billed_quantity INTEGER,
  licensed_quantity INTEGER,
  expected_licensed_quantity INTEGER,
  entitlements_version INTEGER,
  billing_status TEXT,
  drift_status TEXT,
  reconciliation_status TEXT,
  reconciliation_action TEXT,
  reconciliation_reason TEXT,
  reconciliation_seat_limit INTEGER
    CHECK (reconciliation_seat_limit IS NULL OR reconciliation_seat_limit >= 1),
  reconciliation_support_required INTEGER NOT NULL DEFAULT 0,
  reconciled_at INTEGER,
  next_report_at INTEGER,
  last_sync_error_code TEXT,
  last_sync_error TEXT,
  last_sync_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    current_revision >= 0
    AND acknowledged_revision >= 0
    AND acknowledged_revision <= current_revision
  ),
  CHECK (current_observed_quantity >= 0),
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS team_seat_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  dedupe_key TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  membership_id TEXT,
  membership_revision INTEGER,
  operation_kind TEXT NOT NULL
    CHECK (operation_kind IN ('membership_snapshot', 'seat_prepare', 'seat_execute', 'license_refresh')),
  operation_type TEXT
    CHECK (operation_type IS NULL OR operation_type IN ('team_upgrade', 'member_create', 'invitation_accept', 'member_remove', 'reconcile')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'canceled')),
  request_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT,
  control_plane_operation_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  last_error_code TEXT,
  last_error TEXT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts),
  FOREIGN KEY (organization_id) REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id) REFERENCES team_memberships(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_org_user_permissions_user ON organization_user_permissions (user_id);
CREATE INDEX IF NOT EXISTS idx_org_user_permissions_role ON organization_user_permissions (organization_id, role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_user_permissions_single_owner ON organization_user_permissions (organization_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS idx_team_memberships_org_status ON team_memberships (organization_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_memberships_org_email ON team_memberships (organization_id, candidate_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_memberships_org_user ON team_memberships (organization_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_memberships_external_invitation ON team_memberships (organization_id, external_invitation_id) WHERE external_invitation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_memberships_control_plane_operation ON team_memberships (organization_id, control_plane_operation_id);
CREATE INDEX IF NOT EXISTS idx_team_membership_invitations_org_status ON team_membership_invitations (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_team_membership_invitations_expiry ON team_membership_invitations (status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_membership_invitations_accept_request ON team_membership_invitations (accepted_request_id) WHERE accepted_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_membership_transitions_membership_created ON team_membership_transitions (membership_id, created_at);
CREATE INDEX IF NOT EXISTS idx_team_membership_transitions_org_created ON team_membership_transitions (organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_team_membership_transitions_org_revision ON team_membership_transitions (organization_id, membership_revision);
CREATE INDEX IF NOT EXISTS idx_team_membership_transitions_external_operation ON team_membership_transitions (organization_id, external_operation_id);
CREATE INDEX IF NOT EXISTS idx_team_membership_sync_next_report ON team_membership_sync_state (next_report_at);
CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_status_retry ON team_seat_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_org_created ON team_seat_outbox (organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_org_revision ON team_seat_outbox (organization_id, membership_revision);
CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_membership ON team_seat_outbox (membership_id, created_at);
CREATE INDEX IF NOT EXISTS idx_team_seat_outbox_control_plane_operation ON team_seat_outbox (control_plane_operation_id);
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

  const workspaceColumns = new Set(db.prepare('PRAGMA table_info(canvas_workspaces)').all().map((row) => row.name));
  if (!workspaceColumns.has('description')) {
    db.exec("ALTER TABLE canvas_workspaces ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!workspaceColumns.has('is_default')) {
    db.exec('ALTER TABLE canvas_workspaces ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    UPDATE canvas_workspaces
    SET type = 'organization', is_default = 0
    WHERE type = 'team'
      AND (
        LENGTH(root_relative_path) - LENGTH(REPLACE(root_relative_path, '/', '')) = 3
        OR root_relative_path IS NULL
        OR root_relative_path = ''
      );

    UPDATE canvas_workspaces
    SET is_default = 1
    WHERE type = 'personal'
      AND owner_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM canvas_workspaces older
        WHERE older.type = 'personal'
          AND older.owner_user_id = canvas_workspaces.owner_user_id
          AND (
            older.created_at < canvas_workspaces.created_at
            OR (older.created_at = canvas_workspaces.created_at AND older.id < canvas_workspaces.id)
          )
      );

    UPDATE canvas_workspaces
    SET is_default = 0
    WHERE type = 'organization';

    CREATE INDEX IF NOT EXISTS idx_canvas_org_settings_owner ON canvas_organization_settings (owner_user_id);
    DROP INDEX IF EXISTS idx_canvas_workspaces_personal_owner;
    DROP INDEX IF EXISTS idx_canvas_workspaces_team_organization;
    DROP INDEX IF EXISTS idx_canvas_workspaces_default_organization;
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_organization ON canvas_workspaces (organization_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_owner ON canvas_workspaces (owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_organization_type ON canvas_workspaces (organization_id, type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_workspaces_default_personal ON canvas_workspaces (owner_user_id) WHERE type = 'personal' AND is_default = 1;
    CREATE INDEX IF NOT EXISTS idx_canvas_workspace_members_org_user ON canvas_workspace_members (organization_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_canvas_workspace_members_workspace_status ON canvas_workspace_members (workspace_id, status);
  `);
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

function normalizeDeploymentMode(value) {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function isTruthyEnv(value) {
  return value === 'true' || value === '1' || value === 'yes';
}

function isSingleUserDeploymentMode(deploymentMode) {
  const normalized = normalizeDeploymentMode(deploymentMode);
  return normalized === 'community' ||
    normalized === 'single-user' ||
    normalized === 'singleuser' ||
    normalized === 'managed-single' ||
    normalized === 'local' ||
    normalized === 'development' ||
    normalized === 'dev';
}

function isTeamDeploymentMode(deploymentMode) {
  const normalized = normalizeDeploymentMode(deploymentMode);
  if (isSingleUserDeploymentMode(normalized)) return false;
  return normalized.includes('team') ||
    normalized.includes('enterprise') ||
    normalized.includes('advanced');
}

function canEnableTeamFeaturesForDeployment(deploymentMode) {
  return !isSingleUserDeploymentMode(deploymentMode);
}

function teamFeaturesEnabled(deploymentMode) {
  if (!canEnableTeamFeaturesForDeployment(deploymentMode)) return false;
  return isTruthyEnv(process.env.CANVAS_TEAM_FEATURES_ENABLED) || isTeamDeploymentMode(deploymentMode);
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

function ensureOwnerTeamMembership(db, organizationId, ownerUser, now) {
  const candidateEmail = normalizeEmail(ownerUser.email);
  if (!candidateEmail) {
    throw new Error('Cannot bootstrap owner membership without a valid email address.');
  }

  const byUser = db.prepare(`
    SELECT id, status
    FROM team_memberships
    WHERE organization_id = ? AND user_id = ?
    LIMIT 1
  `).get(organizationId, ownerUser.id);
  const byEmail = db.prepare(`
    SELECT id, status
    FROM team_memberships
    WHERE organization_id = ? AND candidate_email = ?
    LIMIT 1
  `).get(organizationId, candidateEmail);

  if (byUser && byEmail && byUser.id !== byEmail.id) {
    throw new Error('Cannot bootstrap owner membership because its user and email belong to different membership records.');
  }

  const existing = byUser || byEmail;
  const membershipId = existing?.id || `team-membership-${randomUUID()}`;
  if (existing) {
    db.prepare(`
      UPDATE team_memberships
      SET
        candidate_email = ?,
        user_id = ?,
        role = 'owner',
        status = 'active',
        accepted_at = COALESCE(accepted_at, ?),
        activated_at = COALESCE(activated_at, ?),
        suspended_at = NULL,
        removed_at = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(candidateEmail, ownerUser.id, now, now, now, membershipId);
  } else {
    db.prepare(`
      INSERT INTO team_memberships (
        id,
        organization_id,
        candidate_email,
        user_id,
        role,
        status,
        invited_by_user_id,
        invited_at,
        accepted_at,
        activated_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      membershipId,
      organizationId,
      candidateEmail,
      ownerUser.id,
      ownerUser.id,
      now,
      now,
      now,
      now,
      now,
    );
  }

  if (!existing || existing.status !== 'active') {
    db.prepare(`
      INSERT INTO team_membership_transitions (
        id,
        membership_id,
        organization_id,
        from_status,
        to_status,
        actor_user_id,
        source,
        reason,
        created_at
      ) VALUES (?, ?, ?, ?, 'active', ?, 'first_owner', 'bootstrap_admin_first_owner', ?)
    `).run(
      `team-membership-transition-${randomUUID()}`,
      membershipId,
      organizationId,
      existing?.status || null,
      ownerUser.id,
      now,
    );
  }
}

function ensureScopedDirectories(organizationId, userId) {
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
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
  }
}

function workspaceAbsoluteRoot(rootRelativePath) {
  if (path.isAbsolute(rootRelativePath) || rootRelativePath.includes('\0')) {
    throw new Error('Invalid workspace root path.');
  }
  const segments = rootRelativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Invalid workspace root path.');
  }
  return path.join(getDataRoot(), ...segments);
}

function ensureWorkspaceDirectory(rootRelativePath) {
  mkdirSync(workspaceAbsoluteRoot(rootRelativePath), { recursive: true });
}

function normalizeDataScopeId(id, label) {
  const normalized = String(id || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/') || normalized.includes('\\') || normalized.includes('\0')) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function legacyWorkspaceMigrationMarkerPath(organizationId, userId) {
  const fileName = `${normalizeDataScopeId(organizationId, 'organizationId')}--${normalizeDataScopeId(userId, 'userId')}.json`;
  return path.join(getDataRoot(), 'system', 'migration', 'legacy-workspace-imports', fileName);
}

function directoryExists(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function meaningfulLegacyWorkspaceEntries(sourceRoot) {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== '.gitkeep' && entry.name !== '.keep')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function safeImportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeLegacyWorkspaceMigrationManifest(markerPath, manifest) {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  const tempPath = `${markerPath}.tmp-${Date.now()}-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tempPath, markerPath);
}

function readExistingLegacyWorkspaceMigrationMarker(markerPath) {
  try {
    const manifest = JSON.parse(readFileSync(markerPath, 'utf8'));
    return {
      copiedEntries: Array.isArray(manifest.copiedEntries) ? manifest.copiedEntries : [],
      conflictedEntries: Array.isArray(manifest.conflictedEntries) ? manifest.conflictedEntries : [],
      conflictRootRelativePath: typeof manifest.conflictRootRelativePath === 'string' ? manifest.conflictRootRelativePath : null,
    };
  } catch {
    return { copiedEntries: [], conflictedEntries: [], conflictRootRelativePath: null };
  }
}

function legacySecretMigrationMarkerPath(userId) {
  return path.join(getDataRoot(), 'system', 'migration', 'legacy-secret-imports', `${normalizeDataScopeId(userId, 'userId')}.json`);
}

function parseEnvEntries(content) {
  const entries = [];
  for (const rawLine of content.split(/\r?\n/g)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.push({ key, value });
  }
  return entries;
}

function formatEnvValue(value) {
  if (!value) return '';
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function serializeEnvEntries(entries) {
  if (entries.length === 0) return '';
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  return `${sorted.map((entry) => `${entry.key}=${formatEnvValue(entry.value)}`).join('\n')}\n`;
}

function readEnvEntries(filePath) {
  if (!fileExists(filePath)) return [];
  return parseEnvEntries(readFileSync(filePath, 'utf8'));
}

function fileExists(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function writeAtomicFile(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(tempPath, filePath);
}

function writeEnvEntries(filePath, entries) {
  writeAtomicFile(filePath, serializeEnvEntries(entries));
}

function migrateLegacySecretsToUserScope(userId) {
  const markerPath = legacySecretMigrationMarkerPath(userId);
  if (existsSync(markerPath)) {
    return { status: 'skipped', reason: 'already_migrated', migratedFiles: [] };
  }

  const legacyFiles = [
    {
      kind: 'integrations',
      sourcePath: path.join(getDataRoot(), 'secrets', 'Canvas-Integrations.env'),
      targetPath: path.join(getDataRoot(), 'users', userId, 'secrets', 'Canvas-Integrations.env'),
    },
    {
      kind: 'agents',
      sourcePath: path.join(getDataRoot(), 'secrets', 'Canvas-Agents.env'),
      targetPath: path.join(getDataRoot(), 'users', userId, 'secrets', 'Canvas-Agents.env'),
    },
  ];

  const migratedFiles = [];
  let sawLegacyFile = false;
  let sawLegacyEntries = false;

  for (const file of legacyFiles) {
    if (!fileExists(file.sourcePath)) continue;

    sawLegacyFile = true;
    const legacyEntries = readEnvEntries(file.sourcePath)
      .filter((entry) => file.kind !== 'integrations' || ![
        'CANVAS_SYSTEM_SMTP_HOST', 'CANVAS_SYSTEM_SMTP_PORT', 'CANVAS_SYSTEM_SMTP_SECURE',
        'CANVAS_SYSTEM_SMTP_USERNAME', 'CANVAS_SYSTEM_SMTP_PASSWORD', 'CANVAS_SYSTEM_EMAIL_FROM',
        'CANVAS_SYSTEM_EMAIL_FROM_NAME', 'CANVAS_SYSTEM_EMAIL_REPLY_TO', 'CANVAS_SYSTEM_EMAIL_DELIVERY_MODE',
      ].includes(entry.key));
    if (legacyEntries.length === 0) continue;

    sawLegacyEntries = true;
    const targetEntries = readEnvEntries(file.targetPath);
    const byKey = new Map(targetEntries.map((entry) => [entry.key, entry]));
    const copiedKeys = [];
    const preservedKeys = [];

    for (const legacyEntry of legacyEntries) {
      if (byKey.has(legacyEntry.key)) {
        preservedKeys.push(legacyEntry.key);
        continue;
      }
      byKey.set(legacyEntry.key, legacyEntry);
      copiedKeys.push(legacyEntry.key);
    }

    if (copiedKeys.length > 0) {
      writeEnvEntries(file.targetPath, Array.from(byKey.values()));
    } else {
      mkdirSync(path.dirname(file.targetPath), { recursive: true });
    }

    migratedFiles.push({
      kind: file.kind,
      sourcePath: file.sourcePath,
      targetPath: file.targetPath,
      copiedKeys,
      preservedKeys,
    });
  }

  if (!sawLegacyFile || !sawLegacyEntries) {
    return {
      status: 'skipped',
      reason: sawLegacyFile ? 'source_empty' : 'source_missing',
      migratedFiles: [],
    };
  }

  writeAtomicFile(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    operation: 'legacy-secrets-to-user-scope',
    userId,
    importedAt: new Date().toISOString(),
    migratedFiles,
  }, null, 2)}\n`);

  return { status: 'migrated', migratedFiles };
}

function migrateLegacyWorkspaceToPersonalWorkspace(organizationId, userId, personalWorkspace) {
  const sourceRoot = path.join(getDataRoot(), 'workspace');
  const targetRoot = workspaceAbsoluteRoot(personalWorkspace.root_relative_path);
  const markerPath = legacyWorkspaceMigrationMarkerPath(organizationId, userId);

  if (existsSync(markerPath)) {
    return {
      status: 'skipped',
      reason: 'already_migrated',
      ...readExistingLegacyWorkspaceMigrationMarker(markerPath),
    };
  }

  if (!directoryExists(sourceRoot)) {
    return { status: 'skipped', reason: 'source_missing', copiedEntries: [], conflictedEntries: [], conflictRootRelativePath: null };
  }

  const sourceReal = path.resolve(sourceRoot);
  const targetReal = path.resolve(targetRoot);
  if (sourceReal === targetReal || targetReal.startsWith(`${sourceReal}${path.sep}`)) {
    return { status: 'skipped', reason: 'invalid_target', copiedEntries: [], conflictedEntries: [], conflictRootRelativePath: null };
  }

  const entries = meaningfulLegacyWorkspaceEntries(sourceRoot);
  if (entries.length === 0) {
    return { status: 'skipped', reason: 'source_empty', copiedEntries: [], conflictedEntries: [], conflictRootRelativePath: null };
  }

  mkdirSync(targetRoot, { recursive: true });
  const copiedEntries = [];
  const conflictedEntries = [];
  const conflictRootRelativePath = `_legacy-workspace-import/${safeImportTimestamp()}`;
  let conflictRootCreated = false;

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry);
    const directTargetPath = path.join(targetRoot, entry);
    if (!existsSync(directTargetPath)) {
      cpSync(sourcePath, directTargetPath, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
      copiedEntries.push(entry);
      continue;
    }

    if (!conflictRootCreated) {
      mkdirSync(path.join(targetRoot, conflictRootRelativePath), { recursive: true });
      conflictRootCreated = true;
    }
    cpSync(sourcePath, path.join(targetRoot, conflictRootRelativePath, entry), { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    conflictedEntries.push(entry);
  }

  const manifest = {
    schemaVersion: 1,
    operation: 'legacy-workspace-to-personal-workspace',
    organizationId,
    userId,
    sourceRoot,
    targetRoot,
    targetRootRelativePath: personalWorkspace.root_relative_path,
    importedAt: new Date().toISOString(),
    copiedEntries,
    conflictedEntries,
    conflictRootRelativePath: conflictedEntries.length > 0 ? conflictRootRelativePath : null,
  };
  writeLegacyWorkspaceMigrationManifest(markerPath, manifest);
  return { status: 'migrated', copiedEntries, conflictedEntries, conflictRootRelativePath: manifest.conflictRootRelativePath };
}

function ensureWorkspaceRecord(db, input) {
  const now = Date.now();
  const existing = input.type === 'personal'
    ? db.prepare(`
        SELECT id, root_relative_path, display_name, status, is_default
        FROM canvas_workspaces
        WHERE type = 'personal' AND owner_user_id = ?
        ORDER BY is_default DESC, created_at ASC
        LIMIT 1
      `).get(input.ownerUserId)
    : db.prepare(`
        SELECT id, root_relative_path, display_name, status, is_default
        FROM canvas_workspaces
        WHERE type = 'organization' AND organization_id = ?
        ORDER BY is_default DESC, created_at ASC
        LIMIT 1
      `).get(input.organizationId);

  if (existing) {
    const nextRootRelativePath = input.preserveExistingRoot ? existing.root_relative_path : input.rootRelativePath;
    db.prepare(`
      UPDATE canvas_workspaces
      SET root_relative_path = ?, display_name = ?, is_default = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRootRelativePath, input.displayName, input.isDefault ? 1 : 0, now, existing.id);
    ensureWorkspaceDirectory(nextRootRelativePath);
    return {
      ...existing,
      root_relative_path: nextRootRelativePath,
      display_name: input.displayName,
      is_default: input.isDefault ? 1 : 0,
    };
  }

  const id = `ws_${randomUUID()}`;
  db.prepare(`
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path, display_name, status, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    id,
    input.organizationId,
    input.type,
    input.ownerUserId,
    input.rootRelativePath,
    input.displayName,
    input.isDefault ? 1 : 0,
    now,
    now,
  );
  ensureWorkspaceDirectory(input.rootRelativePath);
  return {
    id,
    root_relative_path: input.rootRelativePath,
    display_name: input.displayName,
    status: 'active',
    is_default: input.isDefault ? 1 : 0,
  };
}

function ensureDefaultWorkspaceRecords(db, organizationId, userId) {
  const personal = ensureWorkspaceRecord(db, {
    organizationId,
    type: 'personal',
    ownerUserId: userId,
    rootRelativePath: path.posix.join('workspaces', 'personal', userId, 'files'),
    displayName: 'Personal Workspace',
    isDefault: true,
  });

  return { personal };
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
  ensureOwnerTeamMembership(db, organization.organization_id, ownerUser, now);
  if (targetUser.id !== ownerUser.id) {
    db.prepare('UPDATE user SET role = ?, updated_at = ? WHERE id = ?').run('admin', now, targetUser.id);
    ensurePermissionRow(db, organization.organization_id, targetUser.id, 'admin');
  }
  ensureScopedDirectories(organization.organization_id, ownerUser.id);
  const ownerWorkspaceRecords = ensureDefaultWorkspaceRecords(db, organization.organization_id, ownerUser.id);
  migrateLegacyWorkspaceToPersonalWorkspace(organization.organization_id, ownerUser.id, ownerWorkspaceRecords.personal);
  migrateLegacySecretsToUserScope(ownerUser.id);
  if (targetUser.id !== ownerUser.id) {
    ensureScopedDirectories(organization.organization_id, targetUser.id);
    ensureDefaultWorkspaceRecords(db, organization.organization_id, targetUser.id);
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
      SET account_id = ?, issuer = COALESCE(issuer, ?), password = ?, updated_at = ?
      WHERE id = ?
    `).run(userId, 'local:credential', passwordHash, now, existingAccount.id);
    return;
  }

  db.prepare(`
    INSERT INTO account (
      id, account_id, provider_id, user_id, issuer, password, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, 'credential', userId, 'local:credential', passwordHash, now, now);
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

  if (getDatabaseProvider() === 'postgres') {
    runPostgresBootstrapAdmin(bootstrapAdmin);
    return;
  }

  const { db, sqlitePath } = openDatabase();
  console.log(`[bootstrap-admin] Using SQLite database: ${sqlitePath}`);

  try {
    const { email, password, name } = bootstrapAdmin;
    db.exec('BEGIN IMMEDIATE');

    if (bootstrapAdmin.ensureOnly) {
      const existingUser = findBootstrapTargetUser(db);
      if (existingUser) {
        ensureOrganizationBootstrap(db, existingUser.id);
        db.exec('COMMIT');
        console.log(`[bootstrap-admin] Existing user preserved: ${existingUser.email}`);
        return;
      }
    }

    const passwordHash = await hashPassword(password);

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
