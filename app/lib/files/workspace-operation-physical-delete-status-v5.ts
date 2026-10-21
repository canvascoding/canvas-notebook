import 'server-only';

import { types } from 'node:util';
import type { SqlConnection } from '../db';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import type { WorkspaceContext } from '../workspaces/types';
import { captureWorkspaceOperationMcpJobPrincipal, type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import type { WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-batch-contract';
import { withWorkspaceOperationNativeBatchReadContext, WorkspaceOperationNativeReadError } from './workspace-operation-native-read-context';
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
type Input = { batchId: string; scope: WorkspaceOperationBatchScope; expectedPlan?: WorkspaceOperationPhysicalDeleteBatchPlanV5;
  mcpPrincipal?: WorkspaceOperationMcpJobPrincipal };
type ReadContext = Readonly<{ database: SqlConnection; schema: string; workspace: WorkspaceContext;
  status: WorkspaceOperationPhysicalDeleteBatchStatusV5 }>;

/** Internal read adapter for an already authenticated caller. A workspace is
 * never converted into a RequestPrincipal, claim or mutation capability. */
export async function withWorkspaceOperationPhysicalDeleteReadContextV5<T>(input: Input,
  operation: (context: ReadContext) => Promise<T>): Promise<T | null> {
  try {
    if (types.isProxy(input)) throw new WorkspaceOperationPhysicalDeleteStatusErrorV5('BATCH_SCOPE_CHANGED');
    const field = Object.getOwnPropertyDescriptor(input, 'mcpPrincipal');
    if (field && (!field.enumerable || !Object.hasOwn(field, 'value'))) throw new WorkspaceOperationPhysicalDeleteStatusErrorV5('BATCH_SCOPE_CHANGED');
    const mcpPrincipal = field?.value === undefined ? undefined : captureWorkspaceOperationMcpJobPrincipal(field.value);
    return await withWorkspaceOperationNativeBatchReadContext({ batchId: input.batchId, scope: input.scope,
      expectedPlan: input.expectedPlan, mcpPrincipal, planVersion: 5 }, async context => {
      const { database, schema, workspace, batch, plan } = context;
      if (plan.version !== 5 || batch.authorization.mode !== 'direct' && batch.authorization.mode !== 'direct-mcp') throw new WorkspaceOperationPhysicalDeleteStatusErrorV5('BATCH_SCOPE_CHANGED');
      const observation = await readWorkspaceOperationOriginalDeleteObservationOnConnection(database, { schema,
        context: { batchId: batch.batchId, planId: batch.planId, workspaceId: batch.workspaceId,
          authorization: batch.authorization, sourcePath: plan.physicalTarget.path }, workspace, dataRoot: resolveWorkspaceDataRoot() });
      if (observation.original) {
        try { assertOriginalDeleteIntentPlan(observation.original, plan); }
        catch { throw new WorkspaceOperationPhysicalDeleteStatusErrorV5('BATCH_SCOPE_CHANGED'); }
      }
      const status = Object.freeze({ batch, plan, observation });
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
