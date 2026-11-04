import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceOperationJobScope, WorkspaceOperationDeleteBatchPlan } from './workspace-operation-batch-contract';
import type { WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationNativeMoveBatchPlan, WorkspaceOperationNativeMovePlanError,
  type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { decodeWorkspaceOperationDeleteBatchPlan } from './workspace-operation-delete-plan-dispatch';
import { WorkspaceOperationNativeDeletePlanError } from './workspace-operation-native-delete-plan';
import { WorkspaceOperationNativeSourceEvidenceError } from './workspace-operation-native-source-evidence';
import { WorkspaceOperationPhysicalDeleteHtmlPlanError } from './workspace-operation-physical-delete-html-plan-v5';

export type WorkspaceOperationProgrammaticPlan = WorkspaceOperationNativeMoveBatchPlan
  | WorkspaceOperationDeleteBatchPlan | WorkspaceOperationCohortDeletePlan;

/** Shared immutable-plan data check only. Transport-specific identity, current
 * authority, stored attribution and public errors remain with their callers. */
export function decodeWorkspaceOperationProgrammaticPlan(input: unknown, kind: 'move' | 'delete',
  scope: WorkspaceOperationJobScope, reject: (reason: 'invalid' | 'too-large') => never): WorkspaceOperationProgrammaticPlan {
  const data = captureWorkspaceOperationNativePlanData(input, reject);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return reject('invalid');
  const version = Object.getOwnPropertyDescriptor(data, 'version')?.value;
  let selected: WorkspaceOperationProgrammaticPlan;
  try {
    if (version === 3 && kind === 'move') selected = decodeWorkspaceOperationNativeMoveBatchPlan(data);
    else if ((version === 2 || version === 5 || version === 6) && kind === 'delete') selected = decodeWorkspaceOperationDeleteBatchPlan(data);
    else return reject('invalid');
  } catch (error) {
    if ((error instanceof WorkspaceOperationNativeMovePlanError || error instanceof WorkspaceOperationNativeDeletePlanError
      || error instanceof WorkspaceOperationNativeSourceEvidenceError || error instanceof WorkspaceOperationPhysicalDeleteHtmlPlanError)
      && error.code.endsWith('_TOO_LARGE')) return reject('too-large');
    return reject('invalid');
  }
  if (selected.workspaceId !== scope.workspaceId || !isDeepStrictEqual(selected.sourceEvidence.workspaceScope, scope)
    || kind === 'move' && !['move', 'rename'].includes(selected.actions[0].kind)
    || kind === 'delete' && selected.actions[0].kind !== 'delete') return reject('invalid');
  return selected;
}
