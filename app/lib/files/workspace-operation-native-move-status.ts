import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { captureWorkspaceOperationMcpJobPrincipal, type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import { captureCollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { readHistoricalCollaborationAdmissionOutcomeOnConnection } from '../collaboration/room-admission-outcome';
import { readHistoricalNativeFileOperationReceiptOnConnection } from '../markdown/native-file-operation-handoff';
import { readHistoricalNativeFileOperationSideEffectsOnConnection } from '../markdown/native-file-operation-side-effects';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { withWorkspaceOperationNativeBatchReadContext, WorkspaceOperationNativeReadError } from './workspace-operation-native-read-context';
import { createWorkspaceOperationOriginalMoveAdmissionRequest } from './workspace-operation-original-move-admission';
import { parseWorkspaceOperationOriginalMoveIntent, decodeWorkspaceOperationOriginalMoveParentReceipt,
  decodeWorkspaceOperationOriginalMovePathReceipt, decodeWorkspaceOperationOriginalMoveCompletion,
  readWorkspaceOperationOriginalMoveNativeBundle, type WorkspaceOperationOriginalMoveContext,
  type WorkspaceOperationOriginalMoveIntentData, type WorkspaceOperationOriginalMovePathReceiptData,
  type WorkspaceOperationOriginalMoveCompletionData } from './workspace-operation-original-move';
import { readWorkspaceOperationOriginalMoveIntentOnConnection, listWorkspaceOperationOriginalMoveParentReceiptsOnConnection,
  listWorkspaceOperationOriginalMovePathReceiptsOnConnection, readWorkspaceOperationOriginalMoveReceiptOnConnection } from './workspace-operation-original-move-repository';

/** Historical presentation facts only. This grants no claim, current target,
 * original replay authority, SQL capability or approval of a new mutation. */
export type WorkspaceOperationOriginalMoveObservation = Readonly<{
  apply: 'absent' | 'started' | 'complete';
  intent: WorkspaceOperationOriginalMoveIntentData | null;
  paths: readonly WorkspaceOperationOriginalMovePathReceiptData[];
  completion: WorkspaceOperationOriginalMoveCompletionData | null;
}>;
export type WorkspaceOperationNativeMoveBatchStatus = Readonly<{
  batch: WorkspaceOperationBatchRecord; plan: WorkspaceOperationNativeMoveBatchPlan;
  observation: WorkspaceOperationOriginalMoveObservation;
}>;
export class WorkspaceOperationNativeMoveStatusError extends Error {
  constructor(readonly code: 'BATCH_ACCESS_DENIED' | 'BATCH_SCOPE_CHANGED' | 'BATCH_JOURNAL_UNAVAILABLE', readonly status = 409,
    options?: ErrorOptions) { super(code, options); this.name = 'WorkspaceOperationNativeMoveStatusError'; }
}
type Input = { batchId: string; scope: WorkspaceOperationBatchScope; expectedPlan?: WorkspaceOperationNativeMoveBatchPlan;
  mcpPrincipal?: WorkspaceOperationMcpJobPrincipal };
type ReadContext = Readonly<{ database: SqlConnection; schema: string; workspace: WorkspaceContext;
  status: WorkspaceOperationNativeMoveBatchStatus }>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function invalid(cause?: unknown): never {
  throw new WorkspaceOperationNativeMoveStatusError('BATCH_JOURNAL_UNAVAILABLE', 503, cause === undefined ? undefined : { cause });
}

/** Uses only immutable original rows. Completion is checked against the
 * original committed native/sideeffect/admission history, never today's Yjs,
 * registry path, projection bytes, namespace rows or later user edits. */
async function observe(database: SqlConnection, schema: string, context: WorkspaceOperationOriginalMoveContext): Promise<WorkspaceOperationOriginalMoveObservation> {
  const selected = { schema, batchId: context.batchId, readOnly: true as const };
  const row = await readWorkspaceOperationOriginalMoveIntentOnConnection(database, selected);
  if (!row) {
    // Genuine storage has FK protection; still refuse orphaned evidence rather
    // than presenting a missing header as a clean never-started operation.
    const prefix = quote(schema);
    const orphan = await database.get(`SELECT 1 AS found FROM ${prefix}.workspace_file_operation_move_parent_receipts WHERE batch_id=$1
      UNION ALL SELECT 1 FROM ${prefix}.workspace_file_operation_move_path_receipts WHERE batch_id=$1
      UNION ALL SELECT 1 FROM ${prefix}.workspace_file_operation_move_receipts WHERE batch_id=$1 LIMIT 1`, [context.batchId]);
    if (orphan) invalid();
    return Object.freeze({ apply: 'absent', intent: null, paths: Object.freeze([]), completion: null });
  }
  const intent = parseWorkspaceOperationOriginalMoveIntent(row, context), original = { ...selected, intentDigest: row.intentDigest };
  const parents = await listWorkspaceOperationOriginalMoveParentReceiptsOnConnection(database, { ...original, maxRows: 1000, maxTotalBytes: 16 * 1024 ** 2 });
  const pathRows = await listWorkspaceOperationOriginalMovePathReceiptsOnConnection(database, { ...original, maxRows: 1000, maxTotalBytes: 64 * 1024 ** 2 });
  if (!parents || !pathRows) invalid();
  for (const parent of parents!) decodeWorkspaceOperationOriginalMoveParentReceipt(parent, intent);
  const paths = Object.freeze(pathRows!.map(path => decodeWorkspaceOperationOriginalMovePathReceipt(path, intent, parents!)));
  const completionRow = await readWorkspaceOperationOriginalMoveReceiptOnConnection(database, original);
  if (!completionRow) return Object.freeze({ apply: 'started', intent, paths, completion: null });
  const completion = decodeWorkspaceOperationOriginalMoveCompletion(completionRow, intent, parents!, pathRows!);
  const request = createWorkspaceOperationOriginalMoveAdmissionRequest(context, intent);
  const outcome = await readHistoricalCollaborationAdmissionOutcomeOnConnection(database, captureCollaborationAdmissionRequest(request), { readOnly: true });
  if (!outcome || outcome.version !== 1) invalid();
  const bundle = readWorkspaceOperationOriginalMoveNativeBundle(intent);
  if (bundle) {
    if (!completion.native || completion.native.operationId !== bundle.operationId) invalid();
    const set: Array<{ mutationId: string; receiptDigest: string }> = [];
    for (const mutation of bundle.mutations) {
      const applied = await readHistoricalNativeFileOperationReceiptOnConnection(database, { request, operationId: bundle.operationId,
        mutationId: mutation.mutationId, readOnly: true });
      const expected = completion.native!.receipts.find(item => item.mutationId === mutation.mutationId);
      if (!applied || !expected || applied.receiptDigest !== expected.receiptDigest) invalid();
      set.push({ mutationId: mutation.mutationId, receiptDigest: applied!.receiptDigest });
    }
    const proof = hash('canvas.native-file-receipt-set.v1\n' + set.map(item => `${item.mutationId}\t${item.receiptDigest}`).join('\n'));
    if (outcome.result.nativeFileReceiptSetProof !== proof) invalid();
    const effects = await readHistoricalNativeFileOperationSideEffectsOnConnection(database, { request, operationId: bundle.operationId,
      actor: bundle.actor, readOnly: true });
    if (completion.native!.sideEffectReceiptDigest === null) {
      if (effects || Object.hasOwn(outcome.result, 'nativeFileSideEffectSetProof')) invalid();
    } else {
      if (!effects || effects.nativeFileSideEffectSetProof !== hash(`canvas.native-file-side-effects.v1\n${completion.native!.sideEffectReceiptDigest}`)) invalid();
      if (outcome.result.nativeFileSideEffectSetProof !== effects!.nativeFileSideEffectSetProof) invalid();
    }
    const resultKeys = ['nativeFileReceiptSetProof', ...(completion.native!.sideEffectReceiptDigest === null ? [] : ['nativeFileSideEffectSetProof'])];
    if (!equal(Object.keys(outcome.result).sort(), resultKeys.sort())) invalid();
  } else if (completion.native !== null || Object.keys(outcome.result).length !== 0) invalid();
  return Object.freeze({ apply: 'complete', intent, paths, completion });
}

/** Current authenticated read plus immutable history. No workspace is converted
 * into a mutation principal or an execution claim for this GET-style path. */
export async function withWorkspaceOperationNativeMoveReadContext<T>(input: Input,
  operation: (context: ReadContext) => Promise<T>): Promise<T | null> {
  try {
    if (types.isProxy(input)) throw new WorkspaceOperationNativeMoveStatusError('BATCH_SCOPE_CHANGED');
    const field = Object.getOwnPropertyDescriptor(input, 'mcpPrincipal');
    if (field && (!field.enumerable || !Object.hasOwn(field, 'value'))) throw new WorkspaceOperationNativeMoveStatusError('BATCH_SCOPE_CHANGED');
    const mcpPrincipal = field?.value === undefined ? undefined : captureWorkspaceOperationMcpJobPrincipal(field.value);
    return await withWorkspaceOperationNativeBatchReadContext({ batchId: input.batchId, scope: input.scope,
      expectedPlan: input.expectedPlan, mcpPrincipal, planVersion: 3 }, async context => {
      const { database, schema, workspace, batch, plan } = context;
      if (plan.version !== 3 || batch.authorization.mode !== 'direct' && batch.authorization.mode !== 'direct-mcp') throw new WorkspaceOperationNativeMoveStatusError('BATCH_SCOPE_CHANGED');
      const auth = batch.authorization;
      const original: WorkspaceOperationOriginalMoveContext = { batchId: batch.batchId, requestHash: auth.requestHash,
        actor: { userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: auth.actorSessionId ?? null }, plan };
      let observation: WorkspaceOperationOriginalMoveObservation;
      try { observation = await observe(database, schema, original); }
      catch (error) { if (error instanceof WorkspaceOperationNativeMoveStatusError) throw error; invalid(error); }
      const status = Object.freeze({ batch, plan, observation: observation! });
      return operation(Object.freeze({ database, schema, workspace, status }));
    });
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeReadError) {
      throw new WorkspaceOperationNativeMoveStatusError(error.code, error.status, { cause: error.cause });
    }
    throw error;
  }
}
export function readWorkspaceOperationNativeMoveBatchStatus(input: Input): Promise<WorkspaceOperationNativeMoveBatchStatus | null> {
  return withWorkspaceOperationNativeMoveReadContext(input, async context => context.status);
}
