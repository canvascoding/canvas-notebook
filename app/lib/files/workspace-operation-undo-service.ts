import 'server-only';

import { getWorkspaceOperationBackup, WorkspaceOperationBackupError } from './workspace-operation-backup';
import { WorkspaceOperationJournal, type WorkspaceOperationRequest, type WorkspaceOperationWithSteps } from './workspace-operation-journal';
import { assertInverseLinks, assertUnchangedMovedPath, operationUndoId, WorkspaceOperationUndoError } from './workspace-operation-undo';
import { executeWorkspaceFileOperationService } from './workspace-file-operation-service';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { buildWorkspaceFileOperationPreview } from '@/app/lib/markdown/workspace-file-operation-preview';
import { isWorkspaceFileOperationLinkSafe } from '@/app/lib/markdown/workspace-file-operation-link-safety';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

type UndoKind = 'rename' | 'move';
type PreparedUndo = {
  original: WorkspaceOperationWithSteps;
  kind: UndoKind;
  sourcePath: string;
  destinationPath: string;
  undoOperationId: string;
  expectedPlanId: string;
};

export type WorkspaceOperationUndoCapability = {
  available: boolean;
  reason: string | null;
  reasonCode: 'UNDO_UNAVAILABLE' | 'UNDO_CONFLICT' | 'ALREADY_UNDONE' | null;
  undoOperationId: string | null;
};

function unavailable(message: string): never {
  throw new WorkspaceOperationUndoError('UNDO_UNAVAILABLE', message);
}

function conflict(message: string): never {
  throw new WorkspaceOperationUndoError('UNDO_CONFLICT', message);
}

function parseOriginal(record: WorkspaceOperationWithSteps, workspace: WorkspaceContext, userId: string): {
  kind: UndoKind; sourcePath: string; destinationPath: string; backupId: string;
} {
  if (record.actor.id !== userId || record.sourceWorkspaceId !== workspace.workspaceId
    || record.destinationWorkspaceId !== workspace.workspaceId) unavailable('Operation not found.');
  if (record.status !== 'completed') unavailable('Only completed file operations can be undone.');
  let request: WorkspaceOperationRequest;
  try { request = JSON.parse(record.requestJson) as WorkspaceOperationRequest; }
  catch { return unavailable('The original operation request is unreadable.'); }
  if ((request.kind !== 'rename' && request.kind !== 'move') || request.selections.length !== 1) {
    unavailable('This operation does not support automatic undo.');
  }
  const step = record.steps.find((candidate) => candidate.stepKey === 'path:all');
  if (!step || step.status !== 'applied' || step.phase !== 'path' || !step.receiptJson) {
    unavailable('The original path receipt is incomplete.');
  }
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(step.receiptJson) as Record<string, unknown>; }
  catch { return unavailable('The original path receipt is unreadable.'); }
  if (receipt.kind !== request.kind || receipt.sourcePath !== request.selections[0].sourcePath
    || receipt.destinationPath !== request.selections[0].destinationPath
    || typeof receipt.undoBackupId !== 'string') {
    unavailable('This operation has no complete undo snapshot.');
  }
  return { kind: request.kind, sourcePath: request.selections[0].sourcePath,
    destinationPath: request.selections[0].destinationPath, backupId: receipt.undoBackupId };
}

async function prepareUndo(input: {
  operationId: string; workspace: WorkspaceContext; userId: string;
  journal: WorkspaceOperationJournal;
}): Promise<PreparedUndo | { alreadyUndone: true; undoOperationId: string } > {
  const original = await input.journal.get(input.operationId);
  if (!original) unavailable('Operation not found.');
  const { kind, sourcePath, destinationPath, backupId } = parseOriginal(original, input.workspace, input.userId);
  const undoOperationId = operationUndoId(input.operationId);
  const existing = await input.journal.get(undoOperationId);
  if (existing) {
    let request: WorkspaceOperationRequest;
    try { request = JSON.parse(existing.requestJson) as WorkspaceOperationRequest; }
    catch { return unavailable('The undo receipt is unreadable.'); }
    if (existing.actor.id !== input.userId || existing.sourceWorkspaceId !== input.workspace.workspaceId
      || existing.destinationWorkspaceId !== input.workspace.workspaceId
      || request.kind !== kind || request.selections.length !== 1
      || request.selections[0].sourcePath !== destinationPath
      || request.selections[0].destinationPath !== sourcePath) {
      unavailable('The undo operation ID belongs to a different request.');
    }
    if (existing.status === 'completed') return { alreadyUndone: true, undoOperationId };
    if (existing.status === 'failed') unavailable('Undo failed and requires manual recovery.');
    return { original, kind, sourcePath, destinationPath, undoOperationId,
      expectedPlanId: existing.planId };
  }
  const backup = await getWorkspaceOperationBackup({ workspace: input.workspace, backupId })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof WorkspaceOperationBackupError) {
        unavailable('The undo snapshot is missing or unreadable.');
      }
      throw error;
    });
  if (backup.operationId !== input.operationId || backup.originalPath !== sourcePath) {
    unavailable('The undo snapshot does not match the original operation.');
  }
  await assertUnchangedMovedPath({ workspace: input.workspace, destinationPath, backup,
    linkSteps: original.steps.filter((step) => step.phase === 'link') });
  const options = workspaceFileOptions(input.workspace);
  let inverse;
  try {
    inverse = await buildWorkspaceFileOperationPreview({
      kind, sourceWorkspaceId: input.workspace.workspaceId,
      destinationWorkspaceId: input.workspace.workspaceId,
      sourceOptions: options, destinationOptions: options,
      selections: [{ sourcePath: destinationPath, destinationPath: sourcePath }],
    });
  } catch { return conflict('Workspace contents changed; a safe inverse plan cannot be built.'); }
  if (inverse.readiness !== 'ready' || inverse.issues.length > 0 || !isWorkspaceFileOperationLinkSafe(inverse)) {
    conflict('The inverse move has a collision or unsafe link changes.');
  }
  assertInverseLinks(original, inverse);
  return { original, kind, sourcePath, destinationPath, undoOperationId,
    expectedPlanId: inverse.planId };
}

export async function getWorkspaceOperationUndoCapability(input: {
  operationId: string; workspace: WorkspaceContext; userId: string;
}): Promise<WorkspaceOperationUndoCapability> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(input.operationId)) {
    return { available: false, reason: 'Operation not found.', reasonCode: 'UNDO_UNAVAILABLE', undoOperationId: null };
  }
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    try {
      const prepared = await prepareUndo({ ...input, journal: new WorkspaceOperationJournal() });
      if ('alreadyUndone' in prepared) {
        return { available: false, reason: 'Operation already undone.', reasonCode: 'ALREADY_UNDONE',
          undoOperationId: prepared.undoOperationId };
      }
      return { available: true, reason: null, reasonCode: null, undoOperationId: prepared.undoOperationId };
    } catch (error) {
      if (error instanceof WorkspaceOperationUndoError) {
        return { available: false, reason: error.message, reasonCode: error.code, undoOperationId: null };
      }
      throw error;
    }
  });
}

export async function undoWorkspaceFileOperation(input: {
  operationId: string; workspace: WorkspaceContext; userId: string; userName: string;
}): Promise<{
  originalOperationId: string; undoOperationId: string; kind: UndoKind;
  status: 'applied' | 'needs_recovery' | 'failed'; restoredPaths: string[]; removedPaths: string[];
  linkStatus: 'complete' | 'partial';
  alreadyKnown: boolean;
}> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(input.operationId)) unavailable('Operation not found.');
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    const prepared = await prepareUndo({ ...input, journal: new WorkspaceOperationJournal() });
    if ('alreadyUndone' in prepared) {
      const original = await new WorkspaceOperationJournal().get(input.operationId);
      const parsed = parseOriginal(original!, input.workspace, input.userId);
      return { originalOperationId: input.operationId, undoOperationId: prepared.undoOperationId,
        kind: parsed.kind, status: 'applied' as const, restoredPaths: [parsed.sourcePath],
        removedPaths: [parsed.destinationPath],
        linkStatus: 'complete' as const, alreadyKnown: true };
    }
    const options = workspaceFileOptions(input.workspace);
    const execution = await executeWorkspaceFileOperationService({
      operationId: prepared.undoOperationId,
      kind: prepared.kind,
      source: { workspace: input.workspace, fileOptions: options },
      destination: { workspace: input.workspace, fileOptions: options },
      selections: [{ sourcePath: prepared.destinationPath, destinationPath: prepared.sourcePath }],
      expectedPlanId: prepared.expectedPlanId,
      actorUserId: input.userId, actorId: input.userId, actorDisplayName: input.userName, actorType: 'user',
    });
    const status = execution.execution.status === 'complete' ? 'applied' : execution.execution.status;
    return { originalOperationId: input.operationId, undoOperationId: prepared.undoOperationId,
      kind: prepared.kind, status, restoredPaths: status === 'applied' ? [prepared.sourcePath] : [],
      removedPaths: status === 'applied' ? [prepared.destinationPath] : [],
      linkStatus: status === 'applied' ? 'complete' : 'partial', alreadyKnown: execution.alreadyKnown };
  });
}
