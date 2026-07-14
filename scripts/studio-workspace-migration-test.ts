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
  const previousProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
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
        id, user_id, organization_id, created_by_user_id, visibility, name, thumbnail_path, created_at, updated_at
      ) VALUES ('product-1', 'owner', 'org-1', 'owner', 'organization', 'Shared product', 'products/product-1/legacy.png', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO studio_products (
        id, user_id, organization_id, created_by_user_id, visibility, name, created_at, updated_at
      ) VALUES ('product-personal', 'owner', 'org-1', 'owner', 'user', 'Personal product', ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO studio_product_images (
        id, product_id, file_path, file_name, mime_type, file_size, source_type, sort_order, created_at
      ) VALUES ('product-image-1', 'product-1', 'products/product-1/legacy.png', 'legacy.png', 'image/png', 12, 'upload', 0, ?)
    `).run(now);
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
        aspect_ratio, provider, model, metadata, status, created_at, updated_at
      ) VALUES ('generation-1', 'owner', 'org-1', 'owner', 'image', 'Prompt', 'Prompt',
        '1:1', 'gemini', 'test-model', ?, 'completed', ?, ?)
    `).run(JSON.stringify({
      extraReferenceUrls: [
        '/api/studio/media/studio/assets/references/legacy-reference.png?workspaceId=organization-1',
        'user-uploads/studio-references/legacy-upload.png',
      ],
      startFramePath: 'studio/edits/legacy-edit.png',
    }), now, now);
    sqlite.prepare(`
      INSERT INTO studio_generation_outputs (
        id, generation_id, variation_index, type, file_path, is_favorite, created_at
      ) VALUES ('output-1', 'generation-1', 0, 'image', 'legacy.png', 0, ?)
    `).run(now);

    await fs.mkdir(path.join(dataRoot, 'studio/assets/products/product-1'), { recursive: true });
    await fs.writeFile(path.join(dataRoot, 'studio/assets/products/product-1/legacy.png'), 'legacy asset');
    await fs.mkdir(path.join(dataRoot, 'studio/outputs'), { recursive: true });
    await fs.writeFile(path.join(dataRoot, 'studio/outputs/legacy.png'), 'legacy output');
    await fs.mkdir(path.join(dataRoot, 'studio/assets/references'), { recursive: true });
    await fs.writeFile(path.join(dataRoot, 'studio/assets/references/legacy-reference.png'), 'legacy reference');
    await fs.mkdir(path.join(dataRoot, 'studio/edits'), { recursive: true });
    await fs.writeFile(path.join(dataRoot, 'studio/edits/legacy-edit.png'), 'legacy edit');
    await fs.mkdir(path.join(dataRoot, 'user-uploads/studio-references'), { recursive: true });
    await fs.writeFile(path.join(dataRoot, 'user-uploads/studio-references/legacy-upload.png'), 'legacy upload');
    await fs.mkdir(path.join(dataRoot, 'workspace'), { recursive: true });
    await fs.writeFile(path.join(dataRoot, 'workspace/notes.md'), '# stays here');

    runMigrations(sqlite);

    const product = sqlite.prepare('SELECT workspace_id, visibility FROM studio_products WHERE id = ?')
      .get('product-1') as { workspace_id: string | null; visibility: string };
    assert.deepEqual(product, { workspace_id: 'organization-1', visibility: 'workspace' });
    const personalProduct = sqlite.prepare('SELECT workspace_id, visibility FROM studio_products WHERE id = ?')
      .get('product-personal') as { workspace_id: string | null; visibility: string };
    assert.deepEqual(personalProduct, { workspace_id: 'personal-1', visibility: 'workspace' });

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

    const { createPersistedStudioScope } = await import('../app/lib/integrations/studio-scope');
    const { ensureStudioWorkspaceFilesMigrated } = await import('../app/lib/integrations/studio-workspace-file-migration');
    await ensureStudioWorkspaceFilesMigrated(createPersistedStudioScope({
      actorUserId: 'owner',
      organizationId: 'org-1',
      workspaceId: 'organization-1',
    }));

    const migratedImage = sqlite.prepare('SELECT file_path FROM studio_product_images WHERE id = ?')
      .get('product-image-1') as { file_path: string };
    assert.match(migratedImage.file_path, /^studio\/organizations\/org-1\/workspaces\/organization-1\/assets\/products\/product-1\//u);
    assert.equal((await storage.readAssetFile(migratedImage.file_path)).toString('utf8'), 'legacy asset');
    const migratedOutput = sqlite.prepare('SELECT file_path FROM studio_generation_outputs WHERE id = ?')
      .get('output-1') as { file_path: string };
    assert.match(migratedOutput.file_path, /^studio\/organizations\/org-1\/workspaces\/organization-1\/outputs\/generation-1\//u);
    assert.equal((await storage.readOutputFile(migratedOutput.file_path)).toString('utf8'), 'legacy output');
    const migratedGeneration = sqlite.prepare('SELECT metadata FROM studio_generations WHERE id = ?')
      .get('generation-1') as { metadata: string };
    const migratedMetadata = JSON.parse(migratedGeneration.metadata) as {
      extraReferenceUrls: string[];
      startFramePath: string;
    };
    assert.match(migratedMetadata.extraReferenceUrls[0], /^studio\/organizations\/org-1\/workspaces\/organization-1\/assets\/references\//u);
    assert.equal((await storage.readAssetFile(migratedMetadata.extraReferenceUrls[0])).toString('utf8'), 'legacy reference');
    assert.match(migratedMetadata.extraReferenceUrls[1], /^studio\/organizations\/org-1\/workspaces\/organization-1\/assets\/references\//u);
    assert.equal((await storage.readAssetFile(migratedMetadata.extraReferenceUrls[1])).toString('utf8'), 'legacy upload');
    assert.match(migratedMetadata.startFramePath, /^studio\/organizations\/org-1\/workspaces\/organization-1\/edits\//u);
    assert.equal((await storage.readEditFile(migratedMetadata.startFramePath)).toString('utf8'), 'legacy edit');
    assert.equal(await fs.readFile(path.join(dataRoot, 'workspace/notes.md'), 'utf8'), '# stays here');
  } finally {
    sqlite.close();
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousProvider;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('studio workspace migration tests passed');
}

void main();
