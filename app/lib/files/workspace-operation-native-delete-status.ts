import 'server-only';

import { types } from 'node:util';
import type { SqlConnection } from '../db';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import type { WorkspaceContext } from '../workspaces/types';
import { captureWorkspaceOperationMcpJobPrincipal, type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import type { WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import { withWorkspaceOperationNativeBatchReadContext, WorkspaceOperationNativeReadError } from './workspace-operation-native-read-context';
import { readWorkspaceOperationOriginalDeleteObservationOnConnection,
  type WorkspaceOperationOriginalDeleteObservation } from './workspace-operation-original-delete-observation';
import { assertOriginalDeleteIntentPlan } from './workspace-operation-original-delete-evidence';

export type WorkspaceOperationNativeDeleteBatchStatus = Readonly<{
  batch: WorkspaceOperationBatchRecord; plan: WorkspaceOperationNativeDeleteBatchPlan;
  observation: WorkspaceOperationOriginalDeleteObservation;
}>;
export class WorkspaceOperationNativeDeleteStatusError extends Error {
  constructor(readonly code: 'BATCH_ACCESS_DENIED' | 'BATCH_SCOPE_CHANGED' | 'BATCH_JOURNAL_UNAVAILABLE', readonly status = 409,
    options?: ErrorOptions) { super(code, options); this.name = 'WorkspaceOperationNativeDeleteStatusError'; }
}
type Input = { batchId: string; scope: WorkspaceOperationBatchScope; expectedPlan?: WorkspaceOperationNativeDeleteBatchPlan;
  mcpPrincipal?: WorkspaceOperationMcpJobPrincipal };
type ReadContext = Readonly<{ database: SqlConnection; schema: string; workspace: WorkspaceContext;
  status: WorkspaceOperationNativeDeleteBatchStatus }>;

/** Internal read adapter for an already authenticated caller. A workspace is
 * never converted into a RequestPrincipal, claim or mutation capability. */
export async function withWorkspaceOperationNativeDeleteReadContext<T>(input: Input,
  operation: (context: ReadContext) => Promise<T>): Promise<T | null> {
  try {
    if (types.isProxy(input)) throw new WorkspaceOperationNativeDeleteStatusError('BATCH_SCOPE_CHANGED');
    const field = Object.getOwnPropertyDescriptor(input, 'mcpPrincipal');
    if (field && (!field.enumerable || !Object.hasOwn(field, 'value'))) throw new WorkspaceOperationNativeDeleteStatusError('BATCH_SCOPE_CHANGED');
    const mcpPrincipal = field?.value === undefined ? undefined : captureWorkspaceOperationMcpJobPrincipal(field.value);
    return await withWorkspaceOperationNativeBatchReadContext({ batchId: input.batchId, scope: input.scope,
      expectedPlan: input.expectedPlan, mcpPrincipal, planVersion: 2 }, async context => {
      const { database, schema, workspace, batch, plan } = context;
      if (plan.version !== 2 || batch.authorization.mode !== 'direct' && batch.authorization.mode !== 'direct-mcp') throw new WorkspaceOperationNativeDeleteStatusError('BATCH_SCOPE_CHANGED');
      const observation = await readWorkspaceOperationOriginalDeleteObservationOnConnection(database, { schema,
        context: { batchId: batch.batchId, planId: batch.planId, workspaceId: batch.workspaceId,
          authorization: batch.authorization, sourcePath: plan.nativeTarget.path }, workspace, dataRoot: resolveWorkspaceDataRoot() });
      if (observation.original) {
        try { assertOriginalDeleteIntentPlan(observation.original, plan); }
        catch { throw new WorkspaceOperationNativeDeleteStatusError('BATCH_SCOPE_CHANGED'); }
      }
      const status = Object.freeze({ batch, plan, observation });
      return operation(Object.freeze({ database, schema, workspace, status }));
    });
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeReadError) {
      throw new WorkspaceOperationNativeDeleteStatusError(error.code, error.status, { cause: error.cause });
    }
    throw error;
  }
}

export function readWorkspaceOperationNativeDeleteBatchStatus(input: Input): Promise<WorkspaceOperationNativeDeleteBatchStatus | null> {
  return withWorkspaceOperationNativeDeleteReadContext(input, async context => context.status);
}
