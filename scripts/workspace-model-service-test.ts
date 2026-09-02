import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { analyzeMarkdownRichMode } from '../app/lib/markdown/rich-markdown-codec';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';
import { createCanvasProject, ensureCanvasProjectWorkspace } from '../app/lib/projects/service';
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import { WORKSPACE_STARTER_DOCUMENT_NAME } from '../app/lib/workspaces/starter-document';
import {
  changeWorkspaceType,
  createWorkspaceRecord,
  deleteWorkspaceRecord,
  ensureDefaultWorkspaceRecords,
  listProjectWorkspaceMembers,
  listTeamWorkspaceMembers,
  listWorkspaceMemberCandidates,
  listWorkspaceContextsForUser,
  removeProjectWorkspaceMember,
  removeTeamWorkspaceMember,
  resolveDefaultWorkspaceContext,
  resolveWorkspaceContextById,
  updateWorkspaceRecord,
  upsertProjectWorkspaceMember,
  upsertTeamWorkspaceMember,
  WorkspaceOperationError,
  workspaceAbsoluteRoot,
} from '../app/lib/workspaces/service';

function getWorkspaceStatus(sqlite: Database.Database, workspaceId: string): string | undefined {
  return (sqlite.prepare('SELECT status FROM canvas_workspaces WHERE id = ?').get(workspaceId) as { status?: string } | undefined)?.status;
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-model-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';

  await fs.mkdir(dataRoot, { recursive: true });
  const legacyRoot = path.join(dataRoot, 'workspace');
  const plannedOwnerPersonalRoot = path.join(dataRoot, 'workspaces', 'personal', 'user-owner', 'files');
  await fs.mkdir(path.join(legacyRoot, 'docs'), { recursive: true });
  await fs.mkdir(plannedOwnerPersonalRoot, { recursive: true });
  await fs.writeFile(path.join(legacyRoot, 'legacy.md'), '# Legacy\n');
  await fs.writeFile(path.join(legacyRoot, 'conflict.md'), '# Legacy conflict\n');
  await fs.writeFile(path.join(legacyRoot, 'docs', 'nested.md'), '# Nested legacy\n');
  await fs.writeFile(path.join(plannedOwnerPersonalRoot, 'conflict.md'), '# Existing personal file\n');
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
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('user-collab', 'Collab', 'collab@example.com', 1, 'member', now, now);

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
    assert.deepEqual(ownerWorkspaces.map((workspace) => workspace.workspaceType), ['personal']);
    assert.equal(ownerWorkspaces[0].isDefault, true);
    assert.equal(ownerWorkspaces[0].permissions.canRead, true);
    assert.equal(ownerWorkspaces[0].permissions.canWrite, true);
    assert.equal(
      ownerWorkspaces[0].rootPath,
      path.join(dataRoot, 'workspaces', 'personal', 'user-owner', 'files')
    );
    await fs.access(ownerWorkspaces[0].rootPath);
    const personalStarterDocument = await fs.readFile(
      path.join(ownerWorkspaces[0].rootPath, WORKSPACE_STARTER_DOCUMENT_NAME),
      'utf8',
    );
    assert.match(personalStarterDocument, /Dein persönlicher Workspace/);
    assert.match(personalStarterDocument, /private Notiz/);
    assert.doesNotMatch(personalStarterDocument, /Euer Team-Workspace/);
    assert.equal(analyzeMarkdownRichMode(personalStarterDocument).mode, 'rich');
    await assert.rejects(
      () => fs.access(path.join(dataRoot, 'workspaces', 'organization', organizationId, 'files')),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'),
    );
    assert.equal(
      await fs.readFile(path.join(ownerWorkspaces[0].rootPath, 'legacy.md'), 'utf8'),
      '# Legacy\n'
    );
    assert.equal(
      await fs.readFile(path.join(ownerWorkspaces[0].rootPath, 'docs', 'nested.md'), 'utf8'),
      '# Nested legacy\n'
    );
    assert.equal(
      await fs.readFile(path.join(ownerWorkspaces[0].rootPath, 'conflict.md'), 'utf8'),
      '# Existing personal file\n'
    );
    assert.equal(
      await fs.readFile(path.join(legacyRoot, 'legacy.md'), 'utf8'),
      '# Legacy\n'
    );

    const legacyImportRoot = path.join(ownerWorkspaces[0].rootPath, '_legacy-workspace-import');
    const legacyImportDirs = await fs.readdir(legacyImportRoot);
    assert.equal(legacyImportDirs.length, 1);
    assert.equal(
      await fs.readFile(path.join(legacyImportRoot, legacyImportDirs[0], 'conflict.md'), 'utf8'),
      '# Legacy conflict\n'
    );

    const markerDir = path.join(dataRoot, 'system', 'migration', 'legacy-workspace-imports');
    const markers = await fs.readdir(markerDir);
    assert.equal(markers.length, 1);
    const marker = JSON.parse(await fs.readFile(path.join(markerDir, markers[0]), 'utf8')) as {
      operation?: string;
      copiedEntries?: string[];
      conflictedEntries?: string[];
      conflictRootRelativePath?: string | null;
    };
    assert.equal(marker.operation, 'legacy-workspace-to-personal-workspace');
    assert.deepEqual(marker.copiedEntries?.sort(), ['docs', 'legacy.md']);
    assert.deepEqual(marker.conflictedEntries, ['conflict.md']);
    assert.equal(marker.conflictRootRelativePath?.startsWith('_legacy-workspace-import/'), true);

    await fs.writeFile(path.join(legacyRoot, 'after-marker.md'), '# After marker\n');
    sqlite.exec('BEGIN IMMEDIATE');
    ensureOrganizationBootstrapForUser(sqlite, 'user-owner');
    sqlite.exec('COMMIT');
    assert.deepEqual(await fs.readdir(legacyImportRoot), legacyImportDirs);
    await assert.rejects(
      () => fs.readFile(path.join(ownerWorkspaces[0].rootPath, 'after-marker.md'), 'utf8'),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
    );

    const defaultWorkspace = resolveDefaultWorkspaceContext(sqlite, { actor: ownerActor, organizationId });
    assert.equal(defaultWorkspace?.workspaceId, ownerWorkspaces[0].workspaceId);

    sqlite.prepare('UPDATE canvas_workspaces SET display_name = ? WHERE id = ?').run('Private notes', ownerWorkspaces[0].workspaceId);
    const renamedDefaults = ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-owner',
    });
    assert.equal(renamedDefaults.personal.displayName, 'Private notes');
    assert.equal(
      await fs.readFile(path.join(ownerWorkspaces[0].rootPath, WORKSPACE_STARTER_DOCUMENT_NAME), 'utf8'),
      personalStarterDocument,
    );

    assert.throws(
      () => deleteWorkspaceRecord(sqlite, { actor: ownerActor, workspaceId: ownerWorkspaces[0].workspaceId }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_IS_DEFAULT',
    );
    assert.throws(
      () => changeWorkspaceType(sqlite, {
        actor: ownerActor,
        workspaceId: ownerWorkspaces[0].workspaceId,
        type: 'team',
        teamFeaturesEnabled: true,
      }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_DEFAULT_TYPE_LOCKED',
    );

    const organizationWorkspace = createWorkspaceRecord(sqlite, {
      actor: ownerActor,
      organizationId,
      type: 'organization',
      name: 'Canvas Studio',
      description: 'Shared organization knowledge and operations.',
      teamFeaturesEnabled: true,
    });
    assert.equal(organizationWorkspace.workspaceType, 'organization');
    assert.equal(organizationWorkspace.isDefault, false);
    assert.equal(organizationWorkspace.ownerUserId, null);
    assert.equal(organizationWorkspace.permissions.canManageWorkspace, true);
    assert.equal(
      organizationWorkspace.rootRelativePath,
      path.posix.join('workspaces', 'organization', organizationId, 'canvas-studio', 'files'),
    );
    await fs.access(organizationWorkspace.rootPath);
    assert.match(
      await fs.readFile(path.join(organizationWorkspace.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME), 'utf8'),
      /Euer Organisations-Workspace/,
    );
    const updatedOrganizationWorkspace = updateWorkspaceRecord(sqlite, {
      actor: ownerActor,
      workspaceId: organizationWorkspace.workspaceId,
      name: 'Organization Hub',
    });
    assert.equal(updatedOrganizationWorkspace.displayName, 'Organization Hub');
    sqlite.prepare('UPDATE canvas_workspaces SET is_default = 1 WHERE id = ?').run(
      organizationWorkspace.workspaceId,
    );
    runMigrations(sqlite);
    const migratedOrganizationDefault = sqlite.prepare(`
      SELECT is_default AS isDefault
      FROM canvas_workspaces
      WHERE id = ?
    `).get(organizationWorkspace.workspaceId) as { isDefault: number };
    assert.equal(migratedOrganizationDefault.isDefault, 0);
    const workspaceIndexes = new Set(
      (sqlite.prepare('PRAGMA index_list(canvas_workspaces)').all() as Array<{ name: string }>)
        .map((index) => index.name),
    );
    assert.equal(workspaceIndexes.has('idx_canvas_workspaces_default_organization'), false);
    assert.throws(
      () => createWorkspaceRecord(sqlite, {
        actor: ownerActor,
        organizationId,
        type: 'organization',
        name: 'Second Organization Workspace',
        teamFeaturesEnabled: true,
      }),
      (error: unknown) => (
        error instanceof WorkspaceOperationError
        && error.code === 'WORKSPACE_ORGANIZATION_ALREADY_EXISTS'
      ),
    );
    assert.throws(
      () => createWorkspaceRecord(sqlite, {
        actor: ownerActor,
        organizationId,
        type: 'organization',
        name: 'Unavailable Organization Workspace',
        teamFeaturesEnabled: false,
      }),
      (error: unknown) => (
        error instanceof WorkspaceOperationError
        && error.code === 'WORKSPACE_TEAM_FEATURES_DISABLED'
      ),
    );

    const extraPersonal = createWorkspaceRecord(sqlite, {
      actor: ownerActor,
      organizationId,
      type: 'personal',
      name: 'Research Notes',
      description: 'Private research, source notes, and draft findings.',
      teamFeaturesEnabled: true,
    });
    assert.equal(extraPersonal.workspaceType, 'personal');
    assert.equal(extraPersonal.description, 'Private research, source notes, and draft findings.');
    assert.equal(extraPersonal.isDefault, false);
    assert.equal(extraPersonal.ownerUserId, 'user-owner');
    assert.equal(
      extraPersonal.rootRelativePath,
      path.posix.join('workspaces', 'personal', 'user-owner', 'research-notes', 'files'),
    );
    await fs.access(extraPersonal.rootPath);

    const updatedExtraPersonal = updateWorkspaceRecord(sqlite, {
      actor: ownerActor,
      workspaceId: extraPersonal.workspaceId,
      description: 'Research briefs and verified source material.',
    });
    assert.equal(updatedExtraPersonal.description, 'Research briefs and verified source material.');
    assert.throws(
      () => updateWorkspaceRecord(sqlite, {
        actor: ownerActor,
        workspaceId: extraPersonal.workspaceId,
        description: 'x'.repeat(281),
      }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_DESCRIPTION_TOO_LONG',
    );

    const extraPersonalDuplicateSlug = createWorkspaceRecord(sqlite, {
      actor: ownerActor,
      organizationId,
      type: 'personal',
      name: 'Research Notes',
      teamFeaturesEnabled: true,
    });
    assert.equal(
      extraPersonalDuplicateSlug.rootRelativePath,
      path.posix.join('workspaces', 'personal', 'user-owner', 'research-notes-2', 'files'),
    );

    const typeChangeWorkspace = createWorkspaceRecord(sqlite, {
      actor: ownerActor,
      organizationId,
      type: 'personal',
      name: 'Type Change Notes',
      teamFeaturesEnabled: true,
    });
    const typeChangeOriginalRoot = typeChangeWorkspace.rootPath;
    await fs.writeFile(path.join(typeChangeOriginalRoot, 'type-change.md'), '# Type change\n');
    const changedToTeam = changeWorkspaceType(sqlite, {
      actor: ownerActor,
      workspaceId: typeChangeWorkspace.workspaceId,
      type: 'team',
      teamFeaturesEnabled: true,
    });
    assert.equal(changedToTeam.workspaceType, 'team');
    assert.equal(changedToTeam.ownerUserId, null);
    assert.equal(changedToTeam.permissions.canManageWorkspace, true);
    assert.equal(
      await fs.readFile(path.join(changedToTeam.rootPath, 'type-change.md'), 'utf8'),
      '# Type change\n',
    );
    await assert.rejects(
      () => fs.access(path.join(typeChangeOriginalRoot, 'type-change.md')),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'),
    );
    assert.equal(
      listTeamWorkspaceMembers(sqlite, changedToTeam.workspaceId).some((member) => member.userId === 'user-owner' && member.canManage),
      true,
    );
    const changedBackToPersonal = changeWorkspaceType(sqlite, {
      actor: ownerActor,
      workspaceId: changedToTeam.workspaceId,
      type: 'personal',
      teamFeaturesEnabled: true,
    });
    assert.equal(changedBackToPersonal.workspaceType, 'personal');
    assert.equal(changedBackToPersonal.ownerUserId, 'user-owner');
    assert.equal(
      await fs.readFile(path.join(changedBackToPersonal.rootPath, 'type-change.md'), 'utf8'),
      '# Type change\n',
    );

    const teamWorkspace = createWorkspaceRecord(sqlite, {
      actor: ownerActor,
      organizationId,
      type: 'team',
      name: 'Design Team',
      teamFeaturesEnabled: true,
    });
    assert.equal(teamWorkspace.workspaceType, 'team');
    assert.equal(teamWorkspace.isDefault, false);
    assert.equal(
      teamWorkspace.rootRelativePath,
      path.posix.join('workspaces', 'team', organizationId, 'design-team', 'files'),
    );
    const teamStarterDocument = await fs.readFile(
      path.join(teamWorkspace.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME),
      'utf8',
    );
    assert.match(teamStarterDocument, /Euer Team-Workspace/);
    assert.match(teamStarterDocument, /@Mention/);
    assert.doesNotMatch(teamStarterDocument, /Dein persönlicher Workspace/);
    assert.equal(analyzeMarkdownRichMode(teamStarterDocument).mode, 'rich');
    const teamMemberRow = sqlite.prepare(`
      SELECT can_read, can_write, can_manage
      FROM canvas_workspace_members
      WHERE workspace_id = ? AND user_id = ?
    `).get(teamWorkspace.workspaceId, 'user-owner') as { can_read: number; can_write: number; can_manage: number } | undefined;
    assert.deepEqual(teamMemberRow, { can_read: 1, can_write: 1, can_manage: 1 });
    sqlite.prepare(`
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role, can_write_team_workspace, can_create_public_links,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(organizationId, 'user-collab', 'member', 0, 1, now, now);
    const memberCandidates = listWorkspaceMemberCandidates(sqlite, organizationId);
    assert.equal(memberCandidates.some((candidate) => candidate.userId === 'user-collab'), true);
    const collabMember = upsertTeamWorkspaceMember(sqlite, {
      actor: ownerActor,
      organizationId,
      workspaceId: teamWorkspace.workspaceId,
      userId: 'user-collab',
      role: 'member',
      canRead: true,
      canWrite: true,
      canManage: false,
    });
    assert.equal(collabMember.canRead, true);
    assert.equal(collabMember.canWrite, true);
    assert.equal(collabMember.canManage, false);
    assert.equal(listTeamWorkspaceMembers(sqlite, teamWorkspace.workspaceId).length, 2);
    assert.throws(
      () => upsertTeamWorkspaceMember(sqlite, {
        actor: ownerActor,
        organizationId,
        workspaceId: teamWorkspace.workspaceId,
        userId: 'user-owner',
        role: 'member',
        canRead: true,
        canWrite: true,
        canManage: false,
      }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_LAST_MANAGER',
    );
    assert.equal(
      listTeamWorkspaceMembers(sqlite, teamWorkspace.workspaceId).find((member) => member.userId === 'user-owner')?.canManage,
      true,
    );
    assert.throws(
      () => removeTeamWorkspaceMember(sqlite, {
        organizationId,
        workspaceId: teamWorkspace.workspaceId,
        userId: 'user-owner',
      }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_LAST_MANAGER',
    );
    upsertTeamWorkspaceMember(sqlite, {
      actor: ownerActor,
      organizationId,
      workspaceId: teamWorkspace.workspaceId,
      userId: 'user-collab',
      role: 'admin',
      canRead: true,
      canWrite: true,
      canManage: true,
    });
    removeTeamWorkspaceMember(sqlite, {
      organizationId,
      workspaceId: teamWorkspace.workspaceId,
      userId: 'user-owner',
    });
    assert.deepEqual(
      listTeamWorkspaceMembers(sqlite, teamWorkspace.workspaceId).map((member) => member.userId),
      ['user-collab'],
    );

    const project = createCanvasProject(sqlite, {
      organizationId,
      name: 'Client Launch',
      createdByUserId: 'user-owner',
    });
    const projectWorkspaceRecord = ensureCanvasProjectWorkspace(sqlite, {
      organizationId,
      projectId: project.id,
    });
    const projectWorkspace = resolveWorkspaceContextById(sqlite, {
      actor: ownerActor,
      workspaceId: projectWorkspaceRecord.id,
    });
    assert.equal(projectWorkspace?.workspaceType, 'project');
    assert.equal(projectWorkspace?.projectId, project.id);
    assert.match(
      await fs.readFile(path.join(projectWorkspace!.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME), 'utf8'),
      /Euer Projekt-Workspace/,
    );
    const projectCollabMember = upsertProjectWorkspaceMember(sqlite, {
      actor: ownerActor,
      organizationId,
      workspaceId: projectWorkspaceRecord.id,
      projectId: project.id,
      userId: 'user-collab',
      role: 'member',
      canRead: true,
      canWrite: false,
      canManage: false,
    });
    assert.equal(projectCollabMember.workspaceId, projectWorkspaceRecord.id);
    assert.equal(projectCollabMember.canRead, true);
    assert.equal(projectCollabMember.canWrite, false);
    assert.equal(projectCollabMember.canManage, false);
    const projectOwnerMember = upsertProjectWorkspaceMember(sqlite, {
      actor: ownerActor,
      organizationId,
      workspaceId: projectWorkspaceRecord.id,
      projectId: project.id,
      userId: 'user-owner',
      role: 'admin',
      canRead: true,
      canWrite: true,
      canManage: true,
    });
    assert.equal(projectOwnerMember.canManage, true);
    assert.deepEqual(
      listProjectWorkspaceMembers(sqlite, {
        workspaceId: projectWorkspaceRecord.id,
        organizationId,
        projectId: project.id,
      }).map((member) => member.userId),
      ['user-owner', 'user-collab'],
    );
    assert.throws(
      () => upsertProjectWorkspaceMember(sqlite, {
        actor: ownerActor,
        organizationId,
        workspaceId: projectWorkspaceRecord.id,
        projectId: project.id,
        userId: 'user-owner',
        role: 'member',
        canRead: true,
        canWrite: false,
        canManage: false,
      }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_LAST_MANAGER',
    );
    assert.equal(
      listProjectWorkspaceMembers(sqlite, {
        workspaceId: projectWorkspaceRecord.id,
        organizationId,
        projectId: project.id,
      }).find((member) => member.userId === 'user-owner')?.canManage,
      true,
    );
    assert.throws(
      () => removeProjectWorkspaceMember(sqlite, {
        organizationId,
        workspaceId: projectWorkspaceRecord.id,
        projectId: project.id,
        userId: 'user-owner',
      }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_LAST_MANAGER',
    );
    upsertProjectWorkspaceMember(sqlite, {
      actor: ownerActor,
      organizationId,
      workspaceId: projectWorkspaceRecord.id,
      projectId: project.id,
      userId: 'user-collab',
      role: 'admin',
      canRead: true,
      canWrite: true,
      canManage: true,
    });
    removeProjectWorkspaceMember(sqlite, {
      organizationId,
      workspaceId: projectWorkspaceRecord.id,
      projectId: project.id,
      userId: 'user-owner',
    });
    assert.deepEqual(
      listProjectWorkspaceMembers(sqlite, {
        workspaceId: projectWorkspaceRecord.id,
        organizationId,
        projectId: project.id,
      }).map((member) => member.userId),
      ['user-collab'],
    );

    const typeChangeProject = createCanvasProject(sqlite, {
      organizationId,
      name: 'Type Change Project',
      createdByUserId: 'user-owner',
    });
    const changedToProject = changeWorkspaceType(sqlite, {
      actor: ownerActor,
      workspaceId: changedBackToPersonal.workspaceId,
      type: 'project',
      projectId: typeChangeProject.id,
      teamFeaturesEnabled: true,
    });
    assert.equal(changedToProject.workspaceType, 'project');
    assert.equal(changedToProject.projectId, typeChangeProject.id);
    assert.equal(
      await fs.readFile(path.join(changedToProject.rootPath, 'type-change.md'), 'utf8'),
      '# Type change\n',
    );
    assert.equal(
      listProjectWorkspaceMembers(sqlite, {
        workspaceId: changedToProject.workspaceId,
        organizationId,
        projectId: typeChangeProject.id,
      }).some((member) => member.userId === 'user-owner' && member.canManage),
      true,
    );

    const automationWorkspace = createWorkspaceRecord(sqlite, {
      actor: ownerActor,
      organizationId,
      type: 'team',
      name: 'Ops Automations',
      teamFeaturesEnabled: true,
    });
    sqlite.prepare(`
      INSERT INTO automation_jobs (
        id, name, status, scope, job_scope, organization_id, workspace_id, workspace_type,
        prompt, preferred_skill, workspace_context_paths_json, schedule_kind, schedule_config_json,
        time_zone, created_by_user_id, agent_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'automation-active-workspace-delete',
      'Active workspace automation',
      'active',
      'organization',
      `organization:${organizationId}:${automationWorkspace.workspaceId}`,
      organizationId,
      automationWorkspace.workspaceId,
      automationWorkspace.workspaceType,
      'Run safely',
      'auto',
      '[]',
      'daily',
      '{"kind":"daily","times":["09:00"],"timeZone":"UTC"}',
      'UTC',
      'user-owner',
      'canvas-agent',
      now,
      now,
    );
    assert.throws(
      () => deleteWorkspaceRecord(sqlite, { actor: ownerActor, workspaceId: automationWorkspace.workspaceId }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_HAS_AUTOMATIONS',
    );
    sqlite.prepare('UPDATE automation_jobs SET status = ? WHERE id = ?').run('paused', 'automation-active-workspace-delete');
    deleteWorkspaceRecord(sqlite, { actor: ownerActor, workspaceId: automationWorkspace.workspaceId });
    assert.equal(getWorkspaceStatus(sqlite, automationWorkspace.workspaceId), 'disabled');

    deleteWorkspaceRecord(sqlite, { actor: ownerActor, workspaceId: extraPersonal.workspaceId });
    assert.equal(getWorkspaceStatus(sqlite, extraPersonal.workspaceId), 'disabled');
    deleteWorkspaceRecord(sqlite, { actor: ownerActor, workspaceId: teamWorkspace.workspaceId });
    assert.equal(getWorkspaceStatus(sqlite, teamWorkspace.workspaceId), 'disabled');

    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-member',
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
    assert.deepEqual(memberWorkspaces.map((workspace) => workspace.workspaceType), ['personal', 'organization']);
    assert.equal(memberWorkspaces[0].ownerUserId, 'user-member');
    assert.equal(memberWorkspaces[0].permissions.canManageWorkspace, true);
    assert.equal(memberWorkspaces[1].permissions.canRead, true);
    assert.equal(memberWorkspaces[1].permissions.canWrite, false);
    assert.equal(memberWorkspaces[1].permissions.canDelete, false);

    sqlite.prepare(`
      UPDATE organization_user_permissions
      SET can_write_team_workspace = 1, can_delete_team_files = 0, updated_at = ?
      WHERE organization_id = ? AND user_id = ?
    `).run(Date.now(), organizationId, 'user-member');
    const writeWithoutDeleteWorkspaces = listWorkspaceContextsForUser(sqlite, { actor: memberActor, organizationId });
    assert.equal(writeWithoutDeleteWorkspaces[1].permissions.canWrite, true);
    assert.equal(writeWithoutDeleteWorkspaces[1].permissions.canDelete, false);

    sqlite.prepare(`
      UPDATE organization_user_permissions
      SET can_write_team_workspace = 0, can_delete_team_files = 1, updated_at = ?
      WHERE organization_id = ? AND user_id = ?
    `).run(Date.now(), organizationId, 'user-member');
    const deleteWithoutWriteWorkspaces = listWorkspaceContextsForUser(sqlite, { actor: memberActor, organizationId });
    assert.equal(deleteWithoutWriteWorkspaces[1].permissions.canWrite, false);
    assert.equal(deleteWithoutWriteWorkspaces[1].permissions.canDelete, true);

    const ownerPersonalForMember = resolveWorkspaceContextById(sqlite, {
      actor: memberActor,
      workspaceId: ownerWorkspaces[0].workspaceId,
    });
    assert.equal(ownerPersonalForMember, null);

    const ensured = ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-member',
    });
    assert.equal(ensured.personal.id, memberWorkspaces[0].workspaceId);
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
    });
    assert.equal(disabledEnsure.personal.status, 'disabled');
    assert.equal(disabledEnsure.personal.displayName, 'Outdated Name');
    const memberWorkspacesAfterDisable = listWorkspaceContextsForUser(sqlite, { actor: memberActor, organizationId });
    assert.deepEqual(memberWorkspacesAfterDisable.map((workspace) => workspace.workspaceType), ['organization']);

    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-no-permission',
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
    assert.throws(
      () => createWorkspaceRecord(sqlite, {
        actor: memberActor,
        organizationId,
        type: 'organization',
        name: 'Member Organization Workspace',
        teamFeaturesEnabled: true,
      }),
      (error: unknown) => error instanceof WorkspaceOperationError && error.code === 'WORKSPACE_PERMISSION_DENIED',
    );

    deleteWorkspaceRecord(sqlite, {
      actor: ownerActor,
      workspaceId: organizationWorkspace.workspaceId,
    });
    assert.equal(getWorkspaceStatus(sqlite, organizationWorkspace.workspaceId), 'disabled');
    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-owner',
    });
    const activeOrganizationWorkspaceCount = sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM canvas_workspaces
      WHERE organization_id = ? AND type = 'organization' AND status = 'active'
    `).get(organizationId) as { count: number };
    assert.equal(activeOrganizationWorkspaceCount.count, 0);

    const replacementOrganizationWorkspace = createWorkspaceRecord(sqlite, {
      actor: ownerActor,
      organizationId,
      type: 'organization',
      name: 'Organization Hub',
      teamFeaturesEnabled: true,
    });
    assert.equal(replacementOrganizationWorkspace.workspaceType, 'organization');
    assert.notEqual(replacementOrganizationWorkspace.workspaceId, organizationWorkspace.workspaceId);
    assert.notEqual(replacementOrganizationWorkspace.rootRelativePath, organizationWorkspace.rootRelativePath);

    await fs.rm(path.join(ownerWorkspaces[0].rootPath, WORKSPACE_STARTER_DOCUMENT_NAME));
    ensureDefaultWorkspaceRecords(sqlite, { organizationId, userId: 'user-owner' });
    await assert.rejects(
      () => fs.access(path.join(ownerWorkspaces[0].rootPath, WORKSPACE_STARTER_DOCUMENT_NAME)),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'),
    );
    assert.throws(() => workspaceAbsoluteRoot('../outside'), /Invalid workspace root path/);
  } finally {
    sqlite.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('workspace-model-service-test: ok');
}

void main();
