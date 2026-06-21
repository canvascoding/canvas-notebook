import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import {
  ensureDefaultWorkspaceRecords,
  resolveWorkspaceContextById,
} from '../app/lib/workspaces/service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function insertUser(sqlite: Database.Database, id: string, name: string, email: string, role: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(id, name, email, role, now, now);
}

function insertPermission(sqlite: Database.Database, organizationId: string, userId: string, role: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, can_write_team_workspace, can_create_public_links,
      can_delete_team_files, can_delete_studio_assets, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 1, 0, 1, ?, ?)
  `).run(organizationId, userId, role, now, now);
}

function requireWorkspace(workspace: WorkspaceContext | null): WorkspaceContext {
  assert.ok(workspace, 'Expected workspace context');
  return workspace;
}

function tokenFromPublicUrl(publicUrl: string): string {
  const parts = publicUrl.split('/').filter(Boolean);
  const tokenIndex = parts.indexOf('files') + 1;
  assert.ok(tokenIndex > 0 && parts[tokenIndex], `Could not parse public URL: ${publicUrl}`);
  return decodeURIComponent(parts[tokenIndex]);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-public-share-workspace-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';

  await mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));

  try {
    runMigrations(sqlite);
    insertUser(sqlite, 'user-owner', 'Owner', 'owner@example.test', 'admin');
    insertUser(sqlite, 'user-member', 'Member', 'member@example.test', 'member');

    sqlite.exec('BEGIN IMMEDIATE');
    const ownerStatus = ensureOrganizationBootstrapForUser(sqlite, 'user-owner');
    sqlite.exec('COMMIT');
    assert.ok(ownerStatus.organizationId);
    const organizationId = ownerStatus.organizationId;

    insertPermission(sqlite, organizationId, 'user-member', 'member');
    const ownerRecords = ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-owner',
      teamFeaturesEnabled: true,
    });
    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-member',
      teamFeaturesEnabled: true,
    });

    const ownerActor = resolveWorkspaceActor({
      id: 'user-owner',
      email: 'owner@example.test',
      role: 'admin',
    });
    const memberActor = resolveWorkspaceActor({
      id: 'user-member',
      email: 'member@example.test',
      role: 'member',
    });

    const ownerPersonal = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: ownerActor,
      workspaceId: ownerRecords.personal.id,
    }));
    const ownerTeam = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: ownerActor,
      workspaceId: ownerRecords.team?.id ?? '',
    }));
    const memberTeam = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: memberActor,
      workspaceId: ownerTeam.workspaceId,
    }));

    assert.equal(ownerPersonal.permissions.canCreatePublicLinks, true);
    assert.equal(ownerTeam.permissions.canCreatePublicLinks, true);
    assert.equal(memberTeam.permissions.canCreatePublicLinks, true);

    await mkdir(path.join(ownerPersonal.rootPath, 'docs'), { recursive: true });
    await mkdir(path.join(ownerTeam.rootPath, 'docs'), { recursive: true });
    await writeFile(path.join(ownerPersonal.rootPath, 'docs', 'report.txt'), 'personal v1\n');
    await writeFile(path.join(ownerTeam.rootPath, 'docs', 'report.txt'), 'team v1\n');

    const {
      createPublicFileShares,
      listPublicFileShares,
      resolvePublicShareToken,
      revokePublicFileShare,
      syncPublicSharesAfterDelete,
      syncPublicSharesAfterMove,
      syncPublicSharesAfterWrite,
    } = await import('../app/lib/public-sharing/public-file-shares');

    const personalCreate = await createPublicFileShares({
      paths: ['docs/report.txt'],
      createdByUserId: 'user-owner',
      workspace: ownerPersonal,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    const teamCreate = await createPublicFileShares({
      paths: ['docs/report.txt'],
      createdByUserId: 'user-owner',
      workspace: ownerTeam,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });

    assert.equal(personalCreate.skipped.length, 0);
    assert.equal(teamCreate.skipped.length, 0);
    assert.equal(personalCreate.shares.length, 1);
    assert.equal(teamCreate.shares.length, 1);
    assert.equal(personalCreate.shares[0].workspaceId, ownerPersonal.workspaceId);
    assert.equal(teamCreate.shares[0].workspaceId, ownerTeam.workspaceId);
    assert.equal(personalCreate.shares[0].targetRevisionPolicy, 'latest');
    assert.equal(personalCreate.shares[0].passwordEnabled, false);

    const personalScopedList = await listPublicFileShares({
      userId: 'user-owner',
      workspace: ownerPersonal,
      status: 'active',
      paths: ['docs/report.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    const teamScopedList = await listPublicFileShares({
      userId: 'user-owner',
      workspace: ownerTeam,
      status: 'active',
      paths: ['docs/report.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.deepEqual(personalScopedList.map((share) => share.workspaceId), [ownerPersonal.workspaceId]);
    assert.deepEqual(teamScopedList.map((share) => share.workspaceId), [ownerTeam.workspaceId]);

    const personalToken = tokenFromPublicUrl(personalCreate.shares[0].publicUrl);
    await writeFile(path.join(ownerPersonal.rootPath, 'docs', 'report.txt'), 'personal v2\n');
    await syncPublicSharesAfterWrite(['docs/report.txt'], ownerPersonal);
    const resolvedAfterWrite = await resolvePublicShareToken(personalToken, { recordAccess: false });
    assert.equal(resolvedAfterWrite.ok, true);
    if (resolvedAfterWrite.ok) {
      assert.equal(await readFile(resolvedAfterWrite.fullPath, 'utf8'), 'personal v2\n');
      assert.equal(resolvedAfterWrite.share.status, 'active');
      assert.notEqual(resolvedAfterWrite.share.lastKnownRevision, personalCreate.shares[0].lastKnownRevision);
    }

    await rename(
      path.join(ownerTeam.rootPath, 'docs', 'report.txt'),
      path.join(ownerTeam.rootPath, 'docs', 'report-renamed.txt')
    );
    await syncPublicSharesAfterMove('docs/report.txt', 'docs/report-renamed.txt', ownerTeam);
    const teamAfterMove = await listPublicFileShares({
      userId: 'user-owner',
      workspace: ownerTeam,
      status: 'all',
      paths: ['docs/report.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(teamAfterMove.length, 1);
    assert.equal(teamAfterMove[0].status, 'revoked');

    await writeFile(path.join(ownerTeam.rootPath, 'docs', 'member-managed.txt'), 'team member managed\n');
    const teamManagedCreate = await createPublicFileShares({
      paths: ['docs/member-managed.txt'],
      createdByUserId: 'user-owner',
      workspace: ownerTeam,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(teamManagedCreate.shares.length, 1);
    const memberVisibleShares = await listPublicFileShares({
      userId: 'user-member',
      workspace: memberTeam,
      status: 'active',
      paths: ['docs/member-managed.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.deepEqual(memberVisibleShares.map((share) => share.id), [teamManagedCreate.shares[0].id]);
    const revokedByMember = await revokePublicFileShare({
      id: teamManagedCreate.shares[0].id,
      userId: 'user-member',
      workspace: memberTeam,
      isAdmin: false,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(revokedByMember?.status, 'revoked');

    await rm(path.join(ownerPersonal.rootPath, 'docs', 'report.txt'));
    await syncPublicSharesAfterDelete(['docs/report.txt'], ownerPersonal);
    const personalAfterDelete = await listPublicFileShares({
      userId: 'user-owner',
      workspace: ownerPersonal,
      status: 'all',
      paths: ['docs/report.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(personalAfterDelete.length, 1);
    assert.equal(personalAfterDelete[0].status, 'missing');
  } finally {
    sqlite.close();
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log('public-share-workspace-scope-test: ok');
}

void main();
