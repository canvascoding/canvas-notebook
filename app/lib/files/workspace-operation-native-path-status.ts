import 'server-only';

import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationProgrammaticJobReadOptions, workspaceOperationProgrammaticJobReadOptions } from '../workspaces/workspace-operation-programmatic-job-principal';
import { withWorkspaceOperationNativePathReadLookup, WorkspaceOperationNativeReadError,
  type WorkspaceOperationNativeBatchReadContext, type WorkspaceOperationNativePathReadInput } from './workspace-operation-native-read-context';
import { observeWorkspaceOperationNativeMoveBatchStatus, type WorkspaceOperationNativeMoveBatchStatus } from './workspace-operation-native-move-status';
import { observeWorkspaceOperationNativeDeleteBatchStatus, type WorkspaceOperationNativeDeleteBatchStatus } from './workspace-operation-native-delete-status';
import { observeWorkspaceOperationPhysicalDeleteBatchStatusV5, type WorkspaceOperationPhysicalDeleteBatchStatusV5 } from './workspace-operation-physical-delete-status-v5';
import { observeWorkspaceOperationCohortDeleteStatus, type WorkspaceOperationCohortDeleteStatus } from './workspace-operation-cohort-delete-status';

export type WorkspaceOperationNativePathStatus =
  | Readonly<{ kind: 'move'; value: WorkspaceOperationNativeMoveBatchStatus }>
  | Readonly<{ kind: 'cohort-delete'; value: WorkspaceOperationCohortDeleteStatus }>
  | Readonly<{ kind: 'delete'; value: WorkspaceOperationNativeDeleteBatchStatus | WorkspaceOperationPhysicalDeleteBatchStatusV5 }>;
export type WorkspaceOperationNativePathStatusRead = Readonly<{
  status: WorkspaceOperationNativePathStatus;
  /** Current factual scope; this is never a write principal or a claim. */
  scope: WorkspaceOperationBatchScope;
}>;
export type WorkspaceOperationNativePathStatusLookup = Readonly<{
  status: WorkspaceOperationNativePathStatus | null;
  scope: WorkspaceOperationBatchScope;
  batchId: string;
}>;

async function observePathStatus(context: WorkspaceOperationNativeBatchReadContext): Promise<WorkspaceOperationNativePathStatus> {
  let status: WorkspaceOperationNativePathStatus;
  switch (context.plan.version) {
    case 3: status = Object.freeze({ kind: 'move', value: await observeWorkspaceOperationNativeMoveBatchStatus(context) }); break;
    case 2: status = Object.freeze({ kind: 'delete', value: await observeWorkspaceOperationNativeDeleteBatchStatus(context) }); break;
    case 5: status = Object.freeze({ kind: 'delete', value: await observeWorkspaceOperationPhysicalDeleteBatchStatusV5(context) }); break;
    case 6: status = Object.freeze({ kind: 'cohort-delete', value: await observeWorkspaceOperationCohortDeleteStatus(context) }); break;
    default: throw new WorkspaceOperationNativeReadError('BATCH_SCOPE_CHANGED');
  }
  return status;
}

/** Select the native profile from one authenticated historical snapshot. The
 * result escapes only after that snapshot closes and current authority is
 * checked again. API-key operation IDs derive their namespace in the same
 * existing authorization phase, without a preliminary scope-only checkout. */
export async function readWorkspaceOperationNativePathStatus(input: WorkspaceOperationNativePathReadInput): Promise<WorkspaceOperationNativePathStatusRead | null> {
  const result = await lookupWorkspaceOperationNativePathStatus(input);
  return result.status === null ? null : Object.freeze({ status: result.status, scope: result.scope });
}

/** A new operation still receives current factual scope from the same C1/RR/C2
 * lookup. Planning must use its own current checks; scope is not a write grant. */
export async function lookupWorkspaceOperationNativePathStatus(input: WorkspaceOperationNativePathReadInput): Promise<WorkspaceOperationNativePathStatusLookup> {
  const live = captureWorkspaceOperationProgrammaticJobReadOptions(input);
  if (!live) throw new WorkspaceOperationNativeReadError('BATCH_SCOPE_CHANGED');
  if (Object.hasOwn(input, 'expectedPlan')) throw new WorkspaceOperationNativeReadError('BATCH_SCOPE_CHANGED');
  if ('operationId' in input) {
    if (!('transport' in live) || Object.hasOwn(input, 'scope') || Object.hasOwn(input, 'batchId')) throw new WorkspaceOperationNativeReadError('BATCH_SCOPE_CHANGED');
    const result = await withWorkspaceOperationNativePathReadLookup({ workspaceId: input.workspaceId,
      operationId: input.operationId, apiKeyPrincipal: live, planVersion: 'path' }, observePathStatus);
    return Object.freeze({ status: result.value, scope: result.scope, batchId: result.batchId });
  }
  const result = await withWorkspaceOperationNativePathReadLookup({ batchId: input.batchId, scope: input.scope,
    ...workspaceOperationProgrammaticJobReadOptions(live), planVersion: 'path' }, observePathStatus);
  return Object.freeze({ status: result.value, scope: result.scope, batchId: result.batchId });
}
