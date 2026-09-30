import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { filesystemFileVersion } from '../app/lib/filesystem/file-version';
import { probeWorkspacePathOperation, probeWorkspacePathSelectionOperation } from '../app/lib/files/workspace-operation-path-probe';
import type { WorkspaceFileOperationPreview } from '../app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function context(workspaceId: string, rootPath: string): WorkspaceContext {
  return {
    workspaceId, workspaceType: 'personal', rootPath, legacy: false,
    permissions: {
      canRead: true, canWrite: true, canDelete: true,
      canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false,
    },
  };
}

function plan(kind: 'rename' | 'copy', sourceWorkspaceId: string, destinationWorkspaceId: string,
  sourceIdentity: string): WorkspaceFileOperationPreview {
  const sourcePath = 'Notes/original.md';
  const destinationPath = 'Archive/moved.md';
  return {
    contractVersion: 1, kind, status: 'planned',
    planId: createHash('sha256').update(sourceIdentity).digest('hex'),
    readiness: 'ready', issues: [], previewContents: [],
    pathMappings: [{ sourceWorkspaceId, destinationWorkspaceId, sourcePath, destinationPath, sourceIdentity }],
    linkEdits: [], coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
    expectedPathState: [], collisions: [], recoveryReady: false,
  } as WorkspaceFileOperationPreview;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-path-probe-'));
  try {
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'destination');
  await fs.mkdir(path.join(sourceRoot, 'Notes'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'Archive'), { recursive: true });
  await fs.mkdir(path.join(destinationRoot, 'Archive'), { recursive: true });
  const oldPath = path.join(sourceRoot, 'Notes/original.md');
  const movedPath = path.join(sourceRoot, 'Archive/moved.md');
  await fs.writeFile(oldPath, '[asset](./image.png)');
  const originalVersion = filesystemFileVersion(await fs.stat(oldPath));
  const sourceOptions = { workspace: context('source', sourceRoot) };
  const sameWorkspace = plan('rename', 'source', 'source', originalVersion);
  assert.equal(await probeWorkspacePathOperation({
    plan: sameWorkspace, sourceOptions, destinationOptions: sourceOptions, pathReceiptApplied: false,
  }), 'before');
  await fs.rename(oldPath, movedPath);
  assert.equal(await probeWorkspacePathOperation({
    plan: sameWorkspace, sourceOptions, destinationOptions: sourceOptions, pathReceiptApplied: false,
  }), 'unknown', 'a moved file alone does not prove the metadata and collaboration path phase');
  assert.equal(await probeWorkspacePathOperation({
    plan: sameWorkspace, sourceOptions, destinationOptions: sourceOptions, pathReceiptApplied: true,
  }), 'after');
  await fs.writeFile(oldPath, 'new concurrent file');
  assert.equal(await probeWorkspacePathOperation({
    plan: sameWorkspace, sourceOptions, destinationOptions: sourceOptions, pathReceiptApplied: true,
  }), 'unknown', 'a recreated source makes recovery ambiguous');

  await fs.rm(oldPath);
  await fs.rename(movedPath, oldPath);
  const currentVersion = filesystemFileVersion(await fs.stat(oldPath));
  const copyPlan = plan('copy', 'source', 'destination', currentVersion);
  const destinationOptions = { workspace: context('destination', destinationRoot) };
  assert.equal(await probeWorkspacePathOperation({
    plan: copyPlan, sourceOptions, destinationOptions, pathReceiptApplied: false,
  }), 'before');
  await fs.copyFile(oldPath, path.join(destinationRoot, 'Archive/moved.md'));
  assert.equal(await probeWorkspacePathOperation({
    plan: copyPlan, sourceOptions, destinationOptions, pathReceiptApplied: true,
  }), 'after');
  const secondSource = path.join(sourceRoot, 'Notes/second.md');
  await fs.writeFile(secondSource, 'second');
  const secondIdentity = filesystemFileVersion(await fs.stat(secondSource));
  copyPlan.pathMappings.push({ sourceWorkspaceId: 'source', destinationWorkspaceId: 'destination',
    sourcePath: 'Notes/second.md', destinationPath: 'Archive/second.md', sourceIdentity: secondIdentity });
  assert.equal(await probeWorkspacePathSelectionOperation({ plan: copyPlan,
    selection: { sourcePath: 'Notes/original.md', destinationPath: 'Archive/moved.md' },
    sourceOptions, destinationOptions, pathReceiptApplied: true,
  }), 'after');
  assert.equal(await probeWorkspacePathSelectionOperation({ plan: copyPlan,
    selection: { sourcePath: 'Notes/second.md', destinationPath: 'Archive/second.md' },
    sourceOptions, destinationOptions, pathReceiptApplied: false,
  }), 'before', 'an untouched second selection remains independently replayable');
  await fs.copyFile(secondSource, path.join(destinationRoot, 'Archive/second.md'));
  assert.equal(await probeWorkspacePathSelectionOperation({ plan: copyPlan,
    selection: { sourcePath: 'Notes/second.md', destinationPath: 'Archive/second.md' },
    sourceOptions, destinationOptions, pathReceiptApplied: false,
  }), 'unknown', 'an unreceipted copied selection is not auto-committed after a crash');
  console.log('workspace-operation-path-probe-test: ok');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
