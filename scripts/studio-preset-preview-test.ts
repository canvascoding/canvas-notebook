import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    const { getStudioAssetsRoot, writeAssetFile } = await import('../app/lib/integrations/studio-workspace');

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

    const provider = getImageGenerationProvider('gemini');
    assert.ok(provider, 'Gemini provider should exist');
    provider.generate = async () => ({
      imageBytes: Buffer.from('new preview image').toString('base64'),
      mimeType: 'image/png',
    });

    const presetId = 'preview-persistence-preset';
    const oldPreviewPath = `studio/assets/presets/${presetId}/preview-old.png`;
    await writeAssetFile(oldPreviewPath, Buffer.from('old preview image'));
    await db.insert(studioPresets).values({
      id: presetId,
      userId,
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

    const updated = await generatePresetPreview(userId, presetId, {
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      aspectRatio: '1:1',
    });

    assert.ok(updated.previewImagePath, 'Generated preset should keep a preview path');
    assert.notEqual(updated.previewImagePath, oldPreviewPath);
    assert.equal(
      await exists(path.join(getStudioAssetsRoot(), updated.previewImagePath.replace('studio/assets/', ''))),
      true,
      'New preview file should exist',
    );
    assert.equal(
      await exists(path.join(getStudioAssetsRoot(), oldPreviewPath.replace('studio/assets/', ''))),
      false,
      'Old preview file should be deleted only after the new preview is stored',
    );

    const [dbPreset] = await db.select().from(studioPresets).where(eq(studioPresets.id, presetId));
    assert.equal(dbPreset.previewImagePath, updated.previewImagePath);

    const seedRegressionPreviewPath = 'studio/assets/presets/user-seed-regression/preview-custom.png';
    await writeAssetFile(seedRegressionPreviewPath, Buffer.from('custom preview'));
    await db.insert(studioPresets).values({
      id: 'user-seed-regression',
      userId,
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
      previewImagePath: 'studio/assets/presets/dangling-preview-preset/preview-missing.png',
      tags: null,
      createdAt: now,
      updatedAt: now,
    });

    const listedPresets = await listPresets(userId);
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
