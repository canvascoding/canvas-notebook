import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyPassword } from 'better-auth/crypto';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-auth-setup-'));
process.env.DATA = dataDir;

function envValue(content: string, key: string): string | null {
  const line = content.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).replace(/^"|"$/g, '') : null;
}

function assertOrganizationBootstrapState(
  sqlite: Database.Database,
  expectedUserId: string,
  expectedEmail: string,
  expectedPermissionOverrides: Partial<{ canManageBackups: number }> = {},
  rootDir = dataDir,
  expectedDeploymentMode = 'single_user',
) {
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId, owner_user_id AS ownerUserId, deployment_mode AS deploymentMode,
      team_features_enabled AS teamFeaturesEnabled
    FROM canvas_organization_settings
  `).get() as {
    organizationId: string;
    ownerUserId: string;
    deploymentMode: string;
    teamFeaturesEnabled: number;
  };

  assert.ok(organization.organizationId.startsWith('org_'));
  assert.equal(organization.ownerUserId, expectedUserId);
  assert.equal(organization.deploymentMode, expectedDeploymentMode);
  assert.equal(organization.teamFeaturesEnabled, 0);

  const permission = sqlite.prepare(`
    SELECT role, can_manage_backups AS canManageBackups, can_migrate_database AS canMigrateDatabase,
      can_enable_knowledge AS canEnableKnowledge, can_recover_workspaces AS canRecoverWorkspaces,
      can_create_team_automations AS canCreateTeamAutomations
    FROM organization_user_permissions
    WHERE organization_id = ? AND user_id = ?
  `).get(organization.organizationId, expectedUserId) as {
    role: string;
    canManageBackups: number;
    canMigrateDatabase: number;
    canEnableKnowledge: number;
    canRecoverWorkspaces: number;
    canCreateTeamAutomations: number;
  };

  const expectedCanManageBackups = expectedPermissionOverrides.canManageBackups ?? 1;
  assert.equal(permission.role, 'owner');
  assert.equal(permission.canManageBackups, expectedCanManageBackups);
  assert.equal(permission.canMigrateDatabase, 1);
  assert.equal(permission.canEnableKnowledge, 1);
  assert.equal(permission.canRecoverWorkspaces, 1);
  assert.equal(permission.canCreateTeamAutomations, 1);

  const owner = sqlite.prepare('SELECT email FROM user WHERE id = ?').get(expectedUserId) as { email: string };
  assert.equal(owner.email, expectedEmail);

  const workspaces = sqlite.prepare(`
    SELECT type, owner_user_id AS ownerUserId, root_relative_path AS rootRelativePath, display_name AS displayName, status
    FROM canvas_workspaces
    ORDER BY type ASC
  `).all() as Array<{
    type: string;
    ownerUserId: string | null;
    rootRelativePath: string;
    displayName: string;
    status: string;
  }>;
  assert.deepEqual(workspaces.map((workspace) => workspace.type), ['personal']);
  assert.equal(workspaces[0].ownerUserId, expectedUserId);
  assert.equal(workspaces[0].rootRelativePath, path.posix.join('workspaces', 'personal', expectedUserId, 'files'));
  assert.equal(workspaces[0].displayName, 'Personal Workspace');
  assert.equal(workspaces[0].status, 'active');

  assert.equal(existsSync(path.join(rootDir, 'workspaces', 'personal', expectedUserId, 'files')), true);
  assert.equal(existsSync(path.join(rootDir, 'users', expectedUserId, 'settings')), true);
  assert.equal(existsSync(path.join(rootDir, 'users', expectedUserId, 'secrets')), true);
  assert.equal(existsSync(path.join(rootDir, 'organizations', organization.organizationId, 'policies')), true);
  assert.equal(existsSync(path.join(rootDir, 'system', 'backups')), true);
  assert.equal(existsSync(path.join(rootDir, 'workspaces', 'team', organization.organizationId, 'files')), false);
}

async function main() {
  const {
    createInitialOwner,
    hasAnyAuthUser,
    InitialOwnerSetupError,
  } = await import('../app/lib/auth-setup');
  const {
    areTeamFeaturesEnabled,
    ensureOrganizationBootstrapForUser,
    getOrganizationBootstrapStatus,
  } = await import('../app/lib/organization/bootstrap');

  const previousTeamFeaturesEnv = process.env.CANVAS_TEAM_FEATURES_ENABLED;
  process.env.CANVAS_TEAM_FEATURES_ENABLED = 'true';
  assert.equal(areTeamFeaturesEnabled('community'), false);
  assert.equal(areTeamFeaturesEnabled('single_user'), false);
  assert.equal(areTeamFeaturesEnabled('managed-single'), false);
  assert.equal(areTeamFeaturesEnabled('production'), true);
  if (previousTeamFeaturesEnv === undefined) {
    delete process.env.CANVAS_TEAM_FEATURES_ENABLED;
  } else {
    process.env.CANVAS_TEAM_FEATURES_ENABLED = previousTeamFeaturesEnv;
  }

  assert.equal(hasAnyAuthUser(), false);

  mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
  writeFileSync(
    path.join(dataDir, 'secrets', 'Canvas-Integrations.env'),
    'OPENAI_API_KEY=legacy-openai\nGEMINI_API_KEY=legacy-gemini\n',
    'utf8',
  );
  writeFileSync(
    path.join(dataDir, 'secrets', 'Canvas-Agents.env'),
    'ANTHROPIC_API_KEY=legacy-anthropic\n',
    'utf8',
  );

  const owner = await createInitialOwner({
    name: ' Setup Admin ',
    email: 'SETUP@example.test ',
    password: 'SetupPassword123!',
  });

  assert.equal(owner.name, 'Setup Admin');
  assert.equal(owner.email, 'setup@example.test');
  assert.equal(hasAnyAuthUser(), true);

  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  const users = sqlite.prepare('SELECT id, name, email, role, email_verified AS emailVerified FROM user').all() as Array<{
    id: string;
    name: string;
    email: string;
    role: string | null;
    emailVerified: number;
  }>;
  assert.equal(users.length, 1);
  assert.equal(users[0].id, owner.id);
  assert.equal(users[0].name, 'Setup Admin');
  assert.equal(users[0].email, 'setup@example.test');
  assert.equal(users[0].role, 'admin');
  assert.equal(users[0].emailVerified, 1);

  const accounts = sqlite.prepare(`
    SELECT account_id AS accountId, provider_id AS providerId, user_id AS userId, password
    FROM account
  `).all() as Array<{
    accountId: string;
    providerId: string;
    userId: string;
    password: string | null;
  }>;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, owner.id);
  assert.equal(accounts[0].providerId, 'credential');
  assert.equal(accounts[0].userId, owner.id);
  assert.ok(accounts[0].password);
  assert.equal(await verifyPassword({ hash: accounts[0].password!, password: 'SetupPassword123!' }), true);
  assertOrganizationBootstrapState(sqlite, owner.id, 'setup@example.test');

  const userSecretsDir = path.join(dataDir, 'users', owner.id, 'secrets');
  const migratedIntegrations = readFileSync(path.join(userSecretsDir, 'Canvas-Integrations.env'), 'utf8');
  const migratedAgents = readFileSync(path.join(userSecretsDir, 'Canvas-Agents.env'), 'utf8');
  assert.equal(envValue(migratedIntegrations, 'OPENAI_API_KEY'), 'legacy-openai');
  assert.equal(envValue(migratedIntegrations, 'GEMINI_API_KEY'), 'legacy-gemini');
  assert.equal(envValue(migratedAgents, 'ANTHROPIC_API_KEY'), 'legacy-anthropic');
  assert.equal(existsSync(path.join(dataDir, 'system', 'migration', 'legacy-secret-imports', `${owner.id}.json`)), true);

  writeFileSync(
    path.join(userSecretsDir, 'Canvas-Integrations.env'),
    'OPENAI_API_KEY=user-openai\n',
    'utf8',
  );
  ensureOrganizationBootstrapForUser(sqlite, owner.id);
  const preservedIntegrations = readFileSync(path.join(userSecretsDir, 'Canvas-Integrations.env'), 'utf8');
  assert.equal(envValue(preservedIntegrations, 'OPENAI_API_KEY'), 'user-openai');

  sqlite.prepare(`
    UPDATE organization_user_permissions
    SET can_manage_backups = 0
    WHERE user_id = ?
  `).run(owner.id);
  const readOnlyStatus = getOrganizationBootstrapStatus(sqlite);
  assert.equal(readOnlyStatus.permission?.canManageBackups, false);
  const customizedPermission = sqlite.prepare(`
    SELECT can_manage_backups AS canManageBackups
    FROM organization_user_permissions
    WHERE user_id = ?
  `).get(owner.id) as { canManageBackups: number };
  assert.equal(customizedPermission.canManageBackups, 0);
  const rebootstrapStatus = ensureOrganizationBootstrapForUser(sqlite, owner.id);
  assert.equal(rebootstrapStatus.permission?.canManageBackups, false);
  const preservedPermission = sqlite.prepare(`
    SELECT can_manage_backups AS canManageBackups
    FROM organization_user_permissions
    WHERE user_id = ?
  `).get(owner.id) as { canManageBackups: number };
  assert.equal(preservedPermission.canManageBackups, 0);

  sqlite.close();

  await assert.rejects(
    () => createInitialOwner({
      name: 'Second Admin',
      email: 'second@example.test',
      password: 'SecondPassword123!',
    }),
    (error) => error instanceof InitialOwnerSetupError && error.code === 'ALREADY_CONFIGURED',
  );

  execFileSync('node', ['scripts/bootstrap-admin.js'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: {
      ...process.env,
      DATA: dataDir,
      BOOTSTRAP_ADMIN_EMAIL: 'override@example.test',
      BOOTSTRAP_ADMIN_PASSWORD: 'OverridePassword123!',
      BOOTSTRAP_ADMIN_NAME: 'Override Admin',
    },
  });

  const migrated = new Database(path.join(dataDir, 'sqlite.db'));
  const migratedUsers = migrated.prepare('SELECT id, name, email, role FROM user').all() as Array<{
    id: string;
    name: string;
    email: string;
    role: string | null;
  }>;
  assert.equal(migratedUsers.length, 1);
  assert.equal(migratedUsers[0].id, owner.id);
  assert.equal(migratedUsers[0].name, 'Override Admin');
  assert.equal(migratedUsers[0].email, 'override@example.test');
  assert.equal(migratedUsers[0].role, 'admin');

  const migratedAccount = migrated.prepare(`
    SELECT account_id AS accountId, user_id AS userId, password
    FROM account
    WHERE provider_id = 'credential'
  `).get() as { accountId: string; userId: string; password: string | null };
  assert.equal(migratedAccount.accountId, owner.id);
  assert.equal(migratedAccount.userId, owner.id);
  assert.ok(migratedAccount.password);
  assert.equal(await verifyPassword({ hash: migratedAccount.password!, password: 'OverridePassword123!' }), true);
  assertOrganizationBootstrapState(migrated, owner.id, 'override@example.test', { canManageBackups: 0 });
  migrated.close();

  execFileSync('node', ['scripts/bootstrap-admin.js', '--email', 'cli-reset@example.test', '--name', 'CLI Reset Admin', '--password-stdin'], {
    cwd: process.cwd(),
    input: 'CliResetPassword123!\n',
    stdio: 'pipe',
    env: {
      ...process.env,
      DATA: dataDir,
      BOOTSTRAP_ADMIN_EMAIL: '',
      BOOTSTRAP_ADMIN_PASSWORD: '',
      BOOTSTRAP_ADMIN_NAME: '',
    },
  });

  const cliReset = new Database(path.join(dataDir, 'sqlite.db'));
  const cliResetUsers = cliReset.prepare('SELECT id, name, email, role FROM user').all() as Array<{
    id: string;
    name: string;
    email: string;
    role: string | null;
  }>;
  assert.equal(cliResetUsers.length, 1);
  assert.equal(cliResetUsers[0].id, owner.id);
  assert.equal(cliResetUsers[0].name, 'CLI Reset Admin');
  assert.equal(cliResetUsers[0].email, 'cli-reset@example.test');
  assert.equal(cliResetUsers[0].role, 'admin');

  const cliResetAccount = cliReset.prepare(`
    SELECT account_id AS accountId, user_id AS userId, password
    FROM account
    WHERE provider_id = 'credential'
  `).get() as { accountId: string; userId: string; password: string | null };
  assert.equal(cliResetAccount.accountId, owner.id);
  assert.equal(cliResetAccount.userId, owner.id);
  assert.ok(cliResetAccount.password);
  assert.equal(await verifyPassword({ hash: cliResetAccount.password!, password: 'CliResetPassword123!' }), true);
  assertOrganizationBootstrapState(cliReset, owner.id, 'cli-reset@example.test', { canManageBackups: 0 });
  cliReset.close();

  const communityBootstrapDir = mkdtempSync(path.join(tmpdir(), 'canvas-auth-community-bootstrap-'));
  try {
    execFileSync('node', ['scripts/bootstrap-admin.js'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        DATA: communityBootstrapDir,
        CANVAS_DEPLOYMENT_MODE: 'community',
        CANVAS_TEAM_FEATURES_ENABLED: 'true',
        CANVAS_DATABASE_PROVIDER: 'sqlite',
        BOOTSTRAP_ADMIN_EMAIL: 'community@example.test',
        BOOTSTRAP_ADMIN_PASSWORD: 'CommunityPassword123!',
        BOOTSTRAP_ADMIN_NAME: 'Community Admin',
      },
    });

    const communityBootstrap = new Database(path.join(communityBootstrapDir, 'sqlite.db'));
    const communityUser = communityBootstrap.prepare('SELECT id, email, role FROM user').get() as {
      id: string;
      email: string;
      role: string | null;
    };
    assert.equal(communityUser.email, 'community@example.test');
    assert.equal(communityUser.role, 'admin');
    assertOrganizationBootstrapState(
      communityBootstrap,
      communityUser.id,
      'community@example.test',
      {},
      communityBootstrapDir,
      'community',
    );

    communityBootstrap.prepare(`
      UPDATE canvas_workspaces
      SET status = 'disabled', display_name = 'Outdated Name'
      WHERE owner_user_id = ?
    `).run(communityUser.id);
    communityBootstrap.close();

    execFileSync('node', ['scripts/bootstrap-admin.js'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        DATA: communityBootstrapDir,
        CANVAS_DEPLOYMENT_MODE: 'community',
        CANVAS_TEAM_FEATURES_ENABLED: 'true',
        CANVAS_DATABASE_PROVIDER: 'sqlite',
        BOOTSTRAP_ADMIN_EMAIL: 'community@example.test',
        BOOTSTRAP_ADMIN_PASSWORD: 'CommunityPassword123!',
        BOOTSTRAP_ADMIN_NAME: 'Community Admin',
      },
    });

    const rebootstrap = new Database(path.join(communityBootstrapDir, 'sqlite.db'));
    const personalWorkspace = rebootstrap.prepare(`
      SELECT status, display_name AS displayName
      FROM canvas_workspaces
      WHERE owner_user_id = ?
    `).get(communityUser.id) as { status: string; displayName: string };
    assert.equal(personalWorkspace.status, 'disabled');
    assert.equal(personalWorkspace.displayName, 'Personal Workspace');
    rebootstrap.close();
  } finally {
    rmSync(communityBootstrapDir, { recursive: true, force: true });
  }

  const genericTeamBootstrapDir = mkdtempSync(path.join(tmpdir(), 'canvas-auth-generic-team-bootstrap-'));
  try {
    execFileSync('node', ['scripts/bootstrap-admin.js'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        DATA: genericTeamBootstrapDir,
        CANVAS_DEPLOYMENT_MODE: 'production',
        CANVAS_TEAM_FEATURES_ENABLED: 'true',
        CANVAS_DATABASE_PROVIDER: 'postgres',
        BOOTSTRAP_ADMIN_EMAIL: 'generic-team@example.test',
        BOOTSTRAP_ADMIN_PASSWORD: 'GenericTeamPassword123!',
        BOOTSTRAP_ADMIN_NAME: 'Generic Team Admin',
      },
    });

    const genericTeamBootstrap = new Database(path.join(genericTeamBootstrapDir, 'sqlite.db'));
    const organization = genericTeamBootstrap.prepare(`
      SELECT organization_id AS organizationId, deployment_mode AS deploymentMode,
        team_features_enabled AS teamFeaturesEnabled
      FROM canvas_organization_settings
    `).get() as {
      organizationId: string;
      deploymentMode: string;
      teamFeaturesEnabled: number;
    };
    assert.equal(organization.deploymentMode, 'production');
    assert.equal(organization.teamFeaturesEnabled, 1);
    assert.equal(existsSync(path.join(genericTeamBootstrapDir, 'workspaces', 'team', organization.organizationId, 'files')), true);
    const workspaceTypes = genericTeamBootstrap.prepare(`
      SELECT type FROM canvas_workspaces ORDER BY type ASC
    `).all() as Array<{ type: string }>;
    assert.deepEqual(workspaceTypes.map((workspace) => workspace.type), ['personal', 'team']);
    genericTeamBootstrap.close();
  } finally {
    rmSync(genericTeamBootstrapDir, { recursive: true, force: true });
  }

  console.log('auth setup tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
