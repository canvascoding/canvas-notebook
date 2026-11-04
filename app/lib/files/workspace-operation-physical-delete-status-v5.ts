import 'server-only';

import { types } from 'node:util';
import type { SqlConnection } from '../db';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import type { WorkspaceContext } from '../workspaces/types';
import { captureWorkspaceOperationProgrammaticJobReadOptions, workspaceOperationProgrammaticJobReadOptions,
  type WorkspaceOperationProgrammaticJobReadOptions } from '../workspaces/workspace-operation-programmatic-job-principal';
import type { WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-batch-contract';
import { withWorkspaceOperationNativeBatchReadContext, WorkspaceOperationNativeReadError,
  type WorkspaceOperationNativeBatchReadContext } from './workspace-operation-native-read-context';
import { readWorkspaceOperationOriginalDeleteObservationOnConnection,
  type WorkspaceOperationOriginalDeleteObservation } from './workspace-operation-original-delete-observation';
import { assertOriginalDeleteIntentPlan } from './workspace-operation-original-delete-evidence';

export type WorkspaceOperationPhysicalDeleteBatchStatusV5 = Readonly<{
  batch: WorkspaceOperationBatchRecord; plan: WorkspaceOperationPhysicalDeleteBatchPlanV5;
  observation: WorkspaceOperationOriginalDeleteObservation;
}>;
export class WorkspaceOperationPhysicalDeleteStatusErrorV5 extends Error {
  constructor(readonly code: 'BATCH_ACCESS_DENIED' | 'BATCH_SCOPE_CHANGED' | 'BATCH_JOURNAL_UNAVAILABLE', readonly status = 409,
    options?: ErrorOptions) { super(code, options); this.name = 'WorkspaceOperationPhysicalDeleteStatusErrorV5'; }
}
type Input = { batchId: string; scope: WorkspaceOperationBatchScope; expectedPlan?: WorkspaceOperationPhysicalDeleteBatchPlanV5 }
  & WorkspaceOperationProgrammaticJobReadOptions;
type ReadContext = Readonly<{ database: SqlConnection; schema: string; workspace: WorkspaceContext;
  status: WorkspaceOperationPhysicalDeleteBatchStatusV5 }>;

/** Factual observation inside the existing authenticated historical snapshot. */
export async function observeWorkspaceOperationPhysicalDeleteBatchStatusV5(context:WorkspaceOperationNativeBatchReadContext):Promise<WorkspaceOperationPhysicalDeleteBatchStatusV5>{
  const {database,schema,workspace,batch,plan}=context;
  if(plan.version!==5||batch.authorization.mode!=='direct'&&batch.authorization.mode!=='direct-mcp'&&batch.authorization.mode!=='api-key')throw new WorkspaceOperationPhysicalDeleteStatusErrorV5('BATCH_SCOPE_CHANGED');
  const observation=await readWorkspaceOperationOriginalDeleteObservationOnConnection(database,{schema,
    context:{batchId:batch.batchId,planId:batch.planId,workspaceId:batch.workspaceId,authorization:batch.authorization,sourcePath:plan.physicalTarget.path},workspace,dataRoot:resolveWorkspaceDataRoot()});
  if(observation.original){try{assertOriginalDeleteIntentPlan(observation.original,plan);}catch{throw new WorkspaceOperationPhysicalDeleteStatusErrorV5('BATCH_SCOPE_CHANGED');}}
  return Object.freeze({batch,plan,observation});
}

/** Internal read adapter for an already authenticated caller. A workspace is
 * never converted into a RequestPrincipal, claim or mutation capability. */
export async function withWorkspaceOperationPhysicalDeleteReadContextV5<T>(input: Input,
  operation: (context: ReadContext) => Promise<T>): Promise<T | null> {
  try {
    if (types.isProxy(input)) throw new WorkspaceOperationPhysicalDeleteStatusErrorV5('BATCH_SCOPE_CHANGED');
    const principal = captureWorkspaceOperationProgrammaticJobReadOptions(input);
    return await withWorkspaceOperationNativeBatchReadContext({ batchId: input.batchId, scope: input.scope,
      expectedPlan: input.expectedPlan, ...workspaceOperationProgrammaticJobReadOptions(principal), planVersion: 5 }, async context => {
      const { database, schema, workspace } = context;
      const status = await observeWorkspaceOperationPhysicalDeleteBatchStatusV5(context);
      return operation(Object.freeze({ database, schema, workspace, status }));
    });
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeReadError) {
      throw new WorkspaceOperationPhysicalDeleteStatusErrorV5(error.code, error.status, { cause: error.cause });
    }
    throw error;
  }
}

export function readWorkspaceOperationPhysicalDeleteBatchStatusV5(input: Input): Promise<WorkspaceOperationPhysicalDeleteBatchStatusV5 | null> {
  return withWorkspaceOperationPhysicalDeleteReadContextV5(input, async context => context.status);
}
