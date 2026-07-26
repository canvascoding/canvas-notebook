import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-files-'));
  const originalData = process.env.DATA;
  const originalProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = path.join(temporaryRoot, 'data');
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  try {
    const workspaceRoot = path.join(process.env.DATA, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'Projects'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'Readme.txt'), 'Mobile file preview.');
    await fs.writeFile(path.join(workspaceRoot, 'Cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(workspaceRoot, 'Projects', 'Brief.md'), '# Brief');

    const { closeDatabaseConnections, openDb } = await import('../app/lib/db');
    const database = await openDb();
    const now = Date.now();
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['files-user', 'Files User', 'files@example.test', 1, now, now],
    );
    await database.close();

    const { createLegacyPersonalWorkspaceContext } = await import('../app/lib/workspaces/context');
    const {
      listMobileFiles,
      mobileFileCategory,
      mobileFileOpenKind,
      normalizeMobileFilePath,
      readMobileFileDetail,
    } = await import('../app/lib/mobile/files');
    const workspace = createLegacyPersonalWorkspaceContext({
      userId: 'files-user',
      email: 'files@example.test',
      role: 'owner',
    });
    const fileOptions = { workspace };

    const root = await listMobileFiles({ workspace, fileOptions, directory: '.', limit: 20 });
    assert.equal(root.items[0]?.category, 'folder');
    assert.equal(root.items.some((entry) => entry.path === 'Readme.txt'), true);
    assert.equal(root.actions.canUpload, true);
    assert.equal(root.actions.canCopy, true);
    assert.equal(root.actions.canExport, true);
    assert.deepEqual(root.breadcrumbs, [{ name: 'Workspace', path: '.' }]);

    const imageOnly = await listMobileFiles({ workspace, fileOptions, filter: 'image', limit: 20 });
    assert.deepEqual(imageOnly.items.map((entry) => entry.path), ['Cover.png']);

    const search = await listMobileFiles({ workspace, fileOptions, query: 'brief', limit: 20 });
    assert.equal(search.items[0]?.path, 'Projects/Brief.md');
    assert.equal(search.items[0]?.openKind, 'markdown');
    assert.equal(search.items[0]?.canOpenInNotebook, true);

    const text = await readMobileFileDetail({ workspace, fileOptions, path: 'Readme.txt' });
    assert.equal(text.previewMode, 'text');
    assert.equal(text.content, 'Mobile file preview.');

    const image = await readMobileFileDetail({ workspace, fileOptions, path: 'Cover.png' });
    assert.equal(image.previewMode, 'image');
    assert.equal(image.mimeType, 'image/png');

    const { createDirectoryIfAbsent, writeWorkspaceFileFromPathIfAbsent } = await import('../app/lib/filesystem/workspace-files');
    await assert.rejects(() => createDirectoryIfAbsent('Projects', fileOptions), (error: unknown) => (
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
    ));
    const uploadSource = path.join(temporaryRoot, 'upload-source.txt');
    await fs.writeFile(uploadSource, 'must not replace');
    await assert.rejects(() => writeWorkspaceFileFromPathIfAbsent(uploadSource, 'Readme.txt', fileOptions), (error: unknown) => (
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
    ));
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'Readme.txt'), 'utf8'), 'Mobile file preview.');

    assert.equal(mobileFileCategory('clip.mp4', 'file'), 'video');
    assert.equal(mobileFileOpenKind('note.md', 'file'), 'markdown');
    assert.equal(mobileFileOpenKind('document.docx', 'file'), 'word');
    assert.equal(mobileFileOpenKind('workbook.xlsx', 'file'), 'spreadsheet');
    assert.equal(mobileFileOpenKind('deck.pptx', 'file'), 'presentation');
    assert.equal(mobileFileOpenKind('drawing.excalidraw', 'file'), 'excalidraw');
    assert.equal(mobileFileOpenKind('bundle.zip', 'file'), 'archive');
    assert.equal(mobileFileOpenKind('Workspace', 'directory'), 'folder');
    assert.throws(() => normalizeMobileFilePath('../secrets', false));
    await assert.rejects(() => listMobileFiles({
      workspace,
      fileOptions,
      query: 'brief',
      cursor: Buffer.from(JSON.stringify({ offset: 1, signature: 'wrong' })).toString('base64url'),
    }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_CURSOR'));

    const blobAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/blob/route.ts'), 'utf8');
    const copyAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/copy/route.ts'), 'utf8');
    const markdownPdfAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/export/markdown-pdf/route.ts'), 'utf8');
    const marpDetectAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/export/marp-detect/route.ts'), 'utf8');
    const marpPdfAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/export/marp-pdf/route.ts'), 'utf8');
    const marpImagesAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/export/marp-images/route.ts'), 'utf8');
    const uploadAlias = await fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/files/uploads/[id]/route.ts'), 'utf8');
    assert.match(blobAlias, /api\/files\/download\/route/u);
    assert.match(copyAlias, /api\/files\/copy\/route/u);
    assert.match(markdownPdfAlias, /api\/files\/markdown-pdf\/route/u);
    assert.match(marpDetectAlias, /api\/files\/marp-detect\/route/u);
    assert.match(marpPdfAlias, /api\/files\/marp-pdf\/route/u);
    assert.match(marpImagesAlias, /api\/files\/marp-images\/route/u);
    assert.match(uploadAlias, /DELETE, GET, PUT/u);

    await closeDatabaseConnections();
    console.log('mobile-files-test: ok');
  } finally {
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    if (originalProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = originalProvider;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main();
