import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-media-reference-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATA_ROOT = tempRoot;

  const {
    classifyMediaReference,
    loadMediaReference,
    loadMediaReferences,
  } = await import('../app/lib/integrations/media-reference-resolver');

  async function writeFixture(relativePath: string, content: string = 'fixture'): Promise<string> {
    const fullPath = path.join(tempRoot, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    return fullPath;
  }

  try {
    const workspaceImage = await writeFixture('workspace/09_asset_library/photo.jpeg');
    await writeFixture('studio/outputs/studio-gen-test.png');
    await writeFixture('studio/assets/products/product-1/img.png');
    await writeFixture('studio/assets/references/user-1/ref-abc.png');
    await writeFixture('user-uploads/studio-references/upload.png');
    await writeFixture('workspace/video/input.mp4');

    const workspaceRelative = classifyMediaReference('09_asset_library/photo.jpeg');
    assert.equal(workspaceRelative?.kind, 'workspace_relative');
    assert.equal(workspaceRelative?.relativePath, '09_asset_library/photo.jpeg');
    assert.equal(workspaceRelative?.mimeType, 'image/jpeg');

    const workspaceApi = classifyMediaReference('/api/media/09_asset_library/photo.jpeg');
    assert.equal(workspaceApi?.kind, 'workspace_relative');
    assert.equal(workspaceApi?.absolutePath, workspaceImage);

    const workspaceAbsolute = classifyMediaReference(workspaceImage);
    assert.equal(workspaceAbsolute?.kind, 'workspace_absolute');
    assert.equal(workspaceAbsolute?.relativePath, '09_asset_library/photo.jpeg');

    const studioOutput = classifyMediaReference('/api/studio/media/studio/outputs/studio-gen-test.png');
    assert.equal(studioOutput?.kind, 'studio_output');
    assert.equal(studioOutput?.relativePath, 'studio-gen-test.png');

    const legacyStudioOutput = classifyMediaReference('studio-gen-test.png');
    assert.equal(legacyStudioOutput?.kind, 'studio_output');

    const studioAsset = classifyMediaReference('/api/studio/media/studio/assets/products/product-1/img.png');
    assert.equal(studioAsset?.kind, 'studio_asset');
    assert.equal(studioAsset?.relativePath, 'products/product-1/img.png');

    const shortStudioAsset = classifyMediaReference('products/product-1/img.png');
    assert.equal(shortStudioAsset?.kind, 'studio_asset');

    const studioReference = classifyMediaReference('/api/studio/references/ref-abc.png', { userId: 'user-1' });
    assert.equal(studioReference?.kind, 'studio_reference');
    assert.equal(studioReference?.relativePath, 'references/user-1/ref-abc.png');

    const userUpload = classifyMediaReference('user-uploads/studio-references/upload.png');
    assert.equal(userUpload?.kind, 'user_upload');
    assert.equal(userUpload?.relativePath, 'upload.png');

    const externalUrl = classifyMediaReference('https://example.com/image.png?token=secret');
    assert.equal(externalUrl?.kind, 'external_url');
    assert.equal(externalUrl?.fileName, 'image.png');

    assert.equal(classifyMediaReference('/api/media/../secrets/key.png'), null);
    assert.equal(classifyMediaReference('/api/studio/references/../ref.png', { userId: 'user-1' }), null);

    const loadedWorkspace = await loadMediaReference('/api/media/09_asset_library/photo.jpeg', { allowedTypes: ['image'] });
    assert.equal(loadedWorkspace.mimeType, 'image/jpeg');
    assert.equal(loadedWorkspace.imageBytes, Buffer.from('fixture').toString('base64'));
    assert.equal(loadedWorkspace.fileSize, 'fixture'.length);

    const loadedVideo = await loadMediaReference('video/input.mp4', { allowedTypes: ['video'] });
    assert.equal(loadedVideo.mimeType, 'video/mp4');
    assert.equal(loadedVideo.videoBytes, Buffer.from('fixture').toString('base64'));

    await assert.rejects(
      () => loadMediaReference('video/input.mp4', { allowedTypes: ['image'] }),
      /Unsupported video reference/,
    );

    await assert.rejects(
      () => loadMediaReference('/api/media/09_asset_library/photo.jpeg', { maxBytes: 2 }),
      /too large/,
    );

    const loadedMany = await loadMediaReferences([
      '/api/media/09_asset_library/photo.jpeg',
      '/api/media/missing.png',
      'products/product-1/img.png',
    ]);
    assert.equal(loadedMany.length, 2);

    console.log('Media reference resolver test passed');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
