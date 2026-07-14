import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import sharp from 'sharp';

import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function importBrandLogoService() {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/workspaces/brand-logo-service');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-brand-logo-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const { runMigrations } = await import('../app/lib/db/migrate');
    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    runMigrations(sqlite);
    const now = Date.now();
    const workspaceRoot = path.join(dataRoot, 'workspaces', 'personal', 'brand-logo-user', 'files');

    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ('brand-logo-user', 'Brand Logo User', 'brand-logo@example.com', 1, 'admin', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES ('brand-logo-org', 'brand-logo-user', 'single_user', 0, ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name,
        workspace_icon, status, is_default, created_at, updated_at
      ) VALUES ('brand-logo-workspace', 'brand-logo-org', 'personal', 'brand-logo-user',
        'workspaces/personal/brand-logo-user/files', 'Brand Logo Workspace', 'palette', 'active', 1, ?, ?)
    `).run(now, now);

    const workspace: WorkspaceContext = {
      workspaceId: 'brand-logo-workspace',
      workspaceType: 'personal',
      rootPath: workspaceRoot,
      organizationId: 'brand-logo-org',
      ownerUserId: 'brand-logo-user',
      permissions: {
        canRead: true,
        canWrite: true,
        canDelete: true,
        canCreatePublicLinks: true,
        canManageWorkspace: true,
        canRunAgent: true,
      },
      legacy: false,
    };

    const {
      ORGANIZATION_BRAND_LOGO_PATH,
      WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES,
      WORKSPACE_BRAND_LOGO_PATH,
      WorkspaceBrandLogoError,
      readOrganizationBrandLogo,
      readWorkspaceBrandLogo,
      removeOrganizationBrandLogo,
      removeWorkspaceBrandLogo,
      saveOrganizationBrandLogo,
      saveWorkspaceBrandLogo,
    } = await importBrandLogoService();
    const {
      resetWorkspaceBrandProfile,
      resolveWorkspaceBrandProfile,
    } = await import('../app/lib/workspaces/brand-profile-service');

    const source = await sharp({
      create: {
        width: 1_600,
        height: 640,
        channels: 4,
        background: { r: 15, g: 108, b: 189, alpha: 0.78 },
      },
    }).png().toBuffer();

    const savedOrganization = await saveOrganizationBrandLogo({
      buffer: source,
      organizationId: workspace.organizationId!,
      userId: 'brand-logo-user',
    });
    assert.equal(savedOrganization.profile.logoPath, ORGANIZATION_BRAND_LOGO_PATH);
    assert.equal(savedOrganization.revision, 1);
    const organizationStoredPath = path.join(
      dataRoot,
      'organizations',
      workspace.organizationId!,
      'settings',
      'brand',
      'logo.webp',
    );
    const organizationStored = await readFile(organizationStoredPath);
    assert.deepEqual((await readOrganizationBrandLogo(workspace.organizationId!))?.buffer, organizationStored);

    const inherited = await resolveWorkspaceBrandProfile(workspace.workspaceId);
    assert.equal(inherited.source, 'organization');
    assert.equal(inherited.profile.logoPath, ORGANIZATION_BRAND_LOGO_PATH);
    assert.deepEqual(
      (await readWorkspaceBrandLogo(inherited.profile, { workspace }))?.buffer,
      organizationStored,
    );

    const saved = await saveWorkspaceBrandLogo({
      buffer: source,
      workspaceId: workspace.workspaceId,
      userId: 'brand-logo-user',
      fileOptions: { workspace },
    });
    assert.equal(saved.profile.logoPath, WORKSPACE_BRAND_LOGO_PATH);
    assert.equal(saved.revision, 1);
    assert.equal(saved.profile.brandName, inherited.profile.brandName);
    assert.equal(saved.asset.mimeType, 'image/webp');
    assert.equal(saved.asset.width, 1_200);
    assert.equal(saved.asset.height, 480);
    assert.ok(saved.asset.size < source.length);

    const storedPath = path.join(workspaceRoot, WORKSPACE_BRAND_LOGO_PATH);
    const stored = await readFile(storedPath);
    const storedMetadata = await sharp(stored).metadata();
    assert.equal(storedMetadata.format, 'webp');
    assert.equal(storedMetadata.hasAlpha, true);

    const readable = await readWorkspaceBrandLogo(saved.profile, { workspace });
    assert.equal(readable?.mimeType, 'image/webp');
    assert.deepEqual(readable?.buffer, stored);

    await assert.rejects(
      () => saveWorkspaceBrandLogo({
        buffer: Buffer.alloc(WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES + 1),
        workspaceId: workspace.workspaceId,
        userId: 'brand-logo-user',
        fileOptions: { workspace },
      }),
      (error: unknown) => error instanceof WorkspaceBrandLogoError && error.status === 413,
    );
    await assert.rejects(
      () => saveWorkspaceBrandLogo({
        buffer: Buffer.from('not-an-image'),
        workspaceId: workspace.workspaceId,
        userId: 'brand-logo-user',
        fileOptions: { workspace },
      }),
      WorkspaceBrandLogoError,
    );

    const removed = await removeWorkspaceBrandLogo({
      workspaceId: workspace.workspaceId,
      userId: 'brand-logo-user',
      fileOptions: { workspace },
    });
    assert.equal(removed.profile.logoPath, '');
    assert.equal(removed.revision, 2);
    await assert.rejects(() => readFile(storedPath), (error: unknown) => (
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
    ));

    await resetWorkspaceBrandProfile(workspace.workspaceId);
    await assert.rejects(
      () => removeWorkspaceBrandLogo({
        workspaceId: workspace.workspaceId,
        userId: 'brand-logo-user',
        fileOptions: { workspace },
      }),
      (error: unknown) => error instanceof WorkspaceBrandLogoError && error.status === 409,
    );
    assert.deepEqual(await readFile(organizationStoredPath), organizationStored);

    const removedOrganization = await removeOrganizationBrandLogo({
      organizationId: workspace.organizationId!,
      userId: 'brand-logo-user',
    });
    assert.equal(removedOrganization.profile.logoPath, '');
    assert.equal(removedOrganization.revision, 2);
    assert.equal(await readOrganizationBrandLogo(workspace.organizationId!), null);

    sqlite.close();
    console.log('workspace-brand-logo-test: ok');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
