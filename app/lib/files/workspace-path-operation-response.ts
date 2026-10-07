import 'server-only';

import { listWorkspaceTrashEntries } from '@/app/lib/filesystem/workspace-trash';
import { getWorkspaceOperationBatchExecution, getWorkspaceOperationBatchExecutionPublic } from './workspace-operation-batch-executor';
import { WorkspaceOperationBatchError, type WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import { workspacePathOperationPublicIssues, type WorkspacePathOperationPublic, type WorkspacePathOperationResponse } from './workspace-path-operation-public';

export function workspacePathOperationMetadata(batch: WorkspaceOperationBatchRecord): WorkspacePathOperationPublic {
  const action = batch.plan.actions.at(-1)!;
  const issues = workspacePathOperationPublicIssues(batch.plan);
  return { batchId: batch.batchId, planId: batch.planId, workspaceId: batch.workspaceId, status: batch.status,
    completedActions: batch.completedActions, totalActions: batch.totalActions, phase: batch.phase,
    errorCode: batch.errorCode, kind: action.kind, selections: action.selections,
    ...(issues.length ? { issues } : {}) };
}

/** A success response is a projection of completed receipts, never an optimistic filesystem guess. */
export async function workspacePathOperationResponse(batch: WorkspaceOperationBatchRecord,
  scope: WorkspaceOperationBatchScope,
  dependencies: { execution?: typeof getWorkspaceOperationBatchExecution; trash?: typeof listWorkspaceTrashEntries;
    publicExecution?: typeof getWorkspaceOperationBatchExecutionPublic } = {},
): Promise<WorkspacePathOperationResponse> {
  const operation = workspacePathOperationMetadata(batch);
  const unavailable = (): never => { throw new WorkspaceOperationBatchError('BATCH_JOURNAL_UNAVAILABLE', 409,
    'The completed file action could not be verified. Check its status in Notification Center.'); };
  if (batch.workspaceId !== scope.workspace.workspaceId || !scope.workspace.permissions.canRead
    || scope.workspace.status !== 'active') {
    throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'Current workspace read permission is required.');
  }
  if (batch.status === 'undone') {
    const inverse = await (dependencies.publicExecution ?? getWorkspaceOperationBatchExecutionPublic)({ batchId: batch.batchId,
      scope, plan: batch.plan, actionMode: 'undo', status: batch.status, completedActions: batch.completedActions, phase: batch.phase });
    if (!inverse || inverse.mode !== 'undo' || inverse.receiptStatus !== 'available' || inverse.finalization !== 'complete'
      || inverse.steps.length !== batch.totalActions || inverse.steps.some((step) => step.state !== 'applied')
      || batch.phase !== 'complete' || batch.completedActions !== batch.totalActions) unavailable();
    return { operation };
  }
  if (batch.status !== 'applied') return { operation };
  if (batch.phase !== 'complete' || batch.completedActions !== batch.totalActions) unavailable();
  const forward = await (dependencies.publicExecution ?? getWorkspaceOperationBatchExecutionPublic)({ batchId: batch.batchId,
    scope, plan: batch.plan, actionMode: 'apply', status: batch.status, completedActions: batch.completedActions, phase: batch.phase });
  if (!forward || forward.mode !== 'apply' || forward.receiptStatus !== 'available' || forward.finalization !== 'complete'
    || forward.steps.length !== batch.totalActions || forward.steps.some((step) => step.state !== 'applied')) unavailable();
  const execution = await (dependencies.execution ?? getWorkspaceOperationBatchExecution)({ batchId: batch.batchId, scope });
  if (!execution || execution.status !== 'applied' || execution.completedActions !== execution.totalActions
    || execution.totalActions !== batch.totalActions) unavailable();
  const steps = execution!.stepResults?.filter((step) => step.phase === 'path' && step.state === 'applied') ?? [];
  const links = execution!.stepResults?.filter((step) => step.phase === 'link' && step.state === 'applied') ?? [];
  const receipts = execution!.stepResults ?? [];
  if (steps.length !== batch.plan.pathSteps.length || links.length !== batch.plan.previewContents.length
    || receipts.length !== batch.totalActions || new Set(receipts.map((step) => step.key)).size !== receipts.length
    || batch.plan.pathSteps.some((step, index) => !steps.some((receipt) => receipt.key === `path:${index}`
      && receipt.path === step.sourcePath && receipt.destinationPath === step.destinationPath))
    || batch.plan.previewContents.some((document) => links.filter((receipt) => receipt.path === document.path).length !== 1)) unavailable();
  const result: WorkspacePathOperationResponse = { operation, linkStatus: 'complete',
    linkUpdates: { updatedFiles: batch.plan.previewContents.map((entry) => entry.path),
      updatedLinks: batch.plan.linkEdits.length, warnings: [] } };
  if (operation.kind !== 'delete') {
    const selection = operation.selections[0];
    const receipt = steps.find((step) => step.path === selection.sourcePath && step.destinationPath === selection.destinationPath);
    if (!receipt?.mutationId || !selection.destinationPath) unavailable();
    result.mutation = { type: 'rename', operationId: receipt!.mutationId!, workspaceId: batch.workspaceId,
      oldPath: selection.sourcePath, newPath: selection.destinationPath! };
  } else {
    const action = batch.plan.actions.at(-1)!;
    const deletedPaths = batch.plan.pathSteps.filter((step) => step.kind === 'delete' && step.reviewId === action.reviewId)
      .map((step) => step.sourcePath);
    const ids = deletedPaths.map((sourcePath) => steps.find((step) => step.path === sourcePath)?.trashEntryId);
    if (ids.some((id) => !id)) unavailable();
    const found = new Map<string, Awaited<ReturnType<typeof listWorkspaceTrashEntries>>[number]>();
    const list = dependencies.trash ?? listWorkspaceTrashEntries;
    for (const status of ['trashed', 'restored', 'purged'] as const) {
      for (let offset = 0; found.size < ids.length; offset += 1000) {
        const entries = await list({ workspace: scope.workspace, status, limit: 1000, offset });
        for (const entry of entries) if (ids.includes(entry.id)) found.set(entry.id, entry);
        if (entries.length < 1000) break;
      }
    }
    if (found.size !== ids.length) unavailable();
    if (deletedPaths.some((sourcePath, index) => {
      const entry = found.get(ids[index]!)!;
      return entry.workspaceId !== batch.workspaceId || entry.originalPath !== sourcePath;
    })) unavailable();
    result.deleted = deletedPaths;
    result.failed = [];
    result.trashEntries = ids.map((id) => {
      const entry = found.get(id!)!;
      return { id: entry.id, originalPath: entry.originalPath, itemType: entry.itemType,
        sizeBytes: entry.sizeBytes, expiresAt: entry.expiresAt.toISOString() };
    });
  }
  return result;
}
