import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import {
  ensureDefaultWorkspaceRecords,
  listWorkspaceContextsForUser,
  resolveDefaultWorkspaceContext,
  resolveWorkspaceContextById,
  workspaceAbsoluteRoot,
} from '../app/lib/workspaces/service';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-model-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';

  await fs.mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('user-owner', 'Owner', 'owner@example.com', 1, 'admin', now, now);
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('user-member', 'Member', 'member@example.com', 1, 'member', now, now);
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('user-no-permission', 'No Permission', 'no-permission@example.com', 1, 'member', now, now);

    sqlite.exec('BEGIN IMMEDIATE');
    const ownerStatus = ensureOrganizationBootstrapForUser(sqlite, 'user-owner');
    assert.equal(ownerStatus.configured, true);
    assert.equal(ownerStatus.teamFeaturesEnabled, true);
    assert.equal(ownerStatus.databaseProvider, 'postgres');
    assert.ok(ownerStatus.organizationId);
    sqlite.exec('COMMIT');

    const organizationId = ownerStatus.organizationId!;
    const ownerActor = resolveWorkspaceActor({
      id: 'user-owner',
      email: 'owner@example.com',
      role: 'admin',
    });
    const ownerWorkspaces = listWorkspaceContextsForUser(sqlite, { actor: ownerActor, organizationId });
    assert.deepEqual(ownerWorkspaces.map((workspace) => workspace.workspaceType), ['personal', 'team']);
    assert.equal(ownerWorkspaces[0].permissions.canRead, true);
    assert.equal(ownerWorkspaces[0].permissions.canWrite, true);
    assert.equal(ownerWorkspaces[1].permissions.canRead, true);
    assert.equal(ownerWorkspaces[1].permissions.canWrite, true);
    assert.equal(
      ownerWorkspaces[0].rootPath,
      path.join(dataRoot, 'workspaces', 'personal', 'user-owner', 'files')
    );
    assert.equal(
      ownerWorkspaces[1].rootPath,
      path.join(dataRoot, 'workspaces', 'team', organizationId, 'files')
    );
    await fs.access(ownerWorkspaces[0].rootPath);
    await fs.access(ownerWorkspaces[1].rootPath);

    const defaultWorkspace = resolveDefaultWorkspaceContext(sqlite, { actor: ownerActor, organizationId });
    assert.equal(defaultWorkspace?.workspaceId, ownerWorkspaces[0].workspaceId);

    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-member',
      teamFeaturesEnabled: true,
    });
    sqlite.prepare(`
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role, can_write_team_workspace, can_create_public_links,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(organizationId, 'user-member', 'member', 0, 1, now, now);

    const memberActor = resolveWorkspaceActor({
      id: 'user-member',
      email: 'member@example.com',
      role: 'member',
    });
    const memberWorkspaces = listWorkspaceContextsForUser(sqlite, { actor: memberActor, organizationId });
    assert.deepEqual(memberWorkspaces.map((workspace) => workspace.workspaceType), ['personal', 'team']);
    assert.equal(memberWorkspaces[0].ownerUserId, 'user-member');
    assert.equal(memberWorkspaces[1].permissions.canRead, true);
    assert.equal(memberWorkspaces[1].permissions.canWrite, false);

    const ownerPersonalForMember = resolveWorkspaceContextById(sqlite, {
      actor: memberActor,
      workspaceId: ownerWorkspaces[0].workspaceId,
    });
    assert.equal(ownerPersonalForMember, null);

    const ensured = ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-member',
      teamFeaturesEnabled: true,
    });
    assert.equal(ensured.personal.id, memberWorkspaces[0].workspaceId);
    assert.equal(ensured.team?.id, ownerWorkspaces[1].workspaceId);
    assert.equal(
      workspaceAbsoluteRoot(ensured.personal.rootRelativePath),
      path.join(dataRoot, 'workspaces', 'personal', 'user-member', 'files')
    );

    sqlite.prepare(`
      UPDATE canvas_workspaces
      SET status = 'disabled', display_name = 'Outdated Name'
      WHERE id = ?
    `).run(ensured.personal.id);
    const disabledEnsure = ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-member',
      teamFeaturesEnabled: true,
    });
    assert.equal(disabledEnsure.personal.status, 'disabled');
    assert.equal(disabledEnsure.personal.displayName, 'Personal Workspace');
    const memberWorkspacesAfterDisable = listWorkspaceContextsForUser(sqlite, { actor: memberActor, organizationId });
    assert.deepEqual(memberWorkspacesAfterDisable.map((workspace) => workspace.workspaceType), ['team']);

    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-no-permission',
      teamFeaturesEnabled: true,
    });
    const actorWithoutPermission = resolveWorkspaceActor({
      id: 'user-no-permission',
      email: 'no-permission@example.com',
      role: 'member',
    });
    const noPermissionWorkspaces = listWorkspaceContextsForUser(sqlite, {
      actor: actorWithoutPermission,
      organizationId,
    });
    assert.deepEqual(noPermissionWorkspaces.map((workspace) => workspace.workspaceType), ['personal']);
    assert.equal(noPermissionWorkspaces[0].permissions.canCreatePublicLinks, false);
    assert.throws(() => workspaceAbsoluteRoot('../outside'), /Invalid workspace root path/);
  } finally {
    sqlite.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('workspace-model-service-test: ok');
}

void main();
