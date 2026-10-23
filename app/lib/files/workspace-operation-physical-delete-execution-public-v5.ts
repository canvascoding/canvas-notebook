import type { WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import type { WorkspaceOperationBatchExecutionPublicInput } from './workspace-operation-batch-execution-public';
import type { WorkspaceOperationBatchExecutionPublic } from './workspace-operation-batch-public';
import type { WorkspaceOperationBatchExecutionResult } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchMutationEvidence } from './workspace-operation-batch-failure';
import type { WorkspaceOperationOriginalDeleteObservation } from './workspace-operation-original-delete-observation';
import { workspaceOperationPhysicalDeleteEffectsV5, workspaceOperationPhysicalDeleteAppliedEffectsV5,
  type WorkspaceOperationPhysicalDeleteEffectV5 } from './workspace-operation-physical-delete-effects-v5';
export function projectWorkspaceOperationPhysicalDeleteExecutionV5(
  input: WorkspaceOperationBatchExecutionPublicInput & { plan: WorkspaceOperationPhysicalDeleteBatchPlanV5 },
  observation: WorkspaceOperationOriginalDeleteObservation | null,
): WorkspaceOperationBatchExecutionPublic {
  const mode = input.actionMode;
  const row = { key: 'path:0', phase: 'path' as const, kind: mode === 'undo' ? 'restore' as const : 'delete' as const,
    path: input.plan.physicalTarget.path, reviewId: input.plan.pathSteps[0]?.reviewId, state: 'pending' as const };
  let effects: readonly WorkspaceOperationPhysicalDeleteEffectV5[] = [];
  const rows = () => [row, ...effects.map((effect, index) => ({ key: `link:${index}`, phase: 'link' as const,
    kind: 'link_update' as const, path: effect.path, state: 'pending' as const }))];
  const unavailable = (): WorkspaceOperationBatchExecutionPublic => ({ mode, receiptStatus: 'unavailable', finalization: 'pending',
    steps: rows().map(step => ({ ...step, state: 'needs_check' })) });
  if (mode === 'undo') return unavailable();
  try { effects = workspaceOperationPhysicalDeleteEffectsV5(input.plan); }
  catch { return unavailable(); }
  if (!observation || input.plan.readiness !== 'ready' || input.plan.pathSteps.length !== 1
    || input.plan.pathSteps[0].kind !== 'delete' || input.plan.pathSteps[0].sourcePath !== row.path
    || input.plan.previewContents.length || input.plan.linkEdits.length || input.plan.pathMappings.length) return unavailable();
  // Undo has already returned unavailable above; only forward receipts apply.
  const complete = observation.apply === 'complete' && Boolean(observation.deleted);
  if (complete) {
    if (!observation.deleted) return unavailable();
    try { workspaceOperationPhysicalDeleteAppliedEffectsV5(input.plan, observation.deleted); }
    catch { return unavailable(); }
    return { mode, receiptStatus: 'available', finalization: 'complete', steps: rows().map(step => ({ ...step, state: 'applied',
      ...(step.phase === 'link' ? { openPath: step.path } : {}) })) };
  }
  const claimedComplete = input.completedActions > 0 || input.phase === 'complete'
    || input.status === 'applied';
  if (claimedComplete) return unavailable();
  const started = observation.apply === 'started';
  if (started) return { mode, receiptStatus: 'available', finalization: 'pending', steps: rows().map(step => ({ ...step, state: 'needs_check' })) };
  if (observation.apply !== 'absent') return unavailable();
  return { mode, receiptStatus: 'not_started', finalization: 'pending', steps: rows() };
}

export function workspaceOperationPhysicalDeleteMutationEvidenceV5(observation: WorkspaceOperationOriginalDeleteObservation,
  undo = false): WorkspaceOperationBatchMutationEvidence {
  if (undo) throw new Error('FILE_OPERATION_UNDO_DISABLED');
  return observation.apply;
}

export function workspaceOperationPhysicalDeleteExecutionResultV5(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5,
  observation: WorkspaceOperationOriginalDeleteObservation, undo = false): WorkspaceOperationBatchExecutionResult | null {
  if (undo) throw new Error('FILE_OPERATION_UNDO_DISABLED');
  const state = observation.apply;
  if (state === 'absent') return null;
  if (state !== 'started' && state !== 'complete') throw new Error('BATCH_JOURNAL_UNAVAILABLE');
  const effects = workspaceOperationPhysicalDeleteEffectsV5(plan);
  const complete = state === 'complete', receipt = observation.deleted;
  if (complete && (!receipt || !observation.deleted)) throw new Error('BATCH_JOURNAL_UNAVAILABLE');
  const appliedEffects = complete ? workspaceOperationPhysicalDeleteAppliedEffectsV5(plan, observation.deleted!) : [];
  const totalActions = 1 + effects.length;
  return { status: complete ? 'applied' : 'needs_recovery', completedActions: complete ? totalActions : 0,
    totalActions, errorCode: complete ? null : 'BATCH_RECOVERY_REQUIRED',
    trashEntryIds: observation.deleted ? [observation.deleted.trashEntryId] : [],
    stepResults: [{ key: 'path:0', phase: 'path', state: complete ? 'applied' : 'intent',
      path: plan.physicalTarget.path, reviewId: plan.pathSteps[0].reviewId,
      ...(observation.deleted ? { trashEntryId: observation.deleted.trashEntryId } : {}) },
    ...effects.map((effect, index) => ({ key: `link:${index}`, phase: 'link' as const, state: complete ? 'applied' as const : 'intent' as const,
      path: effect.path, ...(complete ? { updatedLinks: appliedEffects[index].updatedLinks } : {}) }))] };
}
