import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-studio-cleanup-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const { db } = await import('../app/lib/db');
    const { studioPresets } = await import('../app/lib/db/schema');
    const { cleanupOrphanedStudioAssets } = await import('../app/lib/cleanup/orphaned-assets');

    const workspaceRoot = path.join(dataRoot, 'workspace');
    const organizationRoot = path.join(dataRoot, 'studio', 'organizations', 'org-cleanup');
    const activeStudioRoot = path.join(organizationRoot, 'workspaces', 'workspace-active');
    const otherStudioRoot = path.join(dataRoot, 'studio', 'organizations', 'org-other', 'workspaces', 'workspace-other');

    const normalWorkspaceFile = path.join(workspaceRoot, 'notes.md');
    const orphanProduct = path.join(activeStudioRoot, 'assets', 'products', 'orphan', 'image.png');
    const referencedPreset = path.join(activeStudioRoot, 'assets', 'presets', 'kept', 'preview.png');
    const looseReference = path.join(activeStudioRoot, 'assets', 'references', 'loose.png');
    const looseEdit = path.join(activeStudioRoot, 'edits', 'loose.png');
    const orphanOutput = path.join(activeStudioRoot, 'outputs', 'generation-orphan', 'result.png');
    const otherOrganizationProduct = path.join(otherStudioRoot, 'assets', 'products', 'other', 'image.png');
    const otherOrganizationOutput = path.join(otherStudioRoot, 'outputs', 'generation-other', 'result.png');

    for (const filePath of [
      normalWorkspaceFile,
      orphanProduct,
      referencedPreset,
      looseReference,
      looseEdit,
      orphanOutput,
      otherOrganizationProduct,
      otherOrganizationOutput,
    ]) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, path.basename(filePath));
    }

    const referencedPresetVirtualPath = [
      'studio',
      'organizations',
      'org-cleanup',
      'workspaces',
      'workspace-active',
      'assets',
      'presets',
      'kept',
      'preview.png',
    ].join('/');
    const now = new Date();
    await db.insert(studioPresets).values({
      id: 'preset-cleanup-kept',
      userId: null,
      organizationId: null,
      workspaceId: null,
      createdByUserId: null,
      visibility: 'workspace',
      isDefault: false,
      name: 'Kept preset',
      blocks: '[]',
      previewImagePath: referencedPresetVirtualPath,
      createdAt: now,
      updatedAt: now,
    });

    const result = await cleanupOrphanedStudioAssets({ organizationId: 'org-cleanup' });
    assert.equal(result.errors.length, 0);
    assert.equal(result.deleted, 2);
    assert.equal(await exists(orphanProduct), false);
    assert.equal(await exists(orphanOutput), false);
    assert.equal(await exists(referencedPreset), true);
    assert.equal(await exists(looseReference), true);
    assert.equal(await exists(looseEdit), true);
    assert.equal(await exists(otherOrganizationProduct), true);
    assert.equal(await exists(otherOrganizationOutput), true);
    assert.equal(await fs.readFile(normalWorkspaceFile, 'utf8'), 'notes.md');

    console.log('studio-orphaned-assets-cleanup-test: ok');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
