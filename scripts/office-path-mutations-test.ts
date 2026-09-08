import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PGlite } from '@electric-sql/pglite';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { setFileCollaborationConnectionFactoryForTests } from '../app/lib/files/collaboration-repository';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function documentBytes(text: string): Promise<Buffer> {
  return new JSZip()
    .file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    .file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    .file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
    .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-office-paths-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  const database = new PGlite();
  try {
    await runPostgresMigrations(database as unknown as Parameters<typeof runPostgresMigrations>[0]);
    setFileCollaborationConnectionFactoryForTests(async () => ({
      get: async (sql, params = []) => (await database.query(sql, params)).rows[0],
      all: async (sql, params = []) => (await database.query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await database.query(sql, params)).affectedRows ?? 0 }),
      close: () => undefined,
    }));
    const { copyFileBetweenWorkspaces, deleteFile, renameFile } = await import('../app/lib/filesystem/workspace-files');
    const { renameWorkspacePath } = await import('../app/lib/files/rename-service');
    const { runWorkspaceUploadWrite } = await import('../app/lib/files/workspace-upload-flow');
    const { extractWorkspaceZip } = await import('../app/lib/filesystem/zip-extraction');
    const { trashWorkspacePaths, restoreWorkspaceTrashEntry } = await import('../app/lib/filesystem/workspace-trash');
    const { readOfficeDocumentSnapshot } = await import('../app/lib/office/document-service');
    const { readOfficeVersion } = await import('../app/lib/office/document-journal');
    const { readOfficePathHistory } = await import('../app/lib/office/document-versions');
    const { acquireFileLock, releaseFileLock, getFileCollaborationState, archiveFileCollaborationPaths, restoreFileCollaborationPath } = await import('../app/lib/files/collaboration-policy');
    const workspace = (id: string, type: WorkspaceContext['workspaceType']): WorkspaceContext => ({
      workspaceId: id, workspaceType: type, rootPath: path.join(dataRoot, id), organizationId: type === 'personal' ? null : 'org',
      ownerUserId: type === 'personal' ? 'alice' : null, legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
    });
    const source = workspace('source', 'personal');
    const target = workspace('target', 'organization');
    const { openDb } = await import('../app/lib/db');
    const runtimeDatabase = await openDb();
    try {
      await runtimeDatabase.run('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)', ['alice', 'Alice', 'alice@example.invalid', 1, Date.now(), Date.now()]);
      await runtimeDatabase.run('INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at) VALUES (?,?,?,?)', ['org', 'alice', Date.now(), Date.now()]);
      await runtimeDatabase.run('INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [target.workspaceId, 'org', 'organization', 'target', 'Target', Date.now(), Date.now()]);
    } finally { await runtimeDatabase.close(); }
    const sourceOptions = { workspace: source };
    const targetOptions = { workspace: target, mutationActorUserId: 'alice' };
    const copyOptions = { source: sourceOptions, target: targetOptions };
    const original = await documentBytes('Original');
    const copied = await documentBytes('Copied');
    await fs.mkdir(path.join(source.rootPath, 'folder'), { recursive: true });
    await fs.mkdir(path.join(target.rootPath, 'folder'), { recursive: true });
    await fs.mkdir(path.join(target.rootPath, 'imports'), { recursive: true });
    await fs.writeFile(path.join(source.rootPath, 'report.docx'), copied);
    await fs.writeFile(path.join(target.rootPath, 'report.docx'), original);
    await fs.writeFile(path.join(source.rootPath, 'folder/nested.docx'), copied);
    await fs.writeFile(path.join(source.rootPath, 'folder/note.txt'), 'new note');
    await fs.writeFile(path.join(target.rootPath, 'folder/nested.docx'), original);
    await fs.writeFile(path.join(target.rootPath, 'folder/removed.txt'), 'old extra');

    const initial = await readOfficeDocumentSnapshot(target, 'report.docx');
    const editor = await acquireFileLock({ workspace: target, path: 'report.docx', lockedByUserId: 'alice', lockedBySessionId: 'human-editor', baseRevisionId: initial.revision.id });
    const locked = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'FILE_LOCKED';
    await assert.rejects(copyFileBetweenWorkspaces('report.docx', '.', true, false, copyOptions), locked);
    await assert.rejects(deleteFile('report.docx', targetOptions), locked);
    await assert.rejects(renameFile('report.docx', 'moved.docx', false, targetOptions), locked);
    await assert.rejects(runWorkspaceUploadWrite({ workspace: target, fileOptions: targetOptions, actorUserId: 'alice', targetPath: 'report.docx', content: copied, write: async () => assert.fail('No direct Office write') }), locked);
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'report.docx')), original);
    await releaseFileLock({ workspace: target, lockId: editor.lock.id, actorUserId: 'alice', actorSessionId: 'human-editor' });

    const folderSnapshot = await readOfficeDocumentSnapshot(target, 'folder/nested.docx');
    const nested = await acquireFileLock({ workspace: target, path: 'folder/nested.docx', lockedByUserId: 'alice', lockedBySessionId: 'nested-editor', baseRevisionId: folderSnapshot.revision.id });
    await assert.rejects(deleteFile('folder', targetOptions), locked);
    await assert.rejects(renameWorkspacePath({ workspace: target, oldPath: 'folder', newPath: 'moved-folder', overwrite: false, fileOptions: targetOptions }), locked);
    await assert.rejects(copyFileBetweenWorkspaces('folder', '.', true, false, copyOptions), locked);
    await releaseFileLock({ workspace: target, lockId: nested.lock.id, actorUserId: 'alice', actorSessionId: 'nested-editor' });
    console.log('PASS: Same-user editor leases protect direct files and selected directory descendants against upload/copy/rename/delete.');

    const direct = await copyFileBetweenWorkspaces('report.docx', '.', true, false, copyOptions);
    assert.equal(direct.collaborationInitialized, true);
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'report.docx')), copied);
    const currentState = await getFileCollaborationState({ workspace: target, path: 'report.docx' });
    assert.notEqual(currentState.lineageId, initial.collaboration.lineageId);
    assert.equal(currentState.activeLock, null);
    assert.deepEqual(await readOfficeVersion({ workspaceId: target.workspaceId, lineageId: initial.collaboration.lineageId!, contentHash: initial.stats.sha256 }), original);
    const replacedFileHistory = await readOfficePathHistory(target, 'report.docx');
    assert.ok(replacedFileHistory.lineages?.some((lineage) => lineage.id === initial.collaboration.lineageId && lineage.status === 'archived'));
    const recoveredFile = await readOfficePathHistory(target, 'report.docx', initial.collaboration.lineageId, initial.stats.sha256);
    assert.ok(typeof recoveredFile.content === 'string');
    assert.deepEqual(Buffer.from(recoveredFile.content.slice(7), 'base64'), original);

    await copyFileBetweenWorkspaces('folder', 'imports', false, false, copyOptions);
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'imports/folder/nested.docx')), copied);
    assert.equal(await fs.readFile(path.join(target.rootPath, 'imports/folder/note.txt'), 'utf8'), 'new note');
    await copyFileBetweenWorkspaces('folder', '.', true, false, copyOptions);
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'folder/nested.docx')), copied);
    await assert.rejects(fs.stat(path.join(target.rootPath, 'folder/removed.txt')), { code: 'ENOENT' });
    assert.deepEqual(await readOfficeVersion({ workspaceId: target.workspaceId, lineageId: folderSnapshot.collaboration.lineageId!, contentHash: folderSnapshot.stats.sha256 }), original);
    const replacedFolderHistory = await readOfficePathHistory(target, 'folder/nested.docx');
    assert.ok(replacedFolderHistory.lineages?.some((lineage) => lineage.id === folderSnapshot.collaboration.lineageId && lineage.status === 'archived'));
    const recoveredNested = await readOfficePathHistory(target, 'folder/nested.docx', folderSnapshot.collaboration.lineageId, folderSnapshot.stats.sha256);
    assert.ok(typeof recoveredNested.content === 'string');
    assert.deepEqual(Buffer.from(recoveredNested.content.slice(7), 'base64'), original);
    console.log('PASS: File/directory copies publish validated DOCX with independent identities and preserve overwritten versions.');

    const beforeFailedCopy = await getFileCollaborationState({ workspace: target, path: 'folder/nested.docx' });
    await fs.writeFile(path.join(target.rootPath, 'folder/keep-on-failure.txt'), 'preserved');
    const originalCopy = fs.cp;
    fs.cp = (async (from, to, options) => {
      await originalCopy(from, to, options);
      if (String(to).endsWith('/target/folder')) throw new Error('Injected copy I/O failure');
    }) as typeof fs.cp;
    try {
      await assert.rejects(copyFileBetweenWorkspaces('folder', '.', true, false, copyOptions), /Injected copy I\/O failure/);
    } finally {
      fs.cp = originalCopy;
    }
    assert.equal(await fs.readFile(path.join(target.rootPath, 'folder/keep-on-failure.txt'), 'utf8'), 'preserved');
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'folder/nested.docx')), copied);
    assert.equal((await getFileCollaborationState({ workspace: target, path: 'folder/nested.docx' })).lineageId, beforeFailedCopy.lineageId);
    assert.deepEqual(await fs.readdir(path.join(target.rootPath, '.canvas-copy-backups')), []);
    await fs.writeFile(path.join(target.rootPath, 'plain.txt'), 'not a document');
    await assert.rejects(renameFile('plain.txt', 'invalid.docx', false, targetOptions), /ZIP|DOCX/);
    assert.equal(await fs.readFile(path.join(target.rootPath, 'plain.txt'), 'utf8'), 'not a document');
    console.log('PASS: An I/O failure after directory replacement restores original files and lineage; invalid DOCX renames leave the source intact.');

    await fs.writeFile(path.join(source.rootPath, 'folder/broken.docx'), 'not a ZIP');
    await assert.rejects(copyFileBetweenWorkspaces('folder', '.', true, false, copyOptions), /ZIP|DOCX/);
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'folder/nested.docx')), copied);
    assert.equal(await fs.readFile(path.join(target.rootPath, 'folder/note.txt'), 'utf8'), 'new note');
    const staged = path.join(dataRoot, 'upload-docx');
    await fs.writeFile(staged, original);
    await runWorkspaceUploadWrite({ workspace: target, fileOptions: targetOptions, actorUserId: 'alice', targetPath: 'new.docx', sourcePath: staged, createOnly: true, write: async () => assert.fail('No direct Office write') });
    await assert.rejects(runWorkspaceUploadWrite({ workspace: target, fileOptions: targetOptions, actorUserId: 'alice', targetPath: 'new.docx', sourcePath: staged, createOnly: true, write: async () => assert.fail('No direct Office write') }));
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'new.docx')), original);
    console.log('PASS: Invalid directory members fail preflight without replacing target content; staged Office uploads preserve create-only behavior.');

    const validArchive = await new JSZip().file('extracted/imported.docx', original).file('extracted/note.txt', 'included').generateAsync({ type: 'nodebuffer' });
    await fs.writeFile(path.join(target.rootPath, 'office.zip'), validArchive);
    const extracted = await extractWorkspaceZip('office.zip', '.', targetOptions);
    assert.deepEqual(extracted.collaborationInitializedPaths, ['extracted/imported.docx']);
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'extracted/imported.docx')), original);
    const invalidArchive = await new JSZip().file('invalid-extract/note.txt', 'must not appear').file('invalid-extract/bad.docx', 'not a ZIP').generateAsync({ type: 'nodebuffer' });
    await fs.writeFile(path.join(target.rootPath, 'invalid.zip'), invalidArchive);
    await assert.rejects(extractWorkspaceZip('invalid.zip', '.', targetOptions), /ZIP|DOCX/);
    await assert.rejects(fs.stat(path.join(target.rootPath, 'invalid-extract')), { code: 'ENOENT' });
    const failingArchive = await new JSZip().file('extract-failure/a.docx', original).file('extract-failure/b.txt', 'fail here').generateAsync({ type: 'nodebuffer' });
    await fs.writeFile(path.join(target.rootPath, 'failure.zip'), failingArchive);
    const originalLink = fs.link;
    fs.link = (async (from, to) => {
      if (String(to).endsWith('/extract-failure/b.txt')) throw new Error('Injected archive I/O failure');
      await originalLink(from, to);
    }) as typeof fs.link;
    try {
      await assert.rejects(extractWorkspaceZip('failure.zip', '.', targetOptions), /Injected archive I\/O failure/);
    } finally {
      fs.link = originalLink;
    }
    await assert.rejects(fs.stat(path.join(target.rootPath, 'extract-failure')), { code: 'ENOENT' });
    const publishedFailureArchive = await new JSZip().file('published-failure/a.docx', original).generateAsync({ type: 'nodebuffer' });
    await fs.writeFile(path.join(target.rootPath, 'published-failure.zip'), publishedFailureArchive);
    let sawPublishedBytes = false;
    fs.link = (async (from, to) => {
      await originalLink(from, to);
      if (String(to).endsWith('/published-failure/a.docx')) {
        assert.deepEqual(await fs.readFile(to), original);
        sawPublishedBytes = true;
        throw new Error('Injected failure after atomic Office publication');
      }
    }) as typeof fs.link;
    try {
      await assert.rejects(extractWorkspaceZip('published-failure.zip', '.', targetOptions), /after atomic Office publication/);
    } finally { fs.link = originalLink; }
    assert.equal(sawPublishedBytes, true);
    await assert.rejects(fs.stat(path.join(target.rootPath, 'published-failure')), { code: 'ENOENT' });
    const failedPublicationState = await getFileCollaborationState({ workspace: target, path: 'published-failure/a.docx' });
    assert.equal(failedPublicationState.lineageId, null);
    console.log('PASS: ZIP extraction uses DOCX publication, rejects invalid Office members before creating paths and rolls back a partially published archive.');

    await runWorkspaceUploadWrite({ workspace: target, fileOptions: targetOptions, actorUserId: 'alice', targetPath: 'trashable.docx', content: original, write: async () => assert.fail('No direct Office write') });
    const trashSnapshot = await readOfficeDocumentSnapshot(target, 'trashable.docx');
    const trashLease = await acquireFileLock({ workspace: target, path: 'trashable.docx', lockedByUserId: 'alice', lockedBySessionId: 'trash-editor', baseRevisionId: trashSnapshot.revision.id });
    const refusedTrash = await trashWorkspacePaths({ workspace: target, paths: ['trashable.docx'], deletedByUserId: 'alice' });
    assert.equal(refusedTrash.failed.length, 1);
    assert.equal(refusedTrash.trashed.length, 0);
    await releaseFileLock({ workspace: target, lockId: trashLease.lock.id, actorUserId: 'alice', actorSessionId: 'trash-editor' });
    const trashed = await trashWorkspacePaths({ workspace: target, paths: ['trashable.docx'], deletedByUserId: 'alice' });
    assert.equal(trashed.trashed.length, 1, JSON.stringify(trashed.failed));
    const entry = trashed.trashed[0];
    await archiveFileCollaborationPaths({ workspace: target, paths: [{ path: entry.originalPath, trashEntryId: entry.id }] });
    await runWorkspaceUploadWrite({ workspace: target, fileOptions: targetOptions, actorUserId: 'alice', targetPath: 'trashable.docx', content: copied, write: async () => assert.fail('No direct Office write') });
    const replacement = await readOfficeDocumentSnapshot(target, 'trashable.docx');
    const replacementLease = await acquireFileLock({ workspace: target, path: 'trashable.docx', lockedByUserId: 'alice', lockedBySessionId: 'restore-editor', baseRevisionId: replacement.revision.id });
    await assert.rejects(restoreWorkspaceTrashEntry({ workspace: target, entryId: entry.id, restoredByUserId: 'alice', overwrite: true }), locked);
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'trashable.docx')), copied);
    await releaseFileLock({ workspace: target, lockId: replacementLease.lock.id, actorUserId: 'alice', actorSessionId: 'restore-editor' });
    await restoreWorkspaceTrashEntry({ workspace: target, entryId: entry.id, restoredByUserId: 'alice', overwrite: true });
    await restoreFileCollaborationPath({ workspace: target, path: entry.originalPath, trashEntryId: entry.id });
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, 'trashable.docx')), original);
    assert.equal((await getFileCollaborationState({ workspace: target, path: 'trashable.docx' })).lineageId, trashSnapshot.collaboration.lineageId);
    console.log('PASS: Real trash/restore operations reject active Office leases and restore the original bytes and identity after release.');

    await fs.unlink(path.join(source.rootPath, 'folder/broken.docx'));
    const remove = fs.rm;
    fs.cp = (async (from, to, options) => {
      await originalCopy(from, to, options);
      if (String(to).endsWith('/target/folder')) throw new Error('Injected copy and compensation failure');
    }) as typeof fs.cp;
    fs.rm = (async (filePath, options) => {
      if (String(filePath).endsWith('/target/folder')) throw new Error('Injected compensation I/O failure');
      await remove(filePath, options);
    }) as typeof fs.rm;
    try {
      await assert.rejects(copyFileBetweenWorkspaces('folder', '.', true, false, copyOptions), /rollback failed/);
    } finally {
      fs.cp = originalCopy;
      fs.rm = remove;
    }
    const retained = await fs.readdir(path.join(target.rootPath, '.canvas-copy-backups'));
    assert.equal(retained.length, 1);
    assert.deepEqual(await fs.readFile(path.join(target.rootPath, '.canvas-copy-backups', retained[0], 'nested.docx')), copied);
    assert.equal(await fs.readFile(path.join(target.rootPath, '.canvas-copy-backups', retained[0], 'keep-on-failure.txt'), 'utf8'), 'preserved');
    console.log('PASS: Failed compensation retains the complete original directory in its private backup.');
  } finally {
    setFileCollaborationConnectionFactoryForTests(null);
    await database.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.dir(error, { depth: 8 }); process.exitCode = 1; });
