import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-office-aliases-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  try {
    const { createEmptyDocx } = await import('../app/lib/office/empty-docx');
    const { writeWorkspaceFileContent } = await import('../app/lib/files/write-service');
    const { readOfficeDocumentSnapshot } = await import('../app/lib/office/document-service');
    const { acquireFileLock, releaseFileLock, isDocxPath, getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const { writeFile, writeFileIfAbsent, replaceWorkspaceFileFromPath, deleteFile, renameFile } = await import('../app/lib/filesystem/workspace-files');
    const { renameWorkspacePath } = await import('../app/lib/files/rename-service');
    const { runWorkspaceUploadWrite } = await import('../app/lib/files/workspace-upload-flow');
    const { extractWorkspaceZip } = await import('../app/lib/filesystem/zip-extraction');
    const original = await createEmptyDocx();
    const staged = path.join(dataRoot, 'staged-content');
    await fs.writeFile(staged, 'not a document');
    const aliases = ['folder/report.docx ', './folder//report.docx', 'folder\\report.docx', 'folder/report.docx/', ' folder/report.docx\t', 'folder/report.docx/.'];
    for (const workspaceType of ['personal', 'organization'] as const) {
      const workspace: WorkspaceContext = {
        workspaceId: `aliases-${workspaceType}`, workspaceType, rootPath: path.join(dataRoot, workspaceType),
        organizationId: workspaceType === 'personal' ? null : 'org', ownerUserId: workspaceType === 'personal' ? 'alice' : null, legacy: false,
        permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
      };
      const fileOptions = { workspace, mutationActorUserId: 'alice' };
      await fs.mkdir(path.join(workspace.rootPath, 'folder'), { recursive: true });
      const initial = await writeWorkspaceFileContent({ workspace, fileOptions, actorUserId: 'alice', path: 'folder/report.docx', content: original, createOnly: true });
      const editor = await acquireFileLock({ workspace, path: 'folder/report.docx', lockedByUserId: 'alice', lockedBySessionId: 'editor', baseRevisionId: initial.revision.id });
      for (const alias of aliases) {
        assert.equal(isDocxPath(alias), true, alias);
        await assert.rejects(writeWorkspaceFileContent({ workspace, fileOptions, actorUserId: 'alice', path: alias, content: 'not a ZIP' }), { code: 'DOCX_INVALID_PACKAGE' });
        await assert.rejects(writeWorkspaceFileContent({ workspace, fileOptions, actorUserId: 'alice', actorSessionId: 'other-editor', path: alias, content: original,
          expectedSha256: initial.stats.sha256, baseRevisionId: initial.revision.id }), { code: 'FILE_LOCKED' });
        await assert.rejects(acquireFileLock({ workspace, path: alias, lockedByUserId: 'alice', lockedBySessionId: 'other-editor' }), { code: 'FILE_LOCKED' });
        await assert.rejects(writeFile(alias, 'unsafe', fileOptions), { code: 'OFFICE_PUBLICATION_REQUIRED' });
        await assert.rejects(writeFileIfAbsent(alias, 'unsafe', fileOptions), { code: 'OFFICE_PUBLICATION_REQUIRED' });
        await assert.rejects(replaceWorkspaceFileFromPath(staged, alias, fileOptions), { code: 'OFFICE_PUBLICATION_REQUIRED' });
        await assert.rejects(deleteFile(alias, fileOptions), { code: 'FILE_LOCKED' });
        await assert.rejects(renameFile(alias, 'moved.docx', false, fileOptions), { code: 'FILE_LOCKED' });
        const saved = await writeWorkspaceFileContent({ workspace, fileOptions, actorUserId: 'alice', actorSessionId: 'editor', lockId: editor.lock.id,
          path: alias, content: original, expectedSha256: initial.stats.sha256, baseRevisionId: initial.revision.id });
        assert.equal(saved.path, 'folder/report.docx');
        assert.equal(saved.revision.lineageId, initial.revision.lineageId);
      }
      assert.deepEqual(await fs.readFile(path.join(workspace.rootPath, 'folder/report.docx')), original);
      await fs.symlink('folder', path.join(workspace.rootPath, 'alias'), 'dir');
      await fs.symlink('folder/report.docx', path.join(workspace.rootPath, 'document-link.txt'));
      await assert.rejects(acquireFileLock({ workspace, path: 'alias/report.docx', lockedByUserId: 'alice', lockedBySessionId: 'alias-editor' }), { code: 'WORKSPACE_PATH_ALIAS' });
      await assert.rejects(writeWorkspaceFileContent({ workspace, fileOptions, actorUserId: 'alice', path: 'alias/report.docx', content: original,
        expectedSha256: initial.stats.sha256, baseRevisionId: initial.revision.id }), { code: 'WORKSPACE_PATH_ALIAS' });
      await assert.rejects(deleteFile('alias/report.docx', fileOptions), { code: 'WORKSPACE_PATH_ALIAS' });
      await assert.rejects(deleteFile('alias', fileOptions), { code: 'WORKSPACE_PATH_ALIAS' });
      await assert.rejects(renameFile('document-link.txt', 'moved.docx', false, fileOptions), { code: 'WORKSPACE_PATH_ALIAS' });
      const differentlyCased = await fs.lstat(path.join(workspace.rootPath, 'Folder/report.docx')).catch(() => null);
      if (differentlyCased) {
        await assert.rejects(acquireFileLock({ workspace, path: 'Folder/report.docx', lockedByUserId: 'alice', lockedBySessionId: 'case-editor' }), { code: 'WORKSPACE_PATH_ALIAS' });
        await assert.rejects(deleteFile('Folder', fileOptions), { code: 'WORKSPACE_PATH_ALIAS' });
      }
      await releaseFileLock({ workspace, lockId: editor.lock.id, actorUserId: 'alice', actorSessionId: 'editor' });
      await assert.rejects(writeWorkspaceFileContent({ workspace, fileOptions, actorUserId: 'alice', path: 'folder/report.docx ', content: original }), { code: 'FILE_REVISION_REQUIRED' });
      await assert.rejects(runWorkspaceUploadWrite({ workspace, fileOptions, actorUserId: 'alice', targetPath: 'folder/report.docx ', content: Buffer.from('invalid'), write: async () => assert.fail('Office upload bypass') }), { code: 'DOCX_INVALID_PACKAGE' });
      assert.equal((await getFileCollaborationState({ workspace, path: 'folder/report.docx' })).activeLock, null);
      await fs.writeFile(path.join(workspace.rootPath, 'plain.txt'), 'original plain file');
      await assert.rejects(renameWorkspacePath({ workspace, fileOptions, oldPath: 'plain.txt', newPath: 'invalid.docx ', overwrite: false }), { code: 'DOCX_INVALID_PACKAGE' });
      assert.equal(await fs.readFile(path.join(workspace.rootPath, 'plain.txt'), 'utf8'), 'original plain file');
      const zip = await new JSZip().file('alias-extract/bad.docx ', 'invalid').generateAsync({ type: 'nodebuffer' });
      await fs.writeFile(path.join(workspace.rootPath, 'aliases.zip'), zip);
      await assert.rejects(extractWorkspaceZip('aliases.zip', '.', fileOptions), { code: 'DOCX_INVALID_PACKAGE' });
      await assert.rejects(fs.stat(path.join(workspace.rootPath, 'alias-extract')), { code: 'ENOENT' });
      const aliasZip = await new JSZip().file('new.docx', original).generateAsync({ type: 'nodebuffer' });
      await fs.writeFile(path.join(workspace.rootPath, 'symlink.zip'), aliasZip);
      await assert.rejects(extractWorkspaceZip('symlink.zip', 'alias', fileOptions), { code: 'WORKSPACE_PATH_ALIAS' });
      await assert.rejects(fs.stat(path.join(workspace.rootPath, 'folder/new.docx')), { code: 'ENOENT' });
      const foreign = { ...workspace, workspaceId: 'foreign', rootPath: path.join(dataRoot, 'foreign') };
      const callerBuffer = Buffer.from(original);
      const creating = writeWorkspaceFileContent({ workspace, fileOptions: { workspace: foreign }, actorUserId: 'alice', path: 'bound.docx ', content: callerBuffer, createOnly: true });
      callerBuffer.fill(0);
      await creating;
      assert.deepEqual((await readOfficeDocumentSnapshot(workspace, 'bound.docx')).content, original);
      await assert.rejects(fs.stat(path.join(foreign.rootPath, 'bound.docx')), { code: 'ENOENT' });
      console.log(`PASS ${workspaceType}: canonical spelling, whitespace/backslash aliases, package/lease/capability gates, symlink/case identity, upload/rename/extraction, workspace binding and caller Buffer snapshot`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
