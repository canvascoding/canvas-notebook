import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GEMINI_FLASH_IMAGE_MODEL_ID } from '../app/lib/integrations/image-generation-constants';

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-studio-preset-preview-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { db } = await import('../app/lib/db');
    const { studioPresets, user } = await import('../app/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const { getImageGenerationProvider } = await import('../app/lib/integrations/image-generation-providers');
    const { ensureDefaultStudioPresetsSeeded } = await import('../app/lib/integrations/studio-preset-defaults');
    const { generatePresetPreview, listPresets } = await import('../app/lib/integrations/studio-preset-service');
    const {
      generatePresetPreviewPath,
      resolveStudioFilePath,
      writeAssetFile,
    } = await import('../app/lib/integrations/studio-workspace');
    const {
      ensureOrganizationBootstrapForUser,
      openOrganizationBootstrapDatabase,
    } = await import('../app/lib/organization/bootstrap');
    const { createPersistedStudioScope } = await import('../app/lib/integrations/studio-scope');

    const userId = 'preview-test-user';
    const now = new Date();
    await db.insert(user).values({
      id: userId,
      name: 'Preview Test User',
      email: 'preview-test@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const sqlite = openOrganizationBootstrapDatabase();
    let organizationId: string;
    let workspaceId: string;
    try {
      sqlite.exec('BEGIN IMMEDIATE');
      const status = ensureOrganizationBootstrapForUser(sqlite, userId);
      assert.ok(status.organizationId);
      organizationId = status.organizationId;
      const workspace = sqlite.prepare(`
        SELECT id FROM canvas_workspaces WHERE organization_id = ? AND owner_user_id = ? AND type = 'personal'
      `).get(organizationId, userId) as { id: string } | undefined;
      assert.ok(workspace?.id);
      workspaceId = workspace.id;
      sqlite.exec('COMMIT');
    } finally {
      sqlite.close();
    }
    const scope = createPersistedStudioScope({ actorUserId: userId, organizationId, workspaceId });

    const provider = getImageGenerationProvider('gemini');
    assert.ok(provider, 'Gemini provider should exist');
    provider.generate = async () => ({
      imageBytes: Buffer.from('new preview image').toString('base64'),
      mimeType: 'image/png',
    });

    const presetId = 'preview-persistence-preset';
    const oldPreviewPath = generatePresetPreviewPath(presetId, 'png', scope.storage);
    await writeAssetFile(oldPreviewPath, Buffer.from('old preview image'));
    await db.insert(studioPresets).values({
      id: presetId,
      userId,
      organizationId,
      workspaceId,
      createdByUserId: userId,
      visibility: 'workspace',
      isDefault: false,
      name: 'Preview Persistence Preset',
      description: null,
      category: 'product',
      blocks: JSON.stringify([{
        id: 'lighting-softbox-clean',
        type: 'lighting',
        label: 'Softbox Clean',
        promptFragment: 'softbox key light with clean commercial highlights',
        category: 'commercial',
      }]),
      previewImagePath: oldPreviewPath,
      tags: null,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await generatePresetPreview(scope, presetId, {
      provider: 'gemini',
      model: GEMINI_FLASH_IMAGE_MODEL_ID,
      aspectRatio: '1:1',
    });

    assert.ok(updated.previewImagePath, 'Generated preset should keep a preview path');
    assert.notEqual(updated.previewImagePath, oldPreviewPath);
    assert.equal(
      await exists(resolveStudioFilePath(updated.previewImagePath) || ''),
      true,
      'New preview file should exist',
    );
    assert.equal(
      await exists(resolveStudioFilePath(oldPreviewPath) || ''),
      false,
      'Old preview file should be deleted only after the new preview is stored',
    );

    const [dbPreset] = await db.select().from(studioPresets).where(eq(studioPresets.id, presetId));
    assert.equal(dbPreset.previewImagePath, updated.previewImagePath);

    const seedRegressionPreviewPath = generatePresetPreviewPath('user-seed-regression', 'png', scope.storage);
    await writeAssetFile(seedRegressionPreviewPath, Buffer.from('custom preview'));
    await db.insert(studioPresets).values({
      id: 'user-seed-regression',
      userId,
      organizationId,
      workspaceId,
      createdByUserId: userId,
      visibility: 'workspace',
      isDefault: false,
      name: 'User Seed Regression',
      description: null,
      category: 'product',
      blocks: JSON.stringify([{
        id: 'lighting-softbox-clean',
        type: 'lighting',
        label: 'Softbox Clean',
        promptFragment: 'softbox key light with clean commercial highlights',
        category: 'commercial',
      }]),
      previewImagePath: seedRegressionPreviewPath,
      tags: null,
      createdAt: now,
      updatedAt: now,
    });

    await ensureDefaultStudioPresetsSeeded();
    const [seedRegressionPreset] = await db.select()
      .from(studioPresets)
      .where(eq(studioPresets.id, 'user-seed-regression'));
    assert.equal(seedRegressionPreset.previewImagePath, seedRegressionPreviewPath);

    await db.insert(studioPresets).values({
      id: 'dangling-preview-preset',
      userId,
      organizationId,
      workspaceId,
      createdByUserId: userId,
      visibility: 'workspace',
      isDefault: false,
      name: 'Dangling Preview Preset',
      description: null,
      category: 'product',
      blocks: JSON.stringify([{
        id: 'lighting-softbox-clean',
        type: 'lighting',
        label: 'Softbox Clean',
        promptFragment: 'softbox key light with clean commercial highlights',
        category: 'commercial',
      }]),
      previewImagePath: generatePresetPreviewPath('dangling-preview-preset', 'png', scope.storage),
      tags: null,
      createdAt: now,
      updatedAt: now,
    });

    const listedPresets = await listPresets(scope);
    assert.equal(
      listedPresets.find((preset) => preset.id === 'dangling-preview-preset')?.previewImagePath,
      null,
      'Missing user preset preview files should be sanitized before rendering',
    );
    const [danglingPreset] = await db.select()
      .from(studioPresets)
      .where(eq(studioPresets.id, 'dangling-preview-preset'));
    assert.equal(danglingPreset.previewImagePath, null);
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('Studio preset preview persistence test passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
