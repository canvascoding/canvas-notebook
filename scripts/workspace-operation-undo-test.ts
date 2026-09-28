import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureWorkspaceOperationBackup } from '../app/lib/files/workspace-operation-backup';
import type { WorkspaceOperationStepRecord } from '../app/lib/files/workspace-operation-journal';
import { assertInverseLinks, assertUnchangedMovedPath, operationLinkStepKey, operationUndoId,
  WorkspaceOperationUndoError } from '../app/lib/files/workspace-operation-undo';
import type { WorkspaceFileOperationPreview } from '../app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function workspace(rootPath: string): WorkspaceContext {
  return {
    workspaceId: 'undo-test', workspaceType: 'personal', rootPath,
    organizationId: null, ownerUserId: 'tester', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true,
      canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true },
  };
}

async function expectConflict(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof WorkspaceOperationUndoError
    && error.code === 'UNDO_CONFLICT');
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-op-undo-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataRoot;
  try {
    const rootPath = path.join(dataRoot, 'workspaces', 'undo-test', 'files');
    await fs.mkdir(path.join(rootPath, 'folder', 'empty'), { recursive: true });
    await fs.writeFile(path.join(rootPath, 'folder', 'index.md'), '[Target](./target.md)\n');
    await fs.writeFile(path.join(rootPath, 'folder', 'target.md'), '# Target\n');
    const context = workspace(rootPath);
    const backup = await captureWorkspaceOperationBackup({ workspace: context, path: 'folder',
      operationId: 'undo_test_operation' });
    await fs.rename(path.join(rootPath, 'folder'), path.join(rootPath, 'moved'));
    await assertUnchangedMovedPath({ workspace: context, destinationPath: 'moved', backup, linkSteps: [] });

    const rewritten = '[Target](./renamed.md)\n';
    await fs.writeFile(path.join(rootPath, 'moved', 'index.md'), rewritten);
    const linkStep: WorkspaceOperationStepRecord = {
      operationId: 'undo_test_operation', stepKey: operationLinkStepKey('undo-test', 'moved/index.md'),
      phase: 'link', status: 'applied', beforeFence: hash('[Target](./target.md)\n'),
      afterFence: hash(rewritten), backupRef: null, receiptJson: '{}', createdAt: 1, updatedAt: 1,
    };
    await assertUnchangedMovedPath({ workspace: context, destinationPath: 'moved', backup,
      linkSteps: [linkStep] });
    await expectConflict(() => assertUnchangedMovedPath({ workspace: context,
      destinationPath: 'moved', backup, linkSteps: [{ ...linkStep, beforeFence: hash('other') }] }));
    const inverse = {
      readiness: 'ready',
      previewContents: [{ workspaceId: 'undo-test', path: 'folder/index.md',
        content: '[Target](./target.md)\n' }],
      linkEdits: [{ sourceWorkspaceId: 'undo-test', sourcePathBefore: 'moved/index.md',
        destinationWorkspaceId: 'undo-test', sourcePathAfter: 'folder/index.md',
        expectedContentHash: hash(rewritten) }],
    } as WorkspaceFileOperationPreview;
    const original = { steps: [linkStep] } as unknown as Parameters<typeof assertInverseLinks>[0];
    assert.doesNotThrow(() => assertInverseLinks(original, inverse));
    assert.throws(() => assertInverseLinks(original, { ...inverse,
      previewContents: [{ workspaceId: 'undo-test', path: 'folder/index.md',
        content: '[Target](target.md)\n' }] }), WorkspaceOperationUndoError);
    assert.throws(() => assertInverseLinks({ steps: [] } as unknown as typeof original, inverse),
      WorkspaceOperationUndoError);
    await expectConflict(() => assertUnchangedMovedPath({ workspace: context,
      destinationPath: 'moved', backup, linkSteps: [] }));

    await fs.writeFile(path.join(rootPath, 'moved', 'target.md'), '# Concurrent edit\n');
    await expectConflict(() => assertUnchangedMovedPath({ workspace: context,
      destinationPath: 'moved', backup, linkSteps: [linkStep] }));
    await fs.writeFile(path.join(rootPath, 'moved', 'target.md'), '# Target\n');
    await fs.writeFile(path.join(rootPath, 'moved', 'extra.md'), '# Added\n');
    await expectConflict(() => assertUnchangedMovedPath({ workspace: context,
      destinationPath: 'moved', backup, linkSteps: [linkStep] }));
    await fs.unlink(path.join(rootPath, 'moved', 'extra.md'));
    await fs.symlink(path.join(rootPath, 'moved', 'target.md'), path.join(rootPath, 'moved', 'extra.md'));
    await expectConflict(() => assertUnchangedMovedPath({ workspace: context,
      destinationPath: 'moved', backup, linkSteps: [linkStep] }));
    assert.equal(operationUndoId('original-operation'), operationUndoId('original-operation'));
    assert.notEqual(operationUndoId('original-operation'), operationUndoId('other-operation'));
    console.log('workspace operation undo: exact snapshot, journaled links, concurrent edits, extra paths, symlinks OK');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
