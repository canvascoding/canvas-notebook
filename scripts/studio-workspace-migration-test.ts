import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-studio-workspace-migration-'));
  const dataRoot = path.join(tempRoot, 'data');
  const previousData = process.env.DATA;
  process.env.DATA = dataRoot;
  await fs.mkdir(dataRoot, { recursive: true });

  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ('owner', 'Owner', 'owner@example.test', 1, 'admin', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES ('org-1', 'owner', 'managed-team', 1, ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name,
        status, is_default, created_at, updated_at
      ) VALUES
        ('personal-1', 'org-1', 'personal', 'owner', 'workspaces/personal/owner/files', 'Personal', 'active', 1, ?, ?),
        ('organization-1', 'org-1', 'organization', NULL, 'workspaces/organization/org-1/files', 'Team', 'active', 1, ?, ?)
    `).run(now, now, now, now);
    sqlite.prepare(`
      INSERT INTO studio_products (
        id, user_id, organization_id, created_by_user_id, visibility, name, created_at, updated_at
      ) VALUES ('product-1', 'owner', 'org-1', 'owner', 'organization', 'Shared product', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO studio_presets (
        id, user_id, created_by_user_id, visibility, is_default, name, blocks, created_at, updated_at
      ) VALUES ('preset-1', 'owner', 'owner', 'user', 0, 'Personal preset', '[]', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO studio_presets (
        id, user_id, visibility, is_default, name, blocks, created_at, updated_at
      ) VALUES ('preset-default', NULL, 'system', 1, 'Default', '[]', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO studio_generations (
        id, user_id, organization_id, created_by_user_id, mode, prompt, raw_prompt,
        aspect_ratio, provider, model, status, created_at, updated_at
      ) VALUES ('generation-1', 'owner', 'org-1', 'owner', 'image', 'Prompt', 'Prompt',
        '1:1', 'gemini', 'test-model', 'completed', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO studio_generation_outputs (
        id, generation_id, variation_index, type, file_path, is_favorite, created_at
      ) VALUES ('output-1', 'generation-1', 0, 'image', 'legacy.png', 0, ?)
    `).run(now);

    runMigrations(sqlite);

    const product = sqlite.prepare('SELECT workspace_id, visibility FROM studio_products WHERE id = ?')
      .get('product-1') as { workspace_id: string | null; visibility: string };
    assert.deepEqual(product, { workspace_id: 'organization-1', visibility: 'workspace' });

    const preset = sqlite.prepare('SELECT workspace_id, visibility FROM studio_presets WHERE id = ?')
      .get('preset-1') as { workspace_id: string | null; visibility: string };
    assert.deepEqual(preset, { workspace_id: 'personal-1', visibility: 'workspace' });
    assert.equal(
      (sqlite.prepare('SELECT workspace_id FROM studio_presets WHERE id = ?').get('preset-default') as { workspace_id: string | null }).workspace_id,
      null,
    );

    assert.equal(
      (sqlite.prepare('SELECT workspace_id FROM studio_generations WHERE id = ?').get('generation-1') as { workspace_id: string }).workspace_id,
      'organization-1',
    );
    assert.equal(
      (sqlite.prepare('SELECT workspace_id FROM studio_generation_outputs WHERE id = ?').get('output-1') as { workspace_id: string }).workspace_id,
      'organization-1',
    );

    const storage = await import('../app/lib/integrations/studio-workspace');
    const scope = { organizationId: 'org-1', workspaceId: 'organization-1' };
    const productPath = storage.generateProductImagePath('product-new', 0, 'png', scope);
    assert.match(productPath, /^studio\/organizations\/org-1\/workspaces\/organization-1\/assets\/products\/product-new\//u);
    await storage.writeAssetFile(productPath, Buffer.from('workspace-scoped-asset'));
    assert.equal((await storage.readAssetFile(productPath)).toString('utf8'), 'workspace-scoped-asset');
    assert.equal(await fs.stat(path.join(dataRoot, 'workspace')).then(() => true).catch(() => false), false);
  } finally {
    sqlite.close();
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('studio workspace migration tests passed');
}

void main();
