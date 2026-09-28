import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildWorkspaceFileOperationPreview } from '../app/lib/markdown/workspace-file-operation-preview';
import { assessWorkspaceRenameLinks } from '../app/lib/markdown/workspace-file-operation-status';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

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
    console.log('workspace-file-operation-preview-test: ok');
  } finally {
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
