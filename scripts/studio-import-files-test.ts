import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-studio-import-files-'));
  const previousData = process.env.DATA;

  try {
    process.env.DATA = dataRoot;
    const workspaceRoot = path.join(dataRoot, 'workspace');
    const studioReferenceRoot = path.join(dataRoot, 'user-uploads', 'studio-references');
    const outsidePath = path.join(dataRoot, 'outside-secret.txt');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(studioReferenceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'valid.png'), 'workspace-image');
    await fs.writeFile(path.join(studioReferenceRoot, 'reference.jpg'), 'reference-image');
    await fs.writeFile(outsidePath, 'outside-secret');
    await fs.symlink(outsidePath, path.join(workspaceRoot, 'outside-link.png'));

    const { readStudioImportFile } = await import('../app/lib/integrations/studio-import-files');
    const workspaceFile = await readStudioImportFile(path.join(workspaceRoot, 'valid.png'));
    assert.equal(workspaceFile?.buffer.toString('utf8'), 'workspace-image');
    assert.equal(workspaceFile?.fileName, 'valid.png');
    assert.equal(workspaceFile?.mimeType, 'image/png');

    const referenceFile = await readStudioImportFile('user-uploads/studio-references/reference.jpg');
    assert.equal(referenceFile?.buffer.toString('utf8'), 'reference-image');
    assert.equal(referenceFile?.fileName, 'reference.jpg');
    assert.equal(referenceFile?.mimeType, 'image/jpeg');

    assert.equal(await readStudioImportFile(path.join(workspaceRoot, 'outside-link.png')), null);
    assert.equal(await readStudioImportFile(outsidePath), null);

    console.log('studio import files test passed');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error('studio import files test failed');
  process.exitCode = 1;
});
