import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import Database from 'better-sqlite3';

async function importBrandService() {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/workspaces/brand-profile-service');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-brand-profile-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const { runMigrations } = await import('../app/lib/db/migrate');
    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    runMigrations(sqlite);
    const now = Date.now();

    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ('brand-user', 'Brand User', 'brand@example.com', 1, 'admin', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES ('brand-org', 'brand-user', 'single_user', 0, ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name,
        workspace_icon, status, is_default, created_at, updated_at
      ) VALUES ('brand-workspace', 'brand-org', 'personal', 'brand-user',
        'workspaces/personal/brand-user/files', 'Brand Workspace', 'palette', 'active', 1, ?, ?)
    `).run(now, now);

    const {
      DEFAULT_WORKSPACE_BRAND_PROFILE,
      WorkspaceBrandProfileValidationError,
      normalizeWorkspaceBrandProfile,
      validateWorkspaceBrandProfile,
    } = await import('../app/lib/workspaces/brand-profile');
    const {
      readWorkspaceBrandProfile,
      resetWorkspaceBrandProfile,
      updateWorkspaceBrandProfile,
      workspaceBrandProfileCacheKey,
    } = await importBrandService();

    const defaults = await readWorkspaceBrandProfile('brand-workspace');
    assert.equal(defaults.configured, false);
    assert.deepEqual(defaults.profile, DEFAULT_WORKSPACE_BRAND_PROFILE);
    assert.equal(workspaceBrandProfileCacheKey(defaults), 'brand:default');

    const normalized = normalizeWorkspaceBrandProfile({
      enabled: true,
      brandName: 'Canvas Studios',
      page: { backgroundColor: '#FAF8F1', verticalMarginMm: 200, horizontalMarginMm: 4 },
      colors: { accent: '#B24A2B' },
    });
    assert.equal(normalized.page.backgroundColor, '#faf8f1');
    assert.equal(normalized.page.verticalMarginMm, 35);
    assert.equal(normalized.page.horizontalMarginMm, 10);
    assert.equal(normalized.colors.accent, '#b24a2b');
    assert.equal(normalized.colors.text, DEFAULT_WORKSPACE_BRAND_PROFILE.colors.text);

    assert.throws(
      () => validateWorkspaceBrandProfile({ colors: { accent: 'red; background: black' } }),
      WorkspaceBrandProfileValidationError,
    );
    assert.throws(
      () => validateWorkspaceBrandProfile({ logoPath: '../outside.png' }),
      WorkspaceBrandProfileValidationError,
    );

    const first = await updateWorkspaceBrandProfile({
      workspaceId: 'brand-workspace',
      userId: 'brand-user',
      profile: normalized,
    });
    assert.equal(first.configured, true);
    assert.equal(first.revision, 1);
    assert.equal(first.profile.brandName, 'Canvas Studios');
    assert.match(workspaceBrandProfileCacheKey(first), /^brand:1:/u);

    const second = await updateWorkspaceBrandProfile({
      workspaceId: 'brand-workspace',
      userId: 'brand-user',
      profile: { ...normalized, brandName: 'Canvas Studios GmbH' },
    });
    assert.equal(second.revision, 2);
    assert.equal(second.profile.brandName, 'Canvas Studios GmbH');

    const reset = await resetWorkspaceBrandProfile('brand-workspace');
    assert.equal(reset.configured, false);
    assert.equal(reset.revision, 0);

    sqlite.prepare('DELETE FROM canvas_workspaces WHERE id = ?').run('brand-workspace');
    const orphan = sqlite.prepare('SELECT workspace_id FROM workspace_brand_profiles WHERE workspace_id = ?').get('brand-workspace');
    assert.equal(orphan, undefined);

    sqlite.close();
    console.log('workspace-brand-profile-test: ok');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
