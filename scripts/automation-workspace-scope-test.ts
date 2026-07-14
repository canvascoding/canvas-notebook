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

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-automation-scope-'));
  const dataRoot = path.join(tempRoot, 'data');
  const dbPath = path.join(dataRoot, 'sqlite.db');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  await fs.mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(dbPath);

  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('user-owner', 'Owner', 'owner@example.test', 1, 'admin', now, now);
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('user-member', 'Member', 'member@example.test', 1, 'member', now, now);

    sqlite.exec('BEGIN IMMEDIATE');
    const ownerStatus = ensureOrganizationBootstrapForUser(sqlite, 'user-owner');
    sqlite.exec('COMMIT');
    assert.ok(ownerStatus.organizationId);
    const organizationId = ownerStatus.organizationId;

    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-member',
      teamFeaturesEnabled: true,
    });
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
      'user-member',
      'member',
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      0,
      0,
      0,
      0,
      now,
      now,
    );

    const workspaces = sqlite.prepare(`
      SELECT id, type, owner_user_id
      FROM canvas_workspaces
      ORDER BY type ASC, created_at ASC
    `).all() as WorkspaceRow[];
    const ownerPersonalWorkspace = workspaces.find((workspace) => workspace.type === 'personal' && workspace.owner_user_id === 'user-owner');
    const memberPersonalWorkspace = workspaces.find((workspace) => workspace.type === 'personal' && workspace.owner_user_id === 'user-member');
    const teamWorkspace = workspaces.find((workspace) => workspace.type === 'organization');
    assert.ok(ownerPersonalWorkspace?.id);
    assert.ok(memberPersonalWorkspace?.id);
    assert.ok(teamWorkspace?.id);

    const privateTeamWorkspaceId = 'ws-private-automation-team';
    sqlite.prepare(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name,
        workspace_icon, status, is_default, created_at, updated_at
      ) VALUES (?, ?, 'team', NULL, ?, 'Private Automation Team', 'users-round', 'active', 0, ?, ?)
    `).run(
      privateTeamWorkspaceId,
      organizationId,
      `workspaces/team/${organizationId}/private-automation-team/files`,
      now,
      now,
    );
    sqlite.prepare(`
      INSERT INTO canvas_workspace_members (
        organization_id, workspace_id, user_id, role, status,
        can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
      ) VALUES (?, ?, 'user-owner', 'admin', 'active', 1, 1, 1, 'user-owner', ?, ?)
    `).run(organizationId, privateTeamWorkspaceId, now, now);

    sqlite.close();

    const setMemberCanCreateTeamAutomations = (enabled: boolean) => {
      const permissionsDb = new Database(dbPath);
      try {
        permissionsDb.prepare(`
          UPDATE organization_user_permissions
          SET can_create_team_automations = ?, updated_at = ?
          WHERE organization_id = ? AND user_id = ?
        `).run(enabled ? 1 : 0, Date.now(), organizationId, 'user-member');
      } finally {
        permissionsDb.close();
      }
    };

    const setMemberPrivateTeamAccess = (enabled: boolean) => {
      const permissionsDb = new Database(dbPath);
      try {
        if (enabled) {
          permissionsDb.prepare(`
            INSERT INTO canvas_workspace_members (
              organization_id, workspace_id, user_id, role, status,
              can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
            ) VALUES (?, ?, 'user-member', 'member', 'active', 1, 1, 0, 'user-owner', ?, ?)
            ON CONFLICT(workspace_id, user_id) DO UPDATE SET
              status = 'active', can_read = 1, can_write = 1, updated_at = excluded.updated_at
          `).run(organizationId, privateTeamWorkspaceId, Date.now(), Date.now());
        } else {
          permissionsDb.prepare(`
            DELETE FROM canvas_workspace_members
            WHERE workspace_id = ? AND user_id = 'user-member'
          `).run(privateTeamWorkspaceId);
        }
      } finally {
        permissionsDb.close();
      }
    };

    const {
      createAutomationJob,
      getAutomationRun,
      listAutomationJobs,
      moveAutomationJobToWorkspace,
      scheduleAutomationJobRun,
      upsertHeartbeatJob,
    } = await import('../app/lib/automations/store');
    const { resolveAutomationScopeForWorkspaceChange } = await import('../app/lib/automations/policy');

    const memberPersonalJob = await createAutomationJob({
      name: 'Member personal job',
      prompt: 'Summarize my workspace.',
      workspaceId: memberPersonalWorkspace.id,
      schedule: { kind: 'daily', times: ['09:00'], timeZone: 'UTC' },
    }, 'user-member');

    assert.equal(memberPersonalJob.scope, 'personal');
    assert.equal(memberPersonalJob.workspaceId, memberPersonalWorkspace.id);
    assert.equal(memberPersonalJob.workspaceType, 'personal');
    assert.equal(memberPersonalJob.ownerUserId, 'user-member');
    assert.equal(memberPersonalJob.responsibleUserId, 'user-member');
    assert.equal(memberPersonalJob.jobScope, `personal:user-member:${memberPersonalWorkspace.id}`);

    await assert.rejects(
      () => createAutomationJob({
        name: 'Blocked team job',
        prompt: 'Write to team workspace.',
        scope: 'team',
        workspaceId: teamWorkspace.id,
        schedule: { kind: 'daily', times: ['10:00'], timeZone: 'UTC' },
      }, 'user-member'),
      /Organization automation permission required/,
    );

    await assert.rejects(
      () => createAutomationJob({
        name: 'Blocked personal job in team workspace',
        prompt: 'This should stay personal.',
        scope: 'personal',
        workspaceId: teamWorkspace.id,
        schedule: { kind: 'daily', times: ['10:15'], timeZone: 'UTC' },
      }, 'user-member'),
      /Personal automations require a personal workspace/,
    );

    setMemberCanCreateTeamAutomations(true);
    const memberOrganizationJob = await createAutomationJob({
      name: 'Member organization job',
      prompt: 'Summarize the team workspace as a temporary automation owner.',
      scope: 'team',
      workspaceId: teamWorkspace.id,
      schedule: { kind: 'daily', times: ['10:30'], timeZone: 'UTC' },
    }, { id: 'user-member', role: 'member', email: 'member@example.test' });

    assert.equal(memberOrganizationJob.scope, 'organization');
    assert.equal(memberOrganizationJob.createdByUserId, 'user-member');
    assert.equal(memberOrganizationJob.ownerUserId, null);
    assert.equal(memberOrganizationJob.jobScope, `organization:${organizationId}:${teamWorkspace.id}`);
    const memberJobsWithOrgAccess = await listAutomationJobs('user-member');
    assert.ok(memberJobsWithOrgAccess.some((job) => job.id === memberOrganizationJob.id));

    const privateTeamJob = await createAutomationJob({
      name: 'Private team job',
      prompt: 'Only members of this team workspace may see this automation.',
      scope: 'team',
      workspaceId: privateTeamWorkspaceId,
      schedule: { kind: 'daily', times: ['10:45'], timeZone: 'UTC' },
    }, { id: 'user-owner', role: 'admin', email: 'owner@example.test' });
    assert.equal(privateTeamJob.workspaceType, 'team');
    assert.equal(
      (await listAutomationJobs('user-member')).some((job) => job.id === privateTeamJob.id),
      false,
      'organization permission alone must not expose a team-workspace automation',
    );
    setMemberPrivateTeamAccess(true);
    assert.equal(
      (await listAutomationJobs('user-member')).some((job) => job.id === privateTeamJob.id),
      true,
      'assigned team-workspace members with automation permission should see the automation',
    );

    const memberOrganizationTarget = await resolveAutomationScopeForWorkspaceChange(
      teamWorkspace.id,
      { id: 'user-member', role: 'member', email: 'member@example.test' },
    );
    const movedMemberJob = await moveAutomationJobToWorkspace(memberPersonalJob.id, memberOrganizationTarget, {
      actorUserId: 'user-member',
      responsibleUserId: 'user-member',
    });
    assert.equal(movedMemberJob.scope, 'organization');
    assert.equal(movedMemberJob.ownerUserId, null);
    assert.equal(movedMemberJob.workspaceId, teamWorkspace.id);
    assert.equal(movedMemberJob.jobScope, `organization:${organizationId}:${teamWorkspace.id}`);

    const memberPersonalTarget = await resolveAutomationScopeForWorkspaceChange(
      memberPersonalWorkspace.id,
      { id: 'user-member', role: 'member', email: 'member@example.test' },
    );
    const movedBackMemberJob = await moveAutomationJobToWorkspace(memberPersonalJob.id, memberPersonalTarget, {
      actorUserId: 'user-member',
      responsibleUserId: 'user-member',
      resetPreferredSkill: true,
      resetFixedDeliverySession: true,
    });
    assert.equal(movedBackMemberJob.scope, 'personal');
    assert.equal(movedBackMemberJob.ownerUserId, 'user-member');
    assert.equal(movedBackMemberJob.workspaceId, memberPersonalWorkspace.id);
    assert.equal(movedBackMemberJob.jobScope, `personal:user-member:${memberPersonalWorkspace.id}`);

    setMemberCanCreateTeamAutomations(false);

    const ownerOrganizationJob = await createAutomationJob({
      name: 'Owner organization job',
      prompt: 'Summarize the team workspace.',
      scope: 'team',
      workspaceId: teamWorkspace.id,
      schedule: { kind: 'daily', times: ['11:00'], timeZone: 'UTC' },
    }, { id: 'user-owner', role: 'admin', email: 'owner@example.test' });

    assert.equal(ownerOrganizationJob.scope, 'organization');
    assert.equal(ownerOrganizationJob.workspaceId, teamWorkspace.id);
    assert.equal(ownerOrganizationJob.workspaceType, 'organization');
    assert.equal(ownerOrganizationJob.ownerUserId, null);
    assert.equal(ownerOrganizationJob.responsibleUserId, 'user-owner');
    assert.equal(ownerOrganizationJob.approvedByUserId, 'user-owner');
    assert.equal(ownerOrganizationJob.jobScope, `organization:${organizationId}:${teamWorkspace.id}`);
    assert.ok(ownerOrganizationJob.serviceActorId?.startsWith('org-service:'));

    const memberJobs = await listAutomationJobs('user-member');
    assert.deepEqual(memberJobs.map((job) => job.id), [memberPersonalJob.id]);
    const ownerJobs = await listAutomationJobs('user-owner');
    assert.ok(ownerJobs.some((job) => job.id === ownerOrganizationJob.id));
    assert.equal(ownerJobs.some((job) => job.id === memberPersonalJob.id), false);

    const run = await scheduleAutomationJobRun(ownerOrganizationJob.id, 'manual', new Date('2026-06-20T09:00:00.000Z'), {
      actorUserId: 'user-owner',
    });
    assert.ok(run);
    assert.equal(run.scope, 'organization');
    assert.equal(run.workspaceId, teamWorkspace.id);
    assert.equal(run.workspaceType, 'organization');
    assert.equal(run.jobScope, ownerOrganizationJob.jobScope);
    assert.equal(run.actorType, 'user');
    assert.equal(run.actorUserId, 'user-owner');
    assert.equal(run.serviceActorId, null);

    const ownerPrivateTeamTarget = await resolveAutomationScopeForWorkspaceChange(
      privateTeamWorkspaceId,
      { id: 'user-owner', role: 'admin', email: 'owner@example.test' },
    );
    await assert.rejects(
      () => moveAutomationJobToWorkspace(ownerOrganizationJob.id, ownerPrivateTeamTarget, {
        actorUserId: 'user-owner',
        responsibleUserId: 'user-owner',
      }),
      /Wait until the current automation run has finished/,
      'workspace changes must be blocked while a run is in flight',
    );

    const loadedRun = await getAutomationRun(run.id);
    assert.equal(loadedRun?.workspaceId, teamWorkspace.id);
    assert.equal(loadedRun?.scope, 'organization');
    assert.equal(loadedRun?.jobScope, ownerOrganizationJob.jobScope);

    const heartbeatJob = await upsertHeartbeatJob({
      userId: 'user-member',
      agentId: 'agent-member',
      enabled: true,
      schedule: { kind: 'interval', every: 30, unit: 'minutes', timeZone: 'UTC' },
    });
    assert.equal(heartbeatJob.scope, 'personal');
    assert.equal(heartbeatJob.workspaceType, 'personal');
    assert.equal(heartbeatJob.ownerUserId, 'user-member');
    assert.equal(heartbeatJob.responsibleUserId, 'user-member');
    assert.equal(heartbeatJob.lastEditedByUserId, 'user-member');
    assert.equal(heartbeatJob.jobScope, 'personal:user-member:personal');
  } finally {
    if (sqlite.open) {
      sqlite.close();
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('automation-workspace-scope-test: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
