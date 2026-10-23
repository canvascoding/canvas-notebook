import 'server-only';
import { decodeWorkspaceOperationCohortDeletePlan, captureWorkspaceOperationCohortDeleteCurrent, getWorkspaceOperationCohortDeleteRecipes, type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';

import { types } from 'node:util';
import type { WorkspaceOperationDeleteBatchPlan } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationNativeDeleteBatchPlan, assertWorkspaceOperationNativeDeleteBatchPlanCurrent,
  getWorkspaceOperationNativeDeleteLinkRecipes, WorkspaceOperationNativeDeletePlanError } from './workspace-operation-native-delete-plan';
import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5, assertWorkspaceOperationPhysicalDeleteCurrentV5,
  getWorkspaceOperationPhysicalDeleteLinkRecipesV5 } from './workspace-operation-physical-delete-html-plan-v5';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';

/** Version is DATA only. Unknown/retagged envelopes never fall into a legacy arm. */
export function decodeWorkspaceOperationDeleteBatchPlan(input: unknown): WorkspaceOperationDeleteBatchPlan | WorkspaceOperationCohortDeletePlan {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_INVALID');
  const field = Object.getOwnPropertyDescriptor(input, 'version');
  if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_INVALID');
  if (field.value === 6) return decodeWorkspaceOperationCohortDeletePlan(input);
  if (field.value === 5) return decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(input);
  if (field.value === 2) return decodeWorkspaceOperationNativeDeleteBatchPlan(input);
  throw new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_INVALID');
}
export function assertWorkspaceOperationDeletePlanCurrent(plan: WorkspaceOperationDeleteBatchPlan | WorkspaceOperationCohortDeletePlan,
  observation: WorkspaceLinkSourceAuthorityObservation, scope: WorkspaceOperationJobScope): void {
  if (plan.version === 6) { captureWorkspaceOperationCohortDeleteCurrent(plan,observation,scope); return; }
  if (plan.version === 5) return assertWorkspaceOperationPhysicalDeleteCurrentV5(plan, observation, scope);
  return assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, observation, scope);
}
export function getWorkspaceOperationDeleteLinkRecipes(plan: WorkspaceOperationDeleteBatchPlan | WorkspaceOperationCohortDeletePlan) {
  if (plan.version === 6) return getWorkspaceOperationCohortDeleteRecipes(plan);
  return plan.version === 5 ? getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan) : getWorkspaceOperationNativeDeleteLinkRecipes(plan);
}
