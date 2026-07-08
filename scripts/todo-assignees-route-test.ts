import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

type RouteSession = {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
  session: {
    id: string;
  };
};

type JsonObject = Record<string, unknown>;
type RouteRequestInit = Omit<RequestInit, 'headers' | 'signal'> & {
  headers?: HeadersInit;
};

function request(url: string, init: RouteRequestInit = {}) {
  const headers = new Headers(init.headers);
  return new NextRequest(url, {
    ...init,
    headers,
  });
}

async function responseJson(response: Response) {
  return await response.json() as JsonObject;
}

function insertUser(sqlite: Database.Database, id: string, name: string, email: string, role = 'user') {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
    ) VALUES (?, ?, ?, 1, NULL, ?, 0, NULL, NULL, ?, ?)
  `).run(id, name, email, role, now, now);
}

function insertOrganizationPermission(
  sqlite: Database.Database,
  organizationId: string,
  userId: string,
  role = 'member',
) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status,
      can_write_team_workspace, can_create_public_links, can_create_team_automations,
      can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
      can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'active', 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, ?, ?)
  `).run(organizationId, userId, role, now, now);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-todo-assignees-route-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.BETTER_AUTH_URL = 'http://localhost';

  await fs.mkdir(dataRoot, { recursive: true });

  const { runMigrations } = await import('../app/lib/db/migrate');
  const { ensureOrganizationBootstrapForUser } = await import('../app/lib/organization/bootstrap');
  const {
    createCanvasProject,
    ensureCanvasProjectWorkspace,
    upsertCanvasProjectMember,
  } = await import('../app/lib/projects/service');

  let projectWorkspaceId = '';
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    runMigrations(sqlite);
    insertUser(sqlite, 'owner-user', 'Owner User', 'owner@example.test', 'admin');
    insertUser(sqlite, 'project-manager', 'Project Manager', 'manager@example.test');
    insertUser(sqlite, 'project-member', 'Project Member', 'member@example.test');
    insertUser(sqlite, 'project-external', 'Project External', 'external@example.test');
    insertUser(sqlite, 'org-only-user', 'Org Only', 'org-only@example.test');

    sqlite.exec('BEGIN IMMEDIATE');
    const ownerStatus = ensureOrganizationBootstrapForUser(sqlite, 'owner-user');
    sqlite.exec('COMMIT');
    assert.ok(ownerStatus.organizationId);
    const organizationId = ownerStatus.organizationId;

    insertOrganizationPermission(sqlite, organizationId, 'project-manager', 'member');
    insertOrganizationPermission(sqlite, organizationId, 'project-member', 'member');
    insertOrganizationPermission(sqlite, organizationId, 'project-external', 'external');
    insertOrganizationPermission(sqlite, organizationId, 'org-only-user', 'member');

    const project = createCanvasProject(sqlite, {
      organizationId,
      name: 'Assignee Project',
      createdByUserId: 'owner-user',
    });
    const projectWorkspace = ensureCanvasProjectWorkspace(sqlite, {
      organizationId,
      projectId: project.id,
    });
    projectWorkspaceId = projectWorkspace.id;

    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'project-manager',
      role: 'admin',
      canRead: true,
      canWrite: true,
      canManage: true,
      invitedByUserId: 'owner-user',
    });
    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'project-member',
      role: 'member',
      canRead: true,
      canWrite: true,
      canManage: false,
      invitedByUserId: 'owner-user',
    });
    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'project-external',
      role: 'external',
      canRead: true,
      canWrite: false,
      canManage: false,
      invitedByUserId: 'owner-user',
    });
  } finally {
    sqlite.close();
  }

  try {
    const { auth } = await import('../app/lib/auth');
    const currentSession: RouteSession = {
      user: {
        id: 'project-manager',
        email: 'manager@example.test',
        name: 'Project Manager',
        role: 'member',
      },
      session: {
        id: 'todo-assignees-route-session',
      },
    };
    const didPatchSession = Reflect.set(auth.api, 'getSession', async () => currentSession);
    assert.equal(didPatchSession, true);

    const assigneesRoute = await import('../app/api/todos/assignees/route');
    const personalResponse = await assigneesRoute.GET(request('http://localhost/api/todos/assignees'));
    assert.equal(personalResponse.status, 200);
    const personal = await responseJson(personalResponse);
    assert.deepEqual((personal.data as Array<{ id: string }>).map((candidate) => candidate.id), ['project-manager']);

    const projectResponse = await assigneesRoute.GET(
      request(`http://localhost/api/todos/assignees?workspaceId=${encodeURIComponent(projectWorkspaceId)}`),
    );
    assert.equal(projectResponse.status, 200);
    const projectAssignees = await responseJson(projectResponse);
    assert.equal(projectAssignees.success, true);
    assert.ok(Array.isArray(projectAssignees.data));

    const ids = new Set((projectAssignees.data as Array<{ id: string }>).map((candidate) => candidate.id));
    assert.equal(ids.has('owner-user'), true);
    assert.equal(ids.has('project-manager'), true);
    assert.equal(ids.has('project-member'), true);
    assert.equal(ids.has('project-external'), true);
    assert.equal(ids.has('org-only-user'), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('todo-assignees-route-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
