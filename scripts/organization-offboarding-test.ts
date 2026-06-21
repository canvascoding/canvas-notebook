import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';
import { ensureDefaultWorkspaceRecords } from '../app/lib/workspaces/service';

type WorkspaceRow = {
  id: string;
  type: string;
  owner_user_id: string | null;
};

function getRequiredRow<T>(sqlite: Database.Database, sql: string, ...params: unknown[]): T {
  const row = sqlite.prepare(sql).get(...params) as T | undefined;
  assert.ok(row);
  return row;
}

function insertUser(sqlite: Database.Database, id: string, name: string, email: string, role: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, 1, role, now, now);
}

function insertPermission(sqlite: Database.Database, organizationId: string, userId: string, role: string, adminLike = false) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role,
      can_write_team_workspace, can_create_public_links, can_create_team_automations,
      can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
      can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    organizationId,
    userId,
    role,
    adminLike ? 1 : 0,
    1,
    adminLike ? 1 : 0,
    adminLike ? 1 : 0,
    adminLike ? 1 : 0,
    adminLike ? 1 : 0,
    1,
    adminLike ? 1 : 0,
    adminLike ? 1 : 0,
    adminLike ? 1 : 0,
    adminLike ? 1 : 0,
    now,
    now,
  );
}

function insertAutomation(
  sqlite: Database.Database,
  input: {
    id: string;
    name: string;
    scope: 'personal' | 'organization';
    organizationId: string;
    workspaceId: string;
    workspaceType: 'personal' | 'team';
    ownerUserId: string | null;
    responsibleUserId: string | null;
    createdByUserId: string;
    approvedByUserId?: string | null;
    lastEditedByUserId?: string | null;
  },
) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO automation_jobs (
      id, name, status, scope, organization_id, workspace_id, workspace_type,
      owner_user_id, responsible_user_id, service_actor_id, approved_by_user_id,
      last_edited_by_user_id, prompt, preferred_skill, workspace_context_paths_json,
      target_output_path, schedule_kind, schedule_config_json, time_zone, next_run_at,
      last_run_at, last_run_status, created_by_user_id, agent_id, delivery_mode,
      delivery_session_mode, created_at, updated_at, job_type
    ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'default')
  `).run(
    input.id,
    input.name,
    input.scope,
    input.organizationId,
    input.workspaceId,
    input.workspaceType,
    input.ownerUserId,
    input.responsibleUserId,
    input.scope === 'organization' ? `org-service:${input.organizationId}` : null,
    input.approvedByUserId ?? null,
    input.lastEditedByUserId ?? input.createdByUserId,
    'Test automation prompt.',
    'auto',
    '[]',
    null,
    'daily',
    JSON.stringify({ kind: 'daily', times: ['09:00'], timeZone: 'UTC' }),
    'UTC',
    now + 60_000,
    null,
    null,
    input.createdByUserId,
    'canvas-agent',
    'web',
    'new_session',
    now,
    now,
  );
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-offboarding-'));
  const dataRoot = path.join(tempRoot, 'data');
  const dbPath = path.join(dataRoot, 'sqlite.db');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';

  await fs.mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(dbPath);

  try {
    runMigrations(sqlite);
    insertUser(sqlite, 'user-owner', 'Owner', 'owner@example.test', 'admin');
    insertUser(sqlite, 'user-admin', 'Admin', 'admin@example.test', 'admin');
    insertUser(sqlite, 'user-member', 'Member', 'member@example.test', 'user');

    sqlite.exec('BEGIN IMMEDIATE');
    const ownerStatus = ensureOrganizationBootstrapForUser(sqlite, 'user-owner');
    sqlite.exec('COMMIT');
    assert.ok(ownerStatus.organizationId);
    const organizationId = ownerStatus.organizationId;

    insertPermission(sqlite, organizationId, 'user-admin', 'admin', true);
    insertPermission(sqlite, organizationId, 'user-member', 'member', false);
    ensureDefaultWorkspaceRecords(sqlite, { organizationId, userId: 'user-admin', teamFeaturesEnabled: true });
    ensureDefaultWorkspaceRecords(sqlite, { organizationId, userId: 'user-member', teamFeaturesEnabled: true });

    const workspaces = sqlite.prepare(`
      SELECT id, type, owner_user_id
      FROM canvas_workspaces
      ORDER BY created_at ASC
    `).all() as WorkspaceRow[];
    const memberWorkspace = workspaces.find((workspace) => workspace.type === 'personal' && workspace.owner_user_id === 'user-member');
    const teamWorkspace = workspaces.find((workspace) => workspace.type === 'team');
    assert.ok(memberWorkspace?.id);
    assert.ok(teamWorkspace?.id);

    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
      VALUES ('session-member', ?, 'token-member', ?, ?, 'user-member')
    `).run(now + 60_000, now, now);
    sqlite.prepare(`
      INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, password, created_at, updated_at)
      VALUES ('account-member', 'member-login', 'credential', 'user-member', 'access', 'refresh', 'id-token', 'password', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO email_accounts (
        id, user_id, provider, auth_type, email_address, status, policy_json, secret_ref, is_primary, created_at, updated_at
      ) VALUES ('email-member', 'user-member', 'google', 'oauth', 'member@example.test', 'active', '{}', 'secret-ref', 1, ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO todo_items (
        id, user_id, created_by_user_id, assignee_user_id, organization_id, workspace_id, workspace_type,
        title, status, priority, source_type, created_at, updated_at
      ) VALUES ('todo-member', 'user-owner', 'user-owner', 'user-member', ?, ?, 'team', 'Assigned todo', 'open', 'normal', 'user', ?, ?)
    `).run(organizationId, teamWorkspace.id, now, now);
    sqlite.prepare(`
      INSERT INTO channel_user_bindings (user_id, channel_id, channel_user_id, enabled, created_at)
      VALUES ('user-member', 'telegram', '12345', 1, ?)
    `).run(now);

    insertAutomation(sqlite, {
      id: 'job-personal-member',
      name: 'Personal member automation',
      scope: 'personal',
      organizationId,
      workspaceId: memberWorkspace.id,
      workspaceType: 'personal',
      ownerUserId: 'user-member',
      responsibleUserId: 'user-member',
      createdByUserId: 'user-member',
    });
    insertAutomation(sqlite, {
      id: 'job-team-member',
      name: 'Team member automation',
      scope: 'organization',
      organizationId,
      workspaceId: teamWorkspace.id,
      workspaceType: 'team',
      ownerUserId: null,
      responsibleUserId: 'user-member',
      createdByUserId: 'user-admin',
      approvedByUserId: 'user-admin',
      lastEditedByUserId: 'user-member',
    });
    sqlite.prepare(`
      INSERT INTO automation_webhook_triggers (id, job_id, secret_hash, secret_preview, status, created_at, updated_at)
      VALUES ('wh-member', 'job-team-member', 'hash', 'prev', 'active', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO automation_runs (
        id, job_id, status, scope, organization_id, workspace_id, workspace_type, actor_type,
        actor_user_id, trigger_type, attempt_number, created_at
      ) VALUES ('run-member', 'job-team-member', 'pending', 'organization', ?, ?, 'team', 'user', 'user-member', 'manual', 1, ?)
    `).run(organizationId, teamWorkspace.id, now);

    const userSettingsDir = path.join(dataRoot, 'users', 'user-member', 'settings');
    const userSecretsDir = path.join(dataRoot, 'users', 'user-member', 'secrets');
    await fs.mkdir(userSettingsDir, { recursive: true });
    await fs.mkdir(userSecretsDir, { recursive: true });

    const {
      createOffboardingPreflight,
      offboardUser,
      OffboardingError,
    } = await import('../app/lib/organization/offboarding');
    const {
      hasOrganizationPermission,
      readOrganizationPermissionForUser,
    } = await import('../app/lib/organization/permissions');

    const ownerPreflight = await createOffboardingPreflight('user-owner', 'user-admin');
    assert.equal(ownerPreflight.canApply, false);
    assert.ok(ownerPreflight.blockers.some((finding) => finding.category === 'permissions'));

    const memberPreflight = await createOffboardingPreflight('user-member', 'user-admin');
    assert.equal(memberPreflight.canApply, true);
    assert.equal(memberPreflight.counts.activeSessions, 1);
    assert.equal(memberPreflight.counts.activeEmailAccounts, 1);
    assert.equal(memberPreflight.counts.personalAutomations, 1);
    assert.equal(memberPreflight.counts.organizationResponsibleAutomations, 1);
    assert.equal(memberPreflight.counts.organizationReviewAutomations, 1);
    assert.equal(memberPreflight.counts.affectedAutomations, 2);
    assert.equal(memberPreflight.counts.openAssignedTodos, 1);
    assert.ok(memberPreflight.warnings.length >= 4);

    await assert.rejects(
      () => offboardUser({ targetUserId: 'user-member', requestedByUserId: 'user-admin' }),
      (error) => error instanceof OffboardingError && error.code === 'ACKNOWLEDGEMENT_REQUIRED',
    );

    const result = await offboardUser({
      targetUserId: 'user-member',
      requestedByUserId: 'user-admin',
      reason: 'Contract ended',
      acknowledgeWarnings: true,
    });
    assert.equal(result.actions.userBanned, 1);
    assert.equal(result.actions.sessionsRevoked, 1);
    assert.equal(result.actions.emailAccountsRevoked, 1);
    assert.equal(result.actions.automationsPaused, 2);
    assert.equal(result.actions.todosUnassigned, 1);
    assert.equal(result.actions.personalWorkspacesLocked, 1);
    assert.equal(await fs.stat(result.manifestPath).then((stat) => stat.isFile()), true);

    const member = getRequiredRow<{ banned: number; ban_reason: string }>(sqlite, `
      SELECT banned, ban_reason FROM user WHERE id = 'user-member'
    `);
    assert.equal(member.banned, 1);
    assert.match(member.ban_reason, /Contract ended/);
    const sessionCount = getRequiredRow<{ count: number }>(
      sqlite,
      'SELECT COUNT(*) AS count FROM session WHERE user_id = ?',
      'user-member',
    );
    assert.equal(sessionCount.count, 0);
    const account = getRequiredRow<Record<string, string | null>>(sqlite, `
      SELECT access_token, refresh_token, id_token, password FROM account WHERE id = 'account-member'
    `);
    assert.equal(account.access_token, null);
    assert.equal(account.refresh_token, null);
    assert.equal(account.id_token, null);
    assert.equal(account.password, null);
    assert.equal(getRequiredRow<{ status: string; is_primary: number }>(sqlite, 'SELECT status, is_primary FROM email_accounts WHERE id = ?', 'email-member').status, 'revoked');
    assert.equal(getRequiredRow<{ assignee_user_id: string | null }>(sqlite, 'SELECT assignee_user_id FROM todo_items WHERE id = ?', 'todo-member').assignee_user_id, null);
    assert.equal(getRequiredRow<{ status: string }>(sqlite, 'SELECT status FROM canvas_workspaces WHERE id = ?', memberWorkspace.id).status, 'recovery_locked');
    assert.equal(getRequiredRow<{ status: string }>(sqlite, 'SELECT status FROM automation_jobs WHERE id = ?', 'job-personal-member').status, 'paused');
    assert.equal(getRequiredRow<{ status: string }>(sqlite, 'SELECT status FROM automation_jobs WHERE id = ?', 'job-team-member').status, 'paused');
    assert.equal(getRequiredRow<{ status: string }>(sqlite, 'SELECT status FROM automation_webhook_triggers WHERE id = ?', 'wh-member').status, 'paused');
    assert.equal(getRequiredRow<{ status: string }>(sqlite, 'SELECT status FROM automation_runs WHERE id = ?', 'run-member').status, 'failed');
    assert.equal(getRequiredRow<{ enabled: number }>(sqlite, 'SELECT enabled FROM channel_user_bindings WHERE user_id = ?', 'user-member').enabled, 0);

    const permission = readOrganizationPermissionForUser('user-member').permission;
    assert.equal(permission?.status, 'archived');
    assert.equal(hasOrganizationPermission(permission, 'canCreatePublicLinks'), false);
    assert.equal(hasOrganizationPermission(permission, 'canDeleteStudioAssets'), false);
  } finally {
    if (sqlite.open) {
      sqlite.close();
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('organization-offboarding-test: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
