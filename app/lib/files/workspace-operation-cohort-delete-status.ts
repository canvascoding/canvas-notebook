import 'server-only';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import { captureWorkspaceOperationProgrammaticJobReadOptions, workspaceOperationProgrammaticJobReadOptions,
  type WorkspaceOperationProgrammaticJobReadOptions } from '../workspaces/workspace-operation-programmatic-job-principal';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import { withWorkspaceOperationNativeBatchReadContext, type WorkspaceOperationNativeBatchReadContext } from './workspace-operation-native-read-context';
import { readCohortDeleteObservationOnConnection } from './workspace-operation-cohort-delete-domain';
import { failCohortDelete, type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';
/** Factual observation inside the existing authenticated historical snapshot. */
export async function observeWorkspaceOperationCohortDeleteStatus(context:WorkspaceOperationNativeBatchReadContext){
  if(context.plan.version!==6||context.batch.actionMode!=='apply')return failCohortDelete();
  const observation=await readCohortDeleteObservationOnConnection(context.database,{schema:context.schema,
    binding:{batchId:context.batch.batchId,planId:context.batch.planId,workspaceId:context.batch.workspaceId,authorization:context.batch.authorization,
      plan:context.plan,actionMode:context.batch.actionMode},workspace:context.workspace,dataRoot:resolveWorkspaceDataRoot()});
  return Object.freeze({batch:context.batch,plan:context.plan,observation});
}
export async function readWorkspaceOperationCohortDeleteStatus(input:Readonly<{batchId:string;scope:WorkspaceOperationBatchScope;expectedPlan?:WorkspaceOperationCohortDeletePlan}>
  &WorkspaceOperationProgrammaticJobReadOptions){
  const principal=captureWorkspaceOperationProgrammaticJobReadOptions(input);
  return withWorkspaceOperationNativeBatchReadContext({batchId:input.batchId,scope:input.scope,expectedPlan:input.expectedPlan,
    ...workspaceOperationProgrammaticJobReadOptions(principal),planVersion:6},observeWorkspaceOperationCohortDeleteStatus);
}
export type WorkspaceOperationCohortDeleteStatus=NonNullable<Awaited<ReturnType<typeof readWorkspaceOperationCohortDeleteStatus>>>;
