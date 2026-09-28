import 'server-only';

import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import type { WorkspaceOperationBackup, WorkspaceOperationBackupEntry } from './workspace-operation-backup';
import type { WorkspaceOperationStepRecord } from './workspace-operation-journal';
import type { WorkspaceOperationWithSteps } from './workspace-operation-journal';
import type { WorkspaceFileOperationPreview } from '@/app/lib/markdown/workspace-file-operation-planner';
import { groupWorkspaceLinkWrites } from '@/app/lib/markdown/workspace-link-write-groups';
import { assertWorkspacePathHasNoAliases, resolveExistingWorkspacePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export class WorkspaceOperationUndoError extends Error {
  readonly status = 409;
  constructor(readonly code: 'UNDO_UNAVAILABLE' | 'UNDO_CONFLICT', message: string) {
    super(message);
    this.name = 'WorkspaceOperationUndoError';
  }
}

function fail(code: WorkspaceOperationUndoError['code'], message: string): never {
  throw new WorkspaceOperationUndoError(code, message);
}

export function operationLinkStepKey(workspaceId: string, pathValue: string): string {
  return `link:${createHash('sha256').update(JSON.stringify([workspaceId, pathValue])).digest('hex')}`;
}

export function operationUndoId(originalOperationId: string): string {
  return createHash('sha256').update(JSON.stringify(['workspace-operation-undo-v1', originalOperationId])).digest('hex');
}

/** An inverse is an exact undo only when it restores every original Markdown byte. */
export function assertInverseLinks(original: WorkspaceOperationWithSteps,
  inverse: WorkspaceFileOperationPreview): void {
  const originalSteps = new Map(original.steps.filter((step) => step.phase === 'link')
    .map((step) => [step.stepKey, step]));
  const groups = groupWorkspaceLinkWrites(inverse);
  if (groups.length !== originalSteps.size) {
    fail('UNDO_CONFLICT', 'Links were added, removed, or changed after the original move.');
  }
  for (const group of groups) {
    const key = operationLinkStepKey(group.sourceWorkspaceId, group.sourcePathBefore);
    const step = originalSteps.get(key);
    if (!step || step.status !== 'applied' || step.afterFence !== group.beforeSha256
      || step.beforeFence !== group.afterSha256) {
      fail('UNDO_CONFLICT', `Markdown links no longer match the original operation: ${group.sourcePathBefore}`);
    }
    originalSteps.delete(key);
  }
  if (originalSteps.size !== 0) fail('UNDO_CONFLICT', 'An original Markdown link can no longer be restored exactly.');
}

async function hashWorkspaceFile(filename: string): Promise<string> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail('UNDO_CONFLICT', 'A file in the moved path is no longer a regular file.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, count);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      count += result.bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail('UNDO_CONFLICT', 'A file changed during the undo check.');
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}

/** Compare a moved tree with its durable pre-move snapshot, allowing only journaled link writes. */
export async function assertUnchangedMovedPath(input: {
  workspace: WorkspaceContext;
  destinationPath: string;
  backup: WorkspaceOperationBackup;
  linkSteps: readonly WorkspaceOperationStepRecord[];
}): Promise<void> {
  const { workspace, destinationPath, backup, linkSteps } = input;
  if (backup.workspaceId !== workspace.workspaceId || backup.workspaceType !== workspace.workspaceType
    || backup.organizationId !== (workspace.organizationId ?? null)) {
    fail('UNDO_UNAVAILABLE', 'The operation snapshot belongs to a different workspace.');
  }
  await assertWorkspacePathHasNoAliases(workspace, destinationPath, { readOnly: true });
  let root: string;
  try { root = await resolveExistingWorkspacePath(workspace, destinationPath); }
  catch { return fail('UNDO_CONFLICT', 'The moved path is missing or unsafe.'); }

  const expected = new Map<string, WorkspaceOperationBackupEntry>(backup.entries.map((entry) => [entry.path, entry]));
  if (expected.size !== backup.entries.length) fail('UNDO_UNAVAILABLE', 'The operation snapshot contains duplicate entries.');
  const linkByKey = new Map(linkSteps.map((step) => [step.stepKey, step]));
  const seen = new Set<string>();
  const visit = async (filename: string, relative: string): Promise<void> => {
    const entry = expected.get(relative);
    if (!entry || seen.has(relative)) fail('UNDO_CONFLICT', 'The moved path contains unexpected entries.');
    seen.add(relative);
    const stat = await fs.lstat(filename);
    if (entry.type === 'directory') {
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNDO_CONFLICT', 'A moved directory changed type.');
      const children = (await fs.readdir(filename)).sort();
      for (const child of children) {
        const childRelative = relative === '.' ? child : `${relative}/${child}`;
        await visit(path.join(filename, child), childRelative);
      }
      const after = await fs.lstat(filename);
      if (!after.isDirectory() || after.dev !== stat.dev || after.ino !== stat.ino
        || after.mtimeMs !== stat.mtimeMs) fail('UNDO_CONFLICT', 'A moved directory changed during the undo check.');
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('UNDO_CONFLICT', 'A moved file changed type.');
    const currentPath = relative === '.' ? destinationPath : `${destinationPath}/${relative}`;
    const linkStep = linkByKey.get(operationLinkStepKey(workspace.workspaceId, currentPath));
    const expectedHash = linkStep?.afterFence ?? entry.sha256;
    if ((linkStep && (linkStep.status !== 'applied' || linkStep.phase !== 'link'))
      || (linkStep && linkStep.beforeFence !== entry.sha256)
      || await hashWorkspaceFile(filename) !== expectedHash) {
      fail('UNDO_CONFLICT', `The moved file changed after the operation: ${currentPath}`);
    }
  };
  try { await visit(root, '.'); }
  catch (error) {
    if (error instanceof WorkspaceOperationUndoError) throw error;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      fail('UNDO_CONFLICT', 'The moved path changed during the undo check.');
    }
    throw error;
  }
  if (seen.size !== expected.size) fail('UNDO_CONFLICT', 'The moved path is missing snapshot entries.');
}
