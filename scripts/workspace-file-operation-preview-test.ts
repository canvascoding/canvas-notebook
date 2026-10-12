import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { mock } from 'node:test';
import os from 'node:os';
import path from 'node:path';

import { assertFreshWorkspaceFileOperationPlan, buildWorkspaceFileOperationPreview as buildFilePreview, buildWorkspacePlannerSnapshot, WorkspacePreviewBlockedError, WorkspacePreviewStaleError, WorkspacePreviewUnavailableError } from '../app/lib/markdown/workspace-file-operation-preview';
import { assessWorkspaceRenameLinks } from '../app/lib/markdown/workspace-file-operation-status';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { listDirectory } from '../app/lib/filesystem/workspace-files';
import { getCachedFileReferenceEntries, invalidateFileReferenceCache } from '../app/lib/filesystem/file-reference-cache';

const buildWorkspaceFileOperationPreview = (input: Parameters<typeof buildFilePreview>[0]) =>
  buildFilePreview(input, { buildSnapshot: buildWorkspacePlannerSnapshot });

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-file-operation-preview-'));
  const previousDataRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = root;
  const workspaceRoot = path.join(root, 'workspace');
  const workspace: WorkspaceContext = {
    workspaceId: 'preview-workspace', workspaceType: 'personal', rootPath: workspaceRoot,
    rootRelativePath: 'workspace', displayName: 'Preview', status: 'active',
    organizationId: 'preview-org', ownerUserId: 'preview-user', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true },
  };

  try {
    await mkdir(path.join(workspaceRoot, 'Notes'), { recursive: true });
    await mkdir(path.join(workspaceRoot, 'Archive'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'Notes', 'start.md'), '[Image](./chart.png)');
    await writeFile(path.join(workspaceRoot, 'Notes', 'chart.png'), Buffer.from([0, 255, 0]));

    const request = {
      sourceWorkspaceId: workspace.workspaceId,
      destinationWorkspaceId: workspace.workspaceId,
      sourceOptions: { workspace }, destinationOptions: { workspace },
    };
    const rename = await buildWorkspaceFileOperationPreview({
      ...request, kind: 'rename', selections: [{ sourcePath: 'Notes/chart.png', destinationPath: 'Notes/new-chart.png' }],
    });
    assert.equal(rename.readiness, 'ready');
    assert.equal(rename.linkEdits.length, 1);
    assert.equal(rename.linkEdits[0].nextTargetLiteral, './new-chart.png');
    assert.equal(rename.previewContents[0].content, '[Image](./new-chart.png)');
    assert.doesNotThrow(() => assertFreshWorkspaceFileOperationPlan(rename, rename.planId));
    assert.throws(() => assertFreshWorkspaceFileOperationPlan(rename, 'old-plan'), WorkspacePreviewStaleError);
    assert.equal((await readFile(path.join(workspaceRoot, 'Notes', 'start.md'), 'utf8')), '[Image](./chart.png)', 'dry run cannot write');

    const move = await buildWorkspaceFileOperationPreview({
      ...request, kind: 'move', selections: [{ sourcePath: 'Notes/start.md', destinationPath: 'Archive/start.md' }],
    });
    assert.equal(move.previewContents[0].content, '[Image](../Notes/chart.png)');

    const copy = await buildWorkspaceFileOperationPreview({
      ...request, kind: 'copy', selections: [{ sourcePath: 'Notes', destinationPath: 'Archive/Notes' }],
    });
    assert.equal(copy.pathMappings.length, 3);
    assert.equal(copy.readiness, 'ready');

    await mkdir(path.join(workspaceRoot, 'Archive', 'Notes'));
    const collisionCopy = await buildWorkspaceFileOperationPreview({
      ...request, kind: 'copy', renameOnCollision: true,
      selections: [{ sourcePath: 'Notes', destinationPath: 'Archive/Notes' }],
    });
    assert.equal(collisionCopy.pathMappings.find((mapping) => mapping.sourcePath === 'Notes')?.destinationPath,
      'Archive/Notes (1)');
    const blockedCopy = await buildWorkspaceFileOperationPreview({
      ...request, kind: 'copy', selections: [{ sourcePath: 'Notes', destinationPath: 'Archive/Notes' }],
    });
    assert.equal(blockedCopy.readiness, 'blocked');
    assert.throws(() => assertFreshWorkspaceFileOperationPlan(blockedCopy, blockedCopy.planId), WorkspacePreviewBlockedError);

    const index = buildWorkspaceLinkIndexFromDocuments(
      [{ path: 'Notes/start.md', content: '[Image](./chart.png)' }], new Date(0),
      ['Notes/start.md', 'Notes/chart.png'], [],
    );
    const result = { updatedFiles: [], updatedLinks: 0, warnings: [] };
    const partial = assessWorkspaceRenameLinks({ index, oldPath: 'Notes/chart.png', newPath: 'Notes/new-chart.png', updateLinks: true, result });
    assert.equal(partial.status, 'partial', 'binary target with Markdown incoming link is not a complete rename');
    assert.match(partial.warnings.join(' '), /current rename writer handles incoming Wiki links/u);
    assert.equal(assessWorkspaceRenameLinks({ index: null, oldPath: 'Notes/chart.png', newPath: 'Notes/new-chart.png', updateLinks: true,
      result, indexError: 'unavailable' }).status, 'incomplete');
    assert.equal(assessWorkspaceRenameLinks({ index, oldPath: 'Notes/chart.png', newPath: 'Notes/new-chart.png', updateLinks: false,
      result }).status, 'incomplete');

    const wikiIndex = buildWorkspaceLinkIndexFromDocuments(
      [{ path: 'Notes/start.md', content: '![[chart.png]]' }], new Date(0),
      ['Notes/start.md', 'Notes/chart.png'], [],
    );
    const updatedWiki = assessWorkspaceRenameLinks({ index: wikiIndex, oldPath: 'Notes/chart.png',
      newPath: 'Notes/new-chart.png', updateLinks: true,
      result: { updatedFiles: ['Notes/start.md'], updatedLinks: 1, warnings: [] } });
    assert.equal(updatedWiki.status, 'incomplete', 'writer counts do not prove semantic link validity');
    assert.match(updatedWiki.warnings.join(' '), /not reparsed/u);

    const sourceContent = '[[B]]\n[link](B.md)\n';
    await writeFile(path.join(workspaceRoot, 'A.md'), sourceContent);
    await writeFile(path.join(workspaceRoot, 'B.md'), '# B\n');
    await mkdir(path.join(workspaceRoot, 'Restricted', 'deep'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'Restricted', 'deep', 'incoming.md'), '[[B]]');
    const faultRoot = await fs.realpath(workspaceRoot);
    const syntheticRename = { ...request, kind: 'rename' as const,
      selections: [{ sourcePath: 'B.md', destinationPath: 'C.md' }] };

    for (const code of ['EACCES', 'EPERM', 'ENOENT']) {
      const scanError = Object.assign(new Error(`synthetic ${code}`), { code });
      const failureType = code === 'ENOENT' ? WorkspacePreviewStaleError : WorkspacePreviewUnavailableError;
      const originalReaddir = fs.readdir;
      const fault = mock.method(fs, 'readdir', (directory: unknown, ...args: unknown[]) => {
        if (String(directory) === path.join(faultRoot, 'Restricted', 'deep')) throw scanError;
        return Reflect.apply(originalReaddir, fs, [directory, ...args]);
      });
      try {
        await assert.rejects(buildWorkspacePlannerSnapshot(workspace.workspaceId, { workspace }), failureType);
        await assert.rejects(buildWorkspaceFileOperationPreview(syntheticRename), failureType,
          'an unreadable subtree must never produce a ready rename preview');
        await assert.rejects(getCachedFileReferenceEntries(true, { workspace }), (error) => error === scanError);
      } finally { fault.mock.restore(); invalidateFileReferenceCache({ workspace }); }
      assert.equal(await readFile(path.join(workspaceRoot, 'A.md'), 'utf8'), sourceContent);
      assert.equal(await readFile(path.join(workspaceRoot, 'B.md'), 'utf8'), '# B\n');

      const originalStat = fs.stat;
      const metadataFault = mock.method(fs, 'stat', (filePath: unknown, ...args: unknown[]) => {
        if (String(filePath) === path.join(faultRoot, 'A.md')) throw scanError;
        return Reflect.apply(originalStat, fs, [filePath, ...args]);
      });
      try {
        assert.equal((await listDirectory('.', { workspace })).some((entry) => entry.path === 'A.md'), false,
          'ordinary browser listings retain their existing best-effort metadata behavior');
        await assert.rejects(listDirectory('.', { workspace, strictMetadata: true }), (error) => error === scanError);
        await assert.rejects(getCachedFileReferenceEntries(true, { workspace }), (error) => error === scanError,
          'the link catalogue must not silently lose a child whose stat fails');
        await assert.rejects(buildWorkspaceFileOperationPreview(syntheticRename), failureType);
      } finally { metadataFault.mock.restore(); invalidateFileReferenceCache({ workspace }); }
    }

    const originalReadFile = fs.readFile;
    const sourceFault = mock.method(fs, 'readFile', (filePath: unknown, ...args: unknown[]) => {
      if (String(filePath) === path.join(faultRoot, 'A.md')) {
        throw Object.assign(new Error('synthetic unreadable source'), { code: 'EACCES' });
      }
      return Reflect.apply(originalReadFile, fs, [filePath, ...args]);
    });
    try {
      const unreadableSource = await buildWorkspaceFileOperationPreview(syntheticRename);
      assert.equal(unreadableSource.readiness, 'blocked');
      assert.equal(unreadableSource.coverage.complete, false);
      assert.deepEqual(unreadableSource.coverage.omittedSources, [{ path: 'A.md', reason: 'source-unreadable' }]);
      assert.throws(() => assertFreshWorkspaceFileOperationPlan(unreadableSource, unreadableSource.planId), WorkspacePreviewBlockedError);
    } finally { sourceFault.mock.restore(); }
    assert.equal(await readFile(path.join(workspaceRoot, 'A.md'), 'utf8'), sourceContent);
    assert.equal(await readFile(path.join(workspaceRoot, 'B.md'), 'utf8'), '# B\n');
    assert.equal((await buildWorkspaceFileOperationPreview(syntheticRename)).readiness, 'ready',
      'a reliable retry can certify the rename after transient read failures recover');
    console.log('workspace-file-operation-preview-test: ok');
  } finally {
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
