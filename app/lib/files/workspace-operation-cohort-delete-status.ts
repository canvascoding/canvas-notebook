import 'server-only';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import type { WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import { withWorkspaceOperationNativeBatchReadContext } from './workspace-operation-native-read-context';
import { readCohortDeleteObservationOnConnection } from './workspace-operation-cohort-delete-domain';
import { failCohortDelete, type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';
export async function readWorkspaceOperationCohortDeleteStatus(input:Readonly<{batchId:string;scope:WorkspaceOperationBatchScope;expectedPlan?:WorkspaceOperationCohortDeletePlan;
  mcpPrincipal?:WorkspaceOperationMcpJobPrincipal}>){
  return withWorkspaceOperationNativeBatchReadContext({...input,planVersion:6},async context=>{
    if(context.plan.version!==6||context.batch.actionMode!=='apply')return failCohortDelete();
    const observation=await readCohortDeleteObservationOnConnection(context.database,{schema:context.schema,
      binding:{batchId:context.batch.batchId,planId:context.batch.planId,workspaceId:context.batch.workspaceId,authorization:context.batch.authorization,
        plan:context.plan,actionMode:context.batch.actionMode},workspace:context.workspace,dataRoot:resolveWorkspaceDataRoot()});
    return Object.freeze({batch:context.batch,plan:context.plan,observation});
  });
}
export type WorkspaceOperationCohortDeleteStatus=NonNullable<Awaited<ReturnType<typeof readWorkspaceOperationCohortDeleteStatus>>>;
