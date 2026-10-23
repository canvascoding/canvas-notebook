import type { WorkspaceOperationBatchExecutionResult } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchMutationEvidence } from './workspace-operation-batch-failure';
import type { WorkspaceOperationBatchExecutionPublic } from './workspace-operation-batch-public';
import type { WorkspaceOperationBatchExecutionPublicInput } from './workspace-operation-batch-execution-public';
import type { WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import type { WorkspaceOperationOriginalMoveObservation } from './workspace-operation-native-move-status';

type Effect = Readonly<{ documentId: string; path: string; updatedLinks: number }>;
const unavailable = (): never => { throw new Error('BATCH_JOURNAL_UNAVAILABLE'); };

/** Presentation only. The status reader independently checks the actual SQL
 * completion, native receipts and admission outcome before acknowledging work. */
export function workspaceOperationNativeMoveEffects(plan: WorkspaceOperationNativeMoveBatchPlan): readonly Effect[] {
  const effects = new Map<string, Effect>(), links = new Set<string>();
  for (const recipe of plan.nativePathPlan.mutations) {
    const key = JSON.stringify([recipe.source.documentId, recipe.linkId]);
    if (links.has(key) || recipe.source.workspaceId !== plan.workspaceId || recipe.cloneSelection !== null
      || recipe.action !== 'rewrite' || recipe.nextValue === null) unavailable();
    links.add(key);
    const prior = effects.get(recipe.source.documentId);
    if (prior && prior.path !== recipe.sourcePathAfter) unavailable();
    effects.set(recipe.source.documentId, Object.freeze({ documentId: recipe.source.documentId,
      path: recipe.sourcePathAfter, updatedLinks: (prior?.updatedLinks ?? 0) + 1 }));
  }
  return Object.freeze([...effects.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function workspaceOperationNativeMoveMutationEvidence(observation: WorkspaceOperationOriginalMoveObservation,
  undo = false): WorkspaceOperationBatchMutationEvidence {
  if (undo) unavailable();
  return observation.apply;
}

export function workspaceOperationNativeMoveExecutionResult(plan: WorkspaceOperationNativeMoveBatchPlan,
  observation: WorkspaceOperationOriginalMoveObservation): WorkspaceOperationBatchExecutionResult | null {
  if (observation.apply === 'absent') return null;
  const complete = observation.apply === 'complete', effects = workspaceOperationNativeMoveEffects(plan);
  if (complete && (!observation.completion || !observation.intent
    || observation.completion.planId !== plan.planId || observation.paths.length !== plan.pathSteps.length)) unavailable();
  const totalActions = plan.pathSteps.length + effects.length;
  return { status: complete ? 'applied' : 'needs_recovery', completedActions: complete ? totalActions : 0,
    totalActions, trashEntryIds: [], errorCode: complete ? null : 'BATCH_RECOVERY_REQUIRED',
    stepResults: [
      ...plan.pathSteps.map((step, index) => {
        if (complete) {
          const path = observation.paths.find(row => row.stepKey === `path:${String(index).padStart(4, '0')}`);
          if (!path || path.physical.original.sourcePath !== step.sourcePath
            || path.physical.original.destinationPath !== step.destinationPath) unavailable();
        }
        return { key: `path:${index}`, phase: 'path' as const, state: complete ? 'applied' as const : 'intent' as const,
          path: step.sourcePath, destinationPath: step.destinationPath, reviewId: step.reviewId,
          ...(complete ? { mutationId: observation.completion!.native?.operationId ?? observation.completion!.batchId } : {}) };
      }),
      ...effects.map((effect, index) => ({ key: `link:${index}`, phase: 'link' as const,
        state: complete ? 'applied' as const : 'intent' as const, path: effect.path,
        ...(complete ? { updatedLinks: effect.updatedLinks } : {}) })),
    ] };
}

export function projectWorkspaceOperationNativeMoveExecution(
  input: WorkspaceOperationBatchExecutionPublicInput & { plan: WorkspaceOperationNativeMoveBatchPlan },
  observation: WorkspaceOperationOriginalMoveObservation | null,
): WorkspaceOperationBatchExecutionPublic {
  const mode = input.actionMode;
  const pathRows = input.plan.pathSteps.map((step, index) => ({ key: `path:${index}`, phase: 'path' as const,
    kind: step.kind, path: step.sourcePath, destinationPath: step.destinationPath, reviewId: step.reviewId,
    state: 'pending' as const }));
  const effects = workspaceOperationNativeMoveEffects(input.plan);
  const rows = [...pathRows, ...effects.map((effect, index) => ({ key: `link:${index}`, phase: 'link' as const,
    kind: 'link_update' as const, path: effect.path, state: 'pending' as const }))];
  const missing = (): WorkspaceOperationBatchExecutionPublic => ({ mode, receiptStatus: 'unavailable', finalization: 'pending',
    steps: rows.map(row => ({ ...row, state: 'needs_check' })) });
  if (!observation || mode !== 'apply') return missing();
  if (observation.apply === 'complete') {
    try { if (workspaceOperationNativeMoveExecutionResult(input.plan, observation)?.status !== 'applied') return missing(); }
    catch { return missing(); }
    return { mode, receiptStatus: 'available', finalization: 'complete', steps: rows.map(row => ({ ...row, state: 'applied',
      ...(row.phase === 'link' ? { openPath: row.path } : {}) })) };
  }
  if (input.completedActions > 0 || input.phase === 'complete' || input.status === 'applied' || input.status === 'undone') return missing();
  if (observation.apply === 'started') return { mode, receiptStatus: 'available', finalization: 'pending',
    steps: rows.map(row => ({ ...row, state: 'needs_check' })) };
  return { mode, receiptStatus: 'not_started', finalization: 'pending', steps: rows };
}
