import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';
import {
  createCanvasCustomer,
  createCanvasProject,
  ensureCanvasProjectWorkspace,
  getCanvasProjectMember,
  normalizeSlug,
  upsertCanvasProjectMember,
} from '../app/lib/projects/service';
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import {
  ensureDefaultWorkspaceRecords,
  listWorkspaceContextsForUser,
  projectWorkspaceRootRelativePath,
  resolveWorkspaceContextById,
  workspaceAbsoluteRoot,
} from '../app/lib/workspaces/service';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-project-customer-model-'));
  const dataRoot = path.join(tempRoot, 'data');
  const previousData = process.env.DATA;
  const previousDeploymentMode = process.env.CANVAS_DEPLOYMENT_MODE;
  const previousDatabaseProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';

  await fs.mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    runMigrations(sqlite);
    runMigrations(sqlite);

    const now = Date.now();
    for (const [id, name, email, role] of [
      ['owner-user', 'Owner', 'owner@example.test', 'admin'],
      ['member-user', 'Member', 'member@example.test', 'member'],
      ['external-user', 'External', 'external@example.test', 'external'],
      ['blocked-user', 'Blocked', 'blocked@example.test', 'member'],
    ]) {
      sqlite.prepare(`
        INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(id, name, email, role, now, now);
    }

    sqlite.exec('BEGIN IMMEDIATE');
    const ownerStatus = ensureOrganizationBootstrapForUser(sqlite, 'owner-user');
    sqlite.exec('COMMIT');
    assert.equal(ownerStatus.configured, true);
    assert.equal(ownerStatus.teamFeaturesEnabled, true);
    const organizationId = ownerStatus.organizationId!;

    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'member-user',
      teamFeaturesEnabled: true,
    });
    sqlite.prepare(`
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role, status, can_write_team_workspace,
        can_create_public_links, created_at, updated_at
      ) VALUES (?, ?, 'member', 'active', 0, 1, ?, ?)
    `).run(organizationId, 'member-user', now, now);
    sqlite.prepare(`
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role, status, can_write_team_workspace,
        can_create_public_links, created_at, updated_at
      ) VALUES (?, ?, 'member', 'active', 0, 1, ?, ?)
    `).run(organizationId, 'blocked-user', now, now);

    assert.equal(normalizeSlug('Kunde A / Sommer 2026'), 'kunde-a-sommer-2026');

    const customer = createCanvasCustomer(sqlite, {
      organizationId,
      name: 'Kunde A',
      createdByUserId: 'owner-user',
      metadataJson: JSON.stringify({ segment: 'agency' }),
    });
    assert.equal(customer.slug, 'kunde-a');
    const duplicateCustomer = createCanvasCustomer(sqlite, {
      organizationId,
      name: 'Kunde-A',
      createdByUserId: 'owner-user',
    });
    assert.equal(duplicateCustomer.slug, 'kunde-a-2');

    assert.throws(
      () => createCanvasProject(sqlite, {
        organizationId,
        customerId: 'missing-customer',
        name: 'Invalid Project',
      }),
      /customer not found/i,
    );

    const project = createCanvasProject(sqlite, {
      organizationId,
      customerId: customer.id,
      name: 'Sommer Kampagne',
      createdByUserId: 'owner-user',
    });
    assert.equal(project.customerId, customer.id);
    const duplicateProject = createCanvasProject(sqlite, {
      organizationId,
      customerId: customer.id,
      name: 'Sommer-Kampagne',
      createdByUserId: 'owner-user',
    });
    assert.equal(duplicateProject.slug, 'sommer-kampagne-2');

    const projectWorkspace = ensureCanvasProjectWorkspace(sqlite, {
      organizationId,
      projectId: project.id,
    });
    assert.equal(projectWorkspace.type, 'project');
    assert.equal(projectWorkspace.projectId, project.id);
    assert.equal(projectWorkspace.customerId, customer.id);
    assert.equal(projectWorkspace.rootRelativePath, projectWorkspaceRootRelativePath(project.id));
    assert.equal(workspaceAbsoluteRoot(projectWorkspace.rootRelativePath), path.join(dataRoot, 'workspaces', 'project', project.id, 'files'));
    await fs.access(path.join(dataRoot, 'workspaces', 'project', project.id, 'files'));
    assert.throws(
      () => sqlite.prepare(`
        INSERT INTO canvas_workspaces (
          id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
        ) VALUES ('ws_invalid_project', ?, 'project', NULL, 'workspaces/project/missing/files', 'Invalid', 'active', ?, ?)
      `).run(organizationId, now, now),
      /project workspace requires project_id/i,
    );

    const ensuredAgain = ensureCanvasProjectWorkspace(sqlite, {
      organizationId,
      projectId: project.id,
    });
    assert.equal(ensuredAgain.id, projectWorkspace.id);

    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'external-user',
      role: 'external',
      canRead: true,
      canWrite: true,
      canManage: false,
      invitedByUserId: 'owner-user',
    });
    const externalMembership = getCanvasProjectMember(sqlite, organizationId, project.id, 'external-user');
    assert.equal(externalMembership?.canRead, true);
    assert.equal(externalMembership?.canWrite, true);
    assert.equal(externalMembership?.canManage, false);

    const ownerActor = resolveWorkspaceActor({ id: 'owner-user', email: 'owner@example.test', role: 'admin' });
    const ownerWorkspaces = listWorkspaceContextsForUser(sqlite, { actor: ownerActor, organizationId });
    assert.deepEqual(ownerWorkspaces.map((workspace) => workspace.workspaceType), ['personal', 'team', 'project']);
    const ownerProject = ownerWorkspaces.find((workspace) => workspace.workspaceType === 'project');
    assert.equal(ownerProject?.projectId, project.id);
    assert.equal(ownerProject?.permissions.canManageWorkspace, true);

    const memberActor = resolveWorkspaceActor({ id: 'member-user', email: 'member@example.test', role: 'member' });
    const memberWorkspaces = listWorkspaceContextsForUser(sqlite, { actor: memberActor, organizationId });
    assert.deepEqual(memberWorkspaces.map((workspace) => workspace.workspaceType), ['personal', 'team']);
    assert.equal(resolveWorkspaceContextById(sqlite, { actor: memberActor, workspaceId: projectWorkspace.id }), null);

    const externalActor = resolveWorkspaceActor({ id: 'external-user', email: 'external@example.test', role: 'external' });
    const externalWorkspaces = listWorkspaceContextsForUser(sqlite, { actor: externalActor, organizationId });
    assert.deepEqual(externalWorkspaces.map((workspace) => workspace.workspaceType), ['project']);
    assert.equal(externalWorkspaces[0].workspaceId, projectWorkspace.id);
    assert.equal(externalWorkspaces[0].permissions.canRead, true);
    assert.equal(externalWorkspaces[0].permissions.canWrite, true);
    assert.equal(externalWorkspaces[0].permissions.canCreatePublicLinks, false);
    assert.equal(resolveWorkspaceContextById(sqlite, { actor: externalActor, workspaceId: ownerWorkspaces[1].workspaceId }), null);
    assert.equal(resolveWorkspaceContextById(sqlite, { actor: externalActor, workspaceId: projectWorkspace.id })?.projectId, project.id);

    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'blocked-user',
      role: 'member',
      status: 'disabled',
      canRead: true,
    });
    const blockedActor = resolveWorkspaceActor({ id: 'blocked-user', email: 'blocked@example.test', role: 'member' });
    assert.equal(resolveWorkspaceContextById(sqlite, { actor: blockedActor, workspaceId: projectWorkspace.id }), null);

    for (const [table, columns] of [
      ['canvas_customers', ['organization_id', 'slug']],
      ['canvas_projects', ['organization_id', 'customer_id', 'slug']],
      ['canvas_project_members', ['project_id', 'user_id', 'can_read', 'can_write', 'can_manage']],
      ['canvas_workspaces', ['customer_id', 'project_id']],
      ['studio_generations', ['customer_id', 'project_id']],
      ['knowledge_sources', ['customer_id', 'project_id']],
      ['audit_events', ['customer_id', 'project_id']],
    ] as const) {
      const existing = new Set(
        (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      for (const column of columns) {
        assert.equal(existing.has(column), true, `${table}.${column} should exist`);
      }
    }
  } finally {
    sqlite.close();
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousDeploymentMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
    else process.env.CANVAS_DEPLOYMENT_MODE = previousDeploymentMode;
    if (previousDatabaseProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousDatabaseProvider;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('project-customer-model-test: ok');
}

void main();
