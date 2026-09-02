import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';
import { createCanvasProject, ensureCanvasProjectWorkspace, upsertCanvasProjectMember } from '../app/lib/projects/service';
import { resolveWorkspaceActor } from '../app/lib/workspaces/context';
import {
  createWorkspaceRecord,
  ensureDefaultWorkspaceRecords,
  resolveWorkspaceContextById,
} from '../app/lib/workspaces/service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type RouteRequestInit = Omit<RequestInit, 'headers' | 'signal'> & {
  headers?: HeadersInit;
};

function insertUser(sqlite: Database.Database, id: string, name: string, email: string, role: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(id, name, email, role, now, now);
}

function insertPermission(
  sqlite: Database.Database,
  organizationId: string,
  userId: string,
  role: string,
  canCreatePublicLinks = true,
) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, can_write_team_workspace, can_create_public_links,
      can_delete_team_files, can_delete_studio_assets, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, 0, 1, ?, ?)
  `).run(organizationId, userId, role, canCreatePublicLinks ? 1 : 0, now, now);
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

function routeRequest(url: string, init: RouteRequestInit = {}) {
  const headers = new Headers(init.headers);
  return new NextRequest(url, {
    ...init,
    headers,
  });
}

async function assertLegacyPublicShareMigration() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-public-share-legacy-migration-'));
  const dataRoot = path.join(tempRoot, 'data');

  await mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    sqlite.exec(`
      CREATE TABLE public_file_shares (
        id TEXT PRIMARY KEY NOT NULL,
        token TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        token_preview TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_identity TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_by_user_id TEXT NOT NULL,
        created_by_agent_id TEXT,
        source_session_id TEXT,
        source TEXT NOT NULL DEFAULT 'ui',
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0
      );
    `);

    process.env.DATA = dataRoot;
    runMigrations(sqlite);

    const columns = new Set(
      (sqlite.prepare('PRAGMA table_info(public_file_shares)').all() as Array<{ name: string }>)
        .map((column) => column.name)
    );
    assert.equal(columns.has('workspace_id'), true);
    assert.equal(columns.has('organization_id'), true);
    assert.equal(columns.has('target_revision_policy'), true);
    assert.equal(columns.has('revoked_reason'), true);

    const indexes = new Set(
      (sqlite.prepare('PRAGMA index_list(public_file_shares)').all() as Array<{ name: string }>)
        .map((index) => index.name)
    );
    assert.equal(indexes.has('idx_public_file_shares_workspace_id_path'), true);
    assert.equal(indexes.has('idx_public_file_shares_org_status'), true);
  } finally {
    sqlite.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-public-share-workspace-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.BETTER_AUTH_URL = 'http://localhost';

  await mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));

  try {
    runMigrations(sqlite);
    insertUser(sqlite, 'user-owner', 'Owner', 'owner@example.test', 'admin');
    insertUser(sqlite, 'user-member', 'Member', 'member@example.test', 'member');
    insertUser(sqlite, 'user-reader', 'Reader', 'reader@example.test', 'member');
    insertUser(sqlite, 'user-manager-no-link', 'Manager No Link', 'manager-no-link@example.test', 'member');

    sqlite.exec('BEGIN IMMEDIATE');
    const ownerStatus = ensureOrganizationBootstrapForUser(sqlite, 'user-owner');
    sqlite.exec('COMMIT');
    assert.ok(ownerStatus.organizationId);
    const organizationId = ownerStatus.organizationId;

    insertPermission(sqlite, organizationId, 'user-member', 'member');
    insertPermission(sqlite, organizationId, 'user-reader', 'member');
    insertPermission(sqlite, organizationId, 'user-manager-no-link', 'member', false);
    const ownerRecords = ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-owner',
    });
    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-member',
    });
    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-reader',
    });
    ensureDefaultWorkspaceRecords(sqlite, {
      organizationId,
      userId: 'user-manager-no-link',
    });
    const project = createCanvasProject(sqlite, {
      organizationId,
      name: 'Launch Project',
      createdByUserId: 'user-owner',
    });
    const projectWorkspaceRecord = ensureCanvasProjectWorkspace(sqlite, {
      organizationId,
      projectId: project.id,
    });
    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'user-owner',
      role: 'owner',
      canRead: true,
      canWrite: true,
      canManage: true,
    });
    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'user-member',
      role: 'member',
      canRead: true,
      canWrite: true,
      canManage: true,
      invitedByUserId: 'user-owner',
    });
    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'user-reader',
      role: 'member',
      canRead: true,
      canWrite: false,
      canManage: false,
      invitedByUserId: 'user-owner',
    });
    upsertCanvasProjectMember(sqlite, {
      organizationId,
      projectId: project.id,
      userId: 'user-manager-no-link',
      role: 'admin',
      canRead: true,
      canWrite: true,
      canManage: true,
      invitedByUserId: 'user-owner',
    });

    const ownerActor = resolveWorkspaceActor({
      id: 'user-owner',
      email: 'owner@example.test',
      role: 'admin',
    });
    const organizationWorkspace = createWorkspaceRecord(sqlite, {
      actor: ownerActor,
      organizationId,
      type: 'organization',
      name: 'Public Sharing Organization',
      teamFeaturesEnabled: true,
    });
    const memberActor = resolveWorkspaceActor({
      id: 'user-member',
      email: 'member@example.test',
      role: 'member',
    });
    const readerActor = resolveWorkspaceActor({
      id: 'user-reader',
      email: 'reader@example.test',
      role: 'member',
    });
    const managerNoLinkActor = resolveWorkspaceActor({
      id: 'user-manager-no-link',
      email: 'manager-no-link@example.test',
      role: 'member',
    });

    const ownerPersonal = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: ownerActor,
      workspaceId: ownerRecords.personal.id,
    }));
    const ownerTeam = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: ownerActor,
      workspaceId: organizationWorkspace.workspaceId,
    }));
    const memberTeam = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: memberActor,
      workspaceId: ownerTeam.workspaceId,
    }));
    const ownerProject = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: ownerActor,
      workspaceId: projectWorkspaceRecord.id,
    }));
    const memberProject = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: memberActor,
      workspaceId: ownerProject.workspaceId,
    }));
    const readerProject = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: readerActor,
      workspaceId: ownerProject.workspaceId,
    }));
    const managerNoLinkProject = requireWorkspace(resolveWorkspaceContextById(sqlite, {
      actor: managerNoLinkActor,
      workspaceId: ownerProject.workspaceId,
    }));

    assert.equal(ownerPersonal.permissions.canCreatePublicLinks, true);
    assert.equal(ownerTeam.permissions.canCreatePublicLinks, true);
    assert.equal(memberTeam.permissions.canCreatePublicLinks, true);
    assert.equal(ownerProject.permissions.canCreatePublicLinks, true);
    assert.equal(memberProject.permissions.canCreatePublicLinks, true);
    assert.equal(memberProject.permissions.canManageWorkspace, true);
    assert.equal(readerProject.permissions.canCreatePublicLinks, true);
    assert.equal(readerProject.permissions.canManageWorkspace, false);
    assert.equal(managerNoLinkProject.permissions.canCreatePublicLinks, false);
    assert.equal(managerNoLinkProject.permissions.canManageWorkspace, true);

    await mkdir(path.join(ownerPersonal.rootPath, 'docs'), { recursive: true });
    await mkdir(path.join(ownerTeam.rootPath, 'docs'), { recursive: true });
    await mkdir(path.join(ownerProject.rootPath, 'docs'), { recursive: true });
    await writeFile(path.join(ownerPersonal.rootPath, 'docs', 'report.txt'), 'personal v1\n');
    await writeFile(path.join(ownerTeam.rootPath, 'docs', 'report.txt'), 'team v1\n');
    await writeFile(path.join(ownerProject.rootPath, 'docs', 'report.txt'), 'project v1\n');

    const {
      createPublicFileShares,
      listPublicFileShares,
      resolvePublicShareToken,
      revokePublicFileShare,
      syncPublicSharesAfterDelete,
      syncPublicSharesAfterMove,
      syncPublicSharesAfterWrite,
    } = await import('../app/lib/public-sharing/public-file-shares');
    const {
      getPublicMarkdownExport,
      getPublicMarpPreview,
    } = await import('../app/lib/public-sharing/public-markdown-export');
    const {
      rewritePublicMarkdownImageSources,
    } = await import('../app/lib/public-sharing/public-markdown-images');
    const publicMarkdownAssetsRoute = await import('../app/public/markdown-assets/[token]/[...assetPath]/route');
    const publicMarpPreviewRoute = await import('../app/public/marp-preview/[token]/route');

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
    const projectCreate = await createPublicFileShares({
      paths: ['docs/report.txt'],
      createdByUserId: 'user-owner',
      workspace: ownerProject,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });

    assert.equal(personalCreate.skipped.length, 0);
    assert.equal(teamCreate.skipped.length, 0);
    assert.equal(projectCreate.skipped.length, 0);
    assert.equal(personalCreate.shares.length, 1);
    assert.equal(teamCreate.shares.length, 1);
    assert.equal(projectCreate.shares.length, 1);
    assert.equal(personalCreate.shares[0].workspaceId, ownerPersonal.workspaceId);
    assert.equal(teamCreate.shares[0].workspaceId, ownerTeam.workspaceId);
    assert.equal(projectCreate.shares[0].workspaceId, ownerProject.workspaceId);
    assert.equal(personalCreate.shares[0].workspaceName, ownerPersonal.displayName);
    assert.equal(teamCreate.shares[0].workspaceName, ownerTeam.displayName);
    assert.equal(projectCreate.shares[0].workspaceName, ownerProject.displayName);
    assert.equal(personalCreate.shares[0].targetRevisionPolicy, 'latest');
    assert.equal(personalCreate.shares[0].passwordEnabled, false);

    const projectToken = tokenFromPublicUrl(projectCreate.shares[0].publicUrl);
    const resolvedProjectShare = await resolvePublicShareToken(projectToken, { recordAccess: false });
    assert.equal(resolvedProjectShare.ok, true);
    if (resolvedProjectShare.ok) {
      assert.equal(resolvedProjectShare.workspace.workspaceType, 'project');
      assert.equal(resolvedProjectShare.workspace.displayName, 'Project Workspace');
      assert.equal(resolvedProjectShare.share.workspaceName, 'Project Workspace');
    }

    await writeFile(path.join(ownerPersonal.rootPath, 'docs', 'shared.md'), '# Personal markdown\n\npersonal scoped content\n');
    await writeFile(path.join(ownerTeam.rootPath, 'docs', 'shared.md'), '# Team markdown\n\nteam scoped content\n');
    const personalMarkdownCreate = await createPublicFileShares({
      paths: ['docs/shared.md'],
      createdByUserId: 'user-owner',
      workspace: ownerPersonal,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    const teamMarkdownCreate = await createPublicFileShares({
      paths: ['docs/shared.md'],
      createdByUserId: 'user-owner',
      workspace: ownerTeam,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(personalMarkdownCreate.shares.length, 1);
    assert.equal(teamMarkdownCreate.shares.length, 1);

    const personalMarkdownExport = await getPublicMarkdownExport(tokenFromPublicUrl(personalMarkdownCreate.shares[0].publicUrl));
    const teamMarkdownExport = await getPublicMarkdownExport(tokenFromPublicUrl(teamMarkdownCreate.shares[0].publicUrl));
    assert.equal(personalMarkdownExport.ok, true);
    assert.equal(teamMarkdownExport.ok, true);
    if (personalMarkdownExport.ok && teamMarkdownExport.ok) {
      assert.match(personalMarkdownExport.html, /Personal markdown/);
      assert.match(personalMarkdownExport.html, /personal scoped content/);
      assert.doesNotMatch(personalMarkdownExport.html, /team scoped content/);
      assert.match(teamMarkdownExport.html, /Team markdown/);
      assert.match(teamMarkdownExport.html, /team scoped content/);
      assert.doesNotMatch(teamMarkdownExport.html, /personal scoped content/);
    }

    await mkdir(path.join(ownerPersonal.rootPath, 'docs', 'images'), { recursive: true });
    const publishedImage = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    await writeFile(path.join(ownerPersonal.rootPath, 'docs', 'images', 'published.png'), publishedImage);
    await writeFile(path.join(ownerPersonal.rootPath, 'docs', 'images', 'unshared.png'), Buffer.from('private image'));
    await writeFile(
      path.join(ownerPersonal.rootPath, 'docs', 'with-images.md'),
      '# Public images\n\n![Inline image](images/published.png)\n\n![Reference image][published]\n\n[published]: <images/published.png>\n\n<img src="images/published.png" alt="HTML image">\n',
    );
    const markdownImageShare = await createPublicFileShares({
      paths: ['docs/with-images.md'],
      createdByUserId: 'user-owner',
      workspace: ownerPersonal,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(markdownImageShare.shares.length, 1);
    const markdownImageToken = tokenFromPublicUrl(markdownImageShare.shares[0].publicUrl);
    const rewrittenMarkdown = rewritePublicMarkdownImageSources(
      await readFile(path.join(ownerPersonal.rootPath, 'docs', 'with-images.md'), 'utf8'),
      'docs/with-images.md',
      markdownImageToken,
    );
    assert.match(
      rewrittenMarkdown,
      new RegExp(`/public/markdown-assets/${markdownImageToken}/docs/images/published\\.png`),
    );

    const publishedImageResponse = await publicMarkdownAssetsRoute.GET(
      routeRequest(`http://localhost/public/markdown-assets/${markdownImageToken}/docs/images/published.png`),
      { params: Promise.resolve({ token: markdownImageToken, assetPath: ['docs', 'images', 'published.png'] }) },
    );
    assert.equal(publishedImageResponse.status, 200);
    assert.deepEqual(Buffer.from(await publishedImageResponse.arrayBuffer()), publishedImage);
    assert.equal(publishedImageResponse.headers.get('content-type'), 'image/png');

    const unsharedImageResponse = await publicMarkdownAssetsRoute.GET(
      routeRequest(`http://localhost/public/markdown-assets/${markdownImageToken}/docs/images/unshared.png`),
      { params: Promise.resolve({ token: markdownImageToken, assetPath: ['docs', 'images', 'unshared.png'] }) },
    );
    assert.equal(unsharedImageResponse.status, 404);

    await writeFile(
      path.join(ownerPersonal.rootPath, 'docs', 'public-slides.marp.md'),
      '---\nmarp: true\n---\n\n# Public slides\n\n![Logo](images/published.png)\n',
    );
    const publicMarpShare = await createPublicFileShares({
      paths: ['docs/public-slides.marp.md'],
      createdByUserId: 'user-owner',
      workspace: ownerPersonal,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(publicMarpShare.shares.length, 1);
    const publicMarpToken = tokenFromPublicUrl(publicMarpShare.shares[0].publicUrl);
    const publicMarpPreview = await getPublicMarpPreview(publicMarpToken);
    assert.equal(publicMarpPreview.ok, true);
    if (publicMarpPreview.ok) {
      assert.match(publicMarpPreview.html, /Public slides/);
      assert.match(publicMarpPreview.html, /data:image\/png;base64,/);
    }
    const publicMarpRouteResponse = await publicMarpPreviewRoute.GET(
      routeRequest(`http://localhost/public/marp-preview/${publicMarpToken}`),
      { params: Promise.resolve({ token: publicMarpToken }) },
    );
    assert.equal(publicMarpRouteResponse.status, 200);
    assert.match(await publicMarpRouteResponse.text(), /Public slides/);

    await writeFile(path.join(ownerTeam.rootPath, 'docs', 'agent-root.txt'), 'team agent root\n');
    const ownerTeamWithoutRelativePath: WorkspaceContext = {
      ...ownerTeam,
      rootRelativePath: undefined,
    };
    const teamAgentCreate = await createPublicFileShares({
      paths: ['docs/agent-root.txt'],
      createdByUserId: 'user-owner',
      workspace: ownerTeamWithoutRelativePath,
      source: 'agent',
      createdByAgentId: 'canvas-agent',
      sourceSessionId: 'session-agent-root',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(teamAgentCreate.skipped.length, 0);
    assert.equal(teamAgentCreate.shares.length, 1);
    assert.equal(teamAgentCreate.shares[0].workspaceId, ownerTeam.workspaceId);

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
    const teamAgentScopedList = await listPublicFileShares({
      userId: 'user-owner',
      workspace: ownerTeam,
      status: 'active',
      paths: ['docs/agent-root.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.deepEqual(personalScopedList.map((share) => share.workspaceId), [ownerPersonal.workspaceId]);
    assert.deepEqual(teamScopedList.map((share) => share.workspaceId), [ownerTeam.workspaceId]);
    assert.deepEqual(teamScopedList.map((share) => share.workspaceName), [ownerTeam.displayName]);
    assert.deepEqual(teamAgentScopedList.map((share) => share.status), ['active']);
    const ownerProjectWithWrongDisplayName: WorkspaceContext = {
      ...ownerProject,
      displayName: 'Personal Workspace',
    };
    const projectScopedList = await listPublicFileShares({
      userId: 'user-owner',
      workspace: ownerProjectWithWrongDisplayName,
      status: 'active',
      paths: ['docs/report.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.deepEqual(projectScopedList.map((share) => share.workspaceName), [ownerProject.displayName]);

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

    await writeFile(path.join(ownerTeam.rootPath, 'docs', 'overwrite-source.txt'), 'source\n');
    await writeFile(path.join(ownerTeam.rootPath, 'docs', 'overwrite-target.txt'), 'target\n');
    const overwriteShares = await createPublicFileShares({
      paths: ['docs/overwrite-source.txt', 'docs/overwrite-target.txt'],
      createdByUserId: 'user-owner',
      workspace: ownerTeam,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(overwriteShares.shares.length, 2);
    await syncPublicSharesAfterMove(
      'docs/overwrite-source.txt',
      'docs/overwrite-target.txt',
      ownerTeam,
      { revokeDestination: true },
    );
    const sharesAfterOverwrite = await listPublicFileShares({
      userId: 'user-owner',
      workspace: ownerTeam,
      status: 'all',
      paths: ['docs/overwrite-source.txt', 'docs/overwrite-target.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(sharesAfterOverwrite.length, 2);
    assert.deepEqual(sharesAfterOverwrite.map((share) => share.status), ['revoked', 'revoked']);

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

    await writeFile(path.join(ownerProject.rootPath, 'docs', 'route-managed.txt'), 'project route managed\n');
    const routeManagedCreate = await createPublicFileShares({
      paths: ['docs/route-managed.txt'],
      createdByUserId: 'user-owner',
      workspace: ownerProject,
      source: 'ui',
      confirmPublicExposure: true,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(routeManagedCreate.shares.length, 1);
    const { auth } = await import('../app/lib/auth');
    const didPatchSession = Reflect.set(auth.api, 'getSession', async () => ({
      user: {
        id: 'user-manager-no-link',
        email: 'manager-no-link@example.test',
        name: 'Manager No Link',
        role: 'member',
      },
      session: {
        id: 'public-share-route-revoke-test',
      },
    }));
    assert.equal(didPatchSession, true);
    const revokeRoute = await import('../app/api/security/public-shares/[id]/route');
    const routeRevokeResponse = await revokeRoute.DELETE(
      routeRequest(`http://localhost/api/security/public-shares/${routeManagedCreate.shares[0].id}?workspaceId=${managerNoLinkProject.workspaceId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: routeManagedCreate.shares[0].id }) },
    );
    assert.equal(routeRevokeResponse.status, 200);
    const routeRevokeBody = await routeRevokeResponse.json() as { success?: boolean; share?: { status?: string } };
    assert.equal(routeRevokeBody.success, true);
    assert.equal(routeRevokeBody.share?.status, 'revoked');

    const readerProjectVisibleShares = await listPublicFileShares({
      userId: 'user-reader',
      workspace: readerProject,
      status: 'active',
      paths: ['docs/report.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.deepEqual(readerProjectVisibleShares.map((share) => share.id), []);
    await assert.rejects(
      () => revokePublicFileShare({
        id: projectCreate.shares[0].id,
        userId: 'user-reader',
        workspace: readerProject,
        isAdmin: false,
        baseUrl: 'https://notebook.example.test',
      }),
      /Forbidden/,
    );

    const memberProjectVisibleShares = await listPublicFileShares({
      userId: 'user-member',
      workspace: memberProject,
      status: 'active',
      paths: ['docs/report.txt'],
      baseUrl: 'https://notebook.example.test',
    });
    assert.deepEqual(memberProjectVisibleShares.map((share) => share.id), [projectCreate.shares[0].id]);
    const projectRevokedByMember = await revokePublicFileShare({
      id: projectCreate.shares[0].id,
      userId: 'user-member',
      workspace: memberProject,
      isAdmin: false,
      baseUrl: 'https://notebook.example.test',
    });
    assert.equal(projectRevokedByMember?.status, 'revoked');

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
    assert.equal(personalAfterDelete[0].status, 'revoked');
  } finally {
    sqlite.close();
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log('public-share-workspace-scope-test: ok');
}

async function run() {
  await assertLegacyPublicShareMigration();
  await main();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
