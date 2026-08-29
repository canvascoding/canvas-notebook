import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-atomic-write-'));
  const workspace: WorkspaceContext = {
    workspaceId: 'atomic-write-test',
    workspaceType: 'personal',
    rootPath: root,
    rootRelativePath: '.',
    displayName: 'Atomic write test',
    status: 'active',
    organizationId: null,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };

  try {
    const { WorkspaceFileRevisionError, assertWorkspaceFileRevisionUnchanged, getWorkspaceFileRevision } = await import('../app/lib/files/revision-guard');
    const {
      replaceWorkspaceFileFromPath,
      withWorkspaceFileMutationLocks,
      writeFile,
    } = await import('../app/lib/filesystem/workspace-files');
    await fs.writeFile(path.join(root, 'deck.md'), 'before\n', { mode: 0o640 });
    let beforeReplaceCalled = false;
    await writeFile('deck.md', 'after\n', { workspace }, async () => {
      beforeReplaceCalled = true;
    });

    assert.equal(beforeReplaceCalled, true);
    assert.equal(await fs.readFile(path.join(root, 'deck.md'), 'utf8'), 'after\n');
    assert.equal((await fs.stat(path.join(root, 'deck.md'))).mode & 0o777, 0o640);
    assert.equal((await fs.readdir(root)).some((name) => name.includes('.canvas-write-')), false);

    let releaseFirstWrite!: () => void;
    const firstWriteCanFinish = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let firstWriteIsReady!: () => void;
    const firstWriteReady = new Promise<void>((resolve) => { firstWriteIsReady = resolve; });
    let secondWriteReachedReplace = false;
    const firstWrite = writeFile('deck.md', 'first\n', { workspace }, async () => {
      firstWriteIsReady();
      await firstWriteCanFinish;
    });
    await firstWriteReady;
    const secondWrite = writeFile('deck.md', 'second\n', { workspace }, async () => {
      secondWriteReachedReplace = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(secondWriteReachedReplace, false);
    releaseFirstWrite();
    await Promise.all([firstWrite, secondWrite]);
    assert.equal(secondWriteReachedReplace, true);
    assert.equal(await fs.readFile(path.join(root, 'deck.md'), 'utf8'), 'second\n');

    await fs.mkdir(path.join(root, 'folder'));
    let releaseDirectoryMutation!: () => void;
    const directoryMutationCanFinish = new Promise<void>((resolve) => { releaseDirectoryMutation = resolve; });
    let directoryMutationReady!: () => void;
    const directoryMutationReadySignal = new Promise<void>((resolve) => { directoryMutationReady = resolve; });
    const directoryMutation = withWorkspaceFileMutationLocks(['folder'], { workspace }, async () => {
      directoryMutationReady();
      await directoryMutationCanFinish;
    });
    await directoryMutationReadySignal;
    let childWriteReachedReplace = false;
    const childWrite = writeFile('folder/child.md', 'child\n', { workspace }, async () => {
      childWriteReachedReplace = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(childWriteReachedReplace, false);
    releaseDirectoryMutation();
    await Promise.all([directoryMutation, childWrite]);
    assert.equal(childWriteReachedReplace, true);

    let releaseBackslashMutation!: () => void;
    const backslashMutationCanFinish = new Promise<void>((resolve) => { releaseBackslashMutation = resolve; });
    let backslashMutationReady!: () => void;
    const backslashMutationReadySignal = new Promise<void>((resolve) => { backslashMutationReady = resolve; });
    const backslashMutation = withWorkspaceFileMutationLocks(['folder'], { workspace }, async () => {
      backslashMutationReady();
      await backslashMutationCanFinish;
    });
    await backslashMutationReadySignal;
    let backslashChildMutationRan = false;
    const backslashChildMutation = withWorkspaceFileMutationLocks(['folder\\child.md'], { workspace }, async () => {
      backslashChildMutationRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(backslashChildMutationRan, false);
    releaseBackslashMutation();
    await Promise.all([backslashMutation, backslashChildMutation]);
    assert.equal(backslashChildMutationRan, true);

    let releaseRootMutation!: () => void;
    const rootMutationCanFinish = new Promise<void>((resolve) => { releaseRootMutation = resolve; });
    let rootMutationReady!: () => void;
    const rootMutationReadySignal = new Promise<void>((resolve) => { rootMutationReady = resolve; });
    const rootMutation = withWorkspaceFileMutationLocks(['.'], { workspace }, async () => {
      rootMutationReady();
      await rootMutationCanFinish;
    });
    await rootMutationReadySignal;
    let rootChildMutationRan = false;
    const rootChildMutation = withWorkspaceFileMutationLocks(['root-child.md'], { workspace }, async () => {
      rootChildMutationRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(rootChildMutationRan, false);
    releaseRootMutation();
    await Promise.all([rootMutation, rootChildMutation]);
    assert.equal(rootChildMutationRan, true);

    const uploadSource = path.join(root, 'upload-source.md');
    await fs.writeFile(uploadSource, 'uploaded\n');
    let releaseUploadReplace!: () => void;
    const uploadReplaceCanFinish = new Promise<void>((resolve) => { releaseUploadReplace = resolve; });
    let uploadReplaceReady!: () => void;
    const uploadReplaceReadySignal = new Promise<void>((resolve) => { uploadReplaceReady = resolve; });
    let overlappingWriteReachedReplace = false;
    const uploadReplace = replaceWorkspaceFileFromPath(
      uploadSource,
      'deck.md',
      { workspace },
      async () => {
        uploadReplaceReady();
        await uploadReplaceCanFinish;
      },
    );
    await uploadReplaceReadySignal;
    const overlappingWrite = writeFile('deck.md', 'newer\n', { workspace }, async () => {
      overlappingWriteReachedReplace = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(overlappingWriteReachedReplace, false);
    releaseUploadReplace();
    await Promise.all([uploadReplace, overlappingWrite]);
    assert.equal(overlappingWriteReachedReplace, true);
    assert.equal(await fs.readFile(path.join(root, 'deck.md'), 'utf8'), 'newer\n');

    const observedDeckRevision = await getWorkspaceFileRevision('deck.md', { workspace });
    await writeFile('deck.md', 'changed again\n', { workspace });
    await assert.rejects(
      () => assertWorkspaceFileRevisionUnchanged({
        path: 'deck.md',
        expectedRevision: observedDeckRevision,
        options: { workspace },
      }),
      (error) => error instanceof WorkspaceFileRevisionError && error.code === 'FILE_REVISION_CONFLICT',
    );
    await writeFile('created-after-check.md', 'created\n', { workspace });
    await assert.rejects(
      () => assertWorkspaceFileRevisionUnchanged({
        path: 'created-after-check.md',
        expectedRevision: null,
        options: { workspace },
      }),
      (error) => error instanceof WorkspaceFileRevisionError && error.code === 'FILE_REVISION_CONFLICT',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log('atomic-workspace-write-test: ok');
}

void main();
