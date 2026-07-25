import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-studio-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  await fs.mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  const now = Date.now();

  try {
    runMigrations(sqlite);
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ('studio-user', 'Studio User', 'studio@example.test', 1, 'admin', ?, ?)
    `).run(now, now);
    sqlite.exec('BEGIN IMMEDIATE');
    const bootstrap = ensureOrganizationBootstrapForUser(sqlite, 'studio-user');
    sqlite.exec('COMMIT');
    assert.ok(bootstrap.organizationId);
    const workspace = sqlite.prepare(`
      SELECT id FROM canvas_workspaces
      WHERE organization_id = ?
      ORDER BY created_at ASC LIMIT 1
    `).get(bootstrap.organizationId) as { id: string } | undefined;
    assert.ok(workspace?.id);

    const insertGeneration = sqlite.prepare(`
      INSERT INTO studio_generations (
        id, user_id, organization_id, workspace_id, created_by_user_id, mode, prompt, raw_prompt,
        aspect_ratio, provider, model, metadata, status, created_at, updated_at
      ) VALUES (?, 'studio-user', ?, ?, 'studio-user', 'image', ?, ?, '1:1', 'gemini',
        'gemini-3.1-flash-image', ?, ?, ?, ?)
    `);
    insertGeneration.run(
      'generation-new',
      bootstrap.organizationId,
      workspace.id,
      'Private prompt',
      'Private prompt',
      JSON.stringify({ error: 'Provider token-secretvalue123456789 failed', internalPath: '/data/secret' }),
      'failed',
      now,
      now,
    );
    insertGeneration.run(
      'generation-old',
      bootstrap.organizationId,
      workspace.id,
      'Older prompt',
      'Older prompt',
      null,
      'completed',
      now - 1_000,
      now - 1_000,
    );
    sqlite.prepare(`
      INSERT INTO studio_generation_outputs (
        id, generation_id, organization_id, workspace_id, created_by_user_id, variation_index, type,
        file_path, file_name, mime_type, file_size, width, height, is_favorite, metadata, created_at
      ) VALUES ('output-1', 'generation-new', ?, ?, 'studio-user', 0, 'image',
        'studio/outputs/private/server/path.png', 'path.png', 'image/png', 1234, 1024, 1024, 0,
        '{"providerSecret":"hidden"}', ?)
    `).run(bootstrap.organizationId, workspace.id, now);
    sqlite.prepare(`
      INSERT INTO studio_presets (
        id, user_id, organization_id, workspace_id, created_by_user_id, visibility,
        is_default, name, description, category, blocks, preview_image_path, tags, created_at, updated_at
      ) VALUES (
        'preset-nullable', 'studio-user', ?, ?, 'studio-user', 'workspace',
        0, 'Legacy preset', NULL, NULL, '[]', 'studio/assets/presets/mobile-preview.png', '[]', ?, ?
      )
    `).run(bootstrap.organizationId, workspace.id, now, now);
    sqlite.prepare(`
      INSERT INTO studio_products (
        id, user_id, organization_id, workspace_id, created_by_user_id, visibility,
        name, description, thumbnail_path, created_at, updated_at
      ) VALUES (
        'product-preview', 'studio-user', ?, ?, 'studio-user', 'workspace',
        'Mobile product', 'Preview contract fixture',
        'studio/assets/products/mobile-product/preview.png', ?, ?
      )
    `).run(bootstrap.organizationId, workspace.id, now, now);
    const previewFixturePath = path.join(dataRoot, 'studio', 'assets', 'presets', 'mobile-preview.png');
    await fs.mkdir(path.dirname(previewFixturePath), { recursive: true });
    await fs.writeFile(previewFixturePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    sqlite.close();

    const {
      getMobileStudioGeneration,
      getMobileStudioCatalog,
      listMobileStudioGenerations,
      parseMobileStudioGenerationRequest,
    } = await import('../app/lib/mobile/studio');
    const {
      centeredMobileStudioReframeFrame,
      resolveMobileStudioReframeFrame,
    } = await import('../app/lib/mobile/studio-reframe');
    const { createPersistedStudioScope } = await import('../app/lib/integrations/studio-scope');
    const {
      listMobileStudioLibrary,
      parseMobileStudioLibraryKind,
    } = await import('../app/lib/mobile/studio-management');
    const {
      parseMobileStudioPresetInput,
      serializeMobileStudioPreset,
    } = await import('../app/lib/mobile/studio-presets');
    const { listPresets } = await import('../app/lib/integrations/studio-preset-service');
    const { closeDatabaseConnections } = await import('../app/lib/db');
    const scope = createPersistedStudioScope({
      actorUserId: 'studio-user',
      organizationId: bootstrap.organizationId,
      workspaceId: workspace.id,
    });
    assert.equal(parseMobileStudioLibraryKind('products'), 'products');
    assert.throws(() => parseMobileStudioLibraryKind('secrets'), /kind is invalid/u);
    assert.deepEqual(parseMobileStudioPresetInput({
      name: 'Mobile campaign', category: 'product', blocks: [{ type: 'lighting', label: 'Soft', promptFragment: 'soft light' }],
    }).blocks.map((block) => block.type), ['lighting']);
    assert.throws(() => parseMobileStudioPresetInput({ name: 'Empty', category: 'product', blocks: [] }), /at least one block/u);
    assert.deepEqual(
      centeredMobileStudioReframeFrame(1_600, 1_200, 4 / 5, 'crop'),
      { x: 320, y: 0, width: 960, height: 1_200 },
    );
    assert.deepEqual(resolveMobileStudioReframeFrame({
      frame: { x: 120, y: 100, width: 800, height: 1_000 },
      mode: 'crop',
      sourceWidth: 1_600,
      sourceHeight: 1_200,
      targetRatio: 4 / 5,
    }), { x: 120, y: 100, width: 800, height: 1_000 });
    assert.throws(() => resolveMobileStudioReframeFrame({
      frame: { x: -1, y: 0, width: 800, height: 1_000 },
      mode: 'crop',
      sourceWidth: 1_600,
      sourceHeight: 1_200,
      targetRatio: 4 / 5,
    }), /crop frame is invalid/u);
    assert.throws(() => resolveMobileStudioReframeFrame({
      frame: { x: 120, y: 100, width: 900, height: 1_000 },
      mode: 'crop',
      sourceWidth: 1_600,
      sourceHeight: 1_200,
      targetRatio: 4 / 5,
    }), /crop frame is invalid/u);

    const catalog = await getMobileStudioCatalog({ scope, userId: 'studio-user', canWrite: true, canDeleteAssets: true });
    const nullablePreset = catalog.presets.find((preset) => preset.id === 'preset-nullable');
    assert.equal(nullablePreset?.description, '');
    assert.equal(nullablePreset?.category, 'custom');
    assert.equal(
      nullablePreset?.previewUrl,
      `/api/files/preview?path=studio%2Fassets%2Fpresets%2Fmobile-preview.png&w=320&preset=mini&workspaceId=${encodeURIComponent(workspace.id)}`,
    );
    const catalogProduct = catalog.library.products.find((product) => product.id === 'product-preview');
    assert.equal(
      catalogProduct?.previewUrl,
      `/api/files/preview?path=studio%2Fassets%2Fproducts%2Fmobile-product%2Fpreview.png&w=320&preset=mini&workspaceId=${encodeURIComponent(workspace.id)}`,
    );
    const managedProducts = await listMobileStudioLibrary('products', scope);
    assert.equal(managedProducts.find((product) => product.id === 'product-preview')?.previewUrl, catalogProduct?.previewUrl);
    const managedPresets = await listPresets(scope);
    const managedNullablePreset = managedPresets.find((preset) => preset.id === 'preset-nullable');
    assert.ok(managedNullablePreset);
    assert.equal(serializeMobileStudioPreset(managedNullablePreset, workspace.id).previewUrl, nullablePreset?.previewUrl);

    const parsed = parseMobileStudioGenerationRequest({
      mode: 'video',
      provider: 'bytedance',
      model: 'bytedance/seedance-2',
      prompt: 'Campaign reveal',
      aspectRatio: '9:16',
      videoResolution: '720p',
      videoDuration: 6,
      productIds: ['product-1'],
      personaIds: ['persona-1'],
      styleIds: ['style-1'],
      videoGenerateAudio: false,
      videoWebSearch: true,
      videoNsfwChecker: false,
      references: [
        { kind: 'image', path: 'studio/assets/workspaces/workspace/reference.png' },
        { kind: 'video', path: 'studio/assets/workspaces/workspace/reference.mp4' },
      ],
    });
    assert.equal(parsed.mode, 'video');
    assert.deepEqual(parsed.product_ids, ['product-1']);
    assert.deepEqual(parsed.persona_ids, ['persona-1']);
    assert.deepEqual(parsed.style_ids, ['style-1']);
    assert.equal(parsed.video_generate_audio, false);
    assert.equal(parsed.video_web_search, true);
    assert.equal(parsed.video_nsfw_checker, false);
    assert.deepEqual(parsed.extra_reference_urls, ['studio/assets/workspaces/workspace/reference.png']);
    assert.deepEqual(parsed.video_reference_urls, ['studio/assets/workspaces/workspace/reference.mp4']);
    assert.throws(() => parseMobileStudioGenerationRequest({
      mode: 'video', provider: 'veo', model: 'veo-3.1-fast-generate-preview', prompt: 'Clip', videoDuration: 5,
    }), /duration is not supported/u);
    assert.throws(() => parseMobileStudioGenerationRequest({
      mode: 'image', prompt: 'Image', references: [{ kind: 'audio', path: 'studio/ref.wav' }],
    }), /image references only/u);
    assert.throws(() => parseMobileStudioGenerationRequest({ mode: 'sound', prompt: '' }), /requires a prompt/u);
    assert.throws(() => parseMobileStudioGenerationRequest({ mode: 'image', prompt: 'Image', model: 'unknown-model' }), /not supported/u);
    assert.throws(() => parseMobileStudioGenerationRequest({ mode: 'video', provider: 'bytedance', prompt: 'Video', isLooping: true }), /require Google Veo/u);

    const firstPage = await listMobileStudioGenerations({ scope, limit: 1 });
    assert.equal(firstPage.generations.length, 1);
    assert.equal(firstPage.generations[0].id, 'generation-new');
    assert.ok(firstPage.nextCursor);
    const serialized = firstPage.generations[0] as unknown as Record<string, unknown>;
    assert.equal('metadata' in serialized, false);
    const output = firstPage.generations[0].outputs[0] as unknown as Record<string, unknown>;
    assert.equal('filePath' in output, false);
    assert.equal('mediaUrl' in output, false);
    assert.equal(
      output.previewUrl,
      '/api/mobile/v1/studio/outputs/output-1/preview',
    );
    assert.equal(firstPage.generations[0].error?.includes('secretvalue'), false);
    assert.equal(firstPage.generations[0].error?.includes('[redacted]'), true);
    assert.equal(firstPage.generations[0].settings.quality, 'auto');
    assert.deepEqual(firstPage.generations[0].references.productIds, []);

    const secondPage = await listMobileStudioGenerations({ scope, limit: 1, cursor: firstPage.nextCursor });
    assert.equal(secondPage.generations[0].id, 'generation-old');
    assert.equal(secondPage.nextCursor, null);
    await assert.rejects(
      () => listMobileStudioGenerations({
        scope: { ...scope, workspaceId: 'other-workspace', storage: { ...scope.storage, workspaceId: 'other-workspace' } },
        limit: 1,
        cursor: firstPage.nextCursor,
      }),
      /cursor is invalid/u,
    );

    const detail = await getMobileStudioGeneration({ scope, generationId: 'generation-new' });
    assert.equal(detail.outputs[0].fileName, 'path.png');
    assert.equal(detail.prompt, 'Private prompt');
    await assert.rejects(
      () => getMobileStudioGeneration({ scope, generationId: 'missing' }),
      /not found/u,
    );

    await closeDatabaseConnections();
    console.log('mobile-studio-test: ok');
  } finally {
    if (sqlite.open) sqlite.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
