import 'server-only';

import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { workspaceOperationJobScopeMatches } from './workspace-operation-job-scope';
import { decodeWorkspaceOperationMcpAuthorization } from './workspace-operation-mcp-authorization';
import { parseIntent, completed, parseRestoreIntent, restored, WorkspaceOperationOriginalDeleteError,
  type OriginalIntent, type RestoreIntent, type WorkspaceOperationOriginalDeleteResult,
  type WorkspaceOperationOriginalRestoreResult, type WorkspaceOperationOriginalDeleteEvidenceContext } from './workspace-operation-original-delete-evidence';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection, readWorkspaceOperationOriginalDeleteReceiptOnConnection,
  readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection, readWorkspaceOperationOriginalRestoreIntentOnConnection,
  readWorkspaceOperationOriginalRestoreReceiptOnConnection, type WorkspaceOperationOriginalDeleteIntent,
  type WorkspaceOperationOriginalDeleteReceipt } from './workspace-operation-original-delete-repository';

/** Private factual journal observation. Neither classification nor decoded
 * original data grants a claim, actor permission, current target or owner-B. */
export type WorkspaceOperationOriginalDeleteObservation = Readonly<{
  apply: 'absent' | 'started' | 'complete';
  undo: 'absent' | 'unknown' | 'pristine' | 'started' | 'complete';
  deleteIntent: WorkspaceOperationOriginalDeleteIntent | null;
  deleteReceipt: WorkspaceOperationOriginalDeleteReceipt | null;
  deleteTrashReceipt: WorkspaceOperationOriginalDeleteReceipt | null;
  restoreIntent: WorkspaceOperationOriginalDeleteIntent | null;
  restoreReceipt: WorkspaceOperationOriginalDeleteReceipt | null;
  original: OriginalIntent | null; deleted: WorkspaceOperationOriginalDeleteResult | null;
  restoration: RestoreIntent | null; restored: WorkspaceOperationOriginalRestoreResult | null;
}>;
type Input = Readonly<{ schema: string; context: WorkspaceOperationOriginalDeleteEvidenceContext;
  workspace: WorkspaceContext; dataRoot: string }>;
function invalid(): never { throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN'); }

/** Snapshot only plain own data before awaiting borrowed SQL. No getters,
 * prototypes, current-path lookup or reconstructed capability is consulted. */
function capture<T>(value: T, depth = 0): T {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return value;
  if (depth > 16 || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length > 128) invalid();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    Object.defineProperty(result, key, { value: capture(descriptor.value, depth + 1), enumerable: true });
  }
  return Object.freeze(result) as T;
}

/** Five SELECTs on the caller's B, without checkout, transaction, locks, DDL,
 * mutation or finality assumption. Caller owns a consistent authorized read
 * scope; unreadable, orphaned and mismatched evidence throws rather than ACKs. */
export async function readWorkspaceOperationOriginalDeleteObservationOnConnection(database: SqlConnection,
  input: Input): Promise<WorkspaceOperationOriginalDeleteObservation> {
  const captured = capture(input), { schema, context, workspace, dataRoot } = captured;
  if (Reflect.ownKeys(captured).length !== 4 || Reflect.ownKeys(context).length !== 5
    || !['batchId', 'planId', 'workspaceId', 'authorization', 'sourcePath'].every(key => Object.hasOwn(context, key))
    || context.authorization.mode !== 'direct' && context.authorization.mode !== 'direct-mcp' || context.workspaceId !== workspace.workspaceId
    || !workspaceOperationJobScopeMatches(context.authorization.jobScope, workspace)
    || typeof context.sourcePath !== 'string' || !context.sourcePath || typeof dataRoot !== 'string' || !dataRoot) invalid();
  if (context.authorization.mode === 'direct-mcp'
    && decodeWorkspaceOperationMcpAuthorization(context.authorization).tool !== 'delete_knowledge_source') invalid();
  const selected = { schema, batchId: context.batchId };
  const deleteIntent = await readWorkspaceOperationOriginalDeleteIntentOnConnection(database, selected);
  const deleteReceipt = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(database, selected);
  const deleteTrashReceipt = await readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(database, selected);
  const restoreIntent = await readWorkspaceOperationOriginalRestoreIntentOnConnection(database, selected);
  const restoreReceipt = await readWorkspaceOperationOriginalRestoreReceiptOnConnection(database, selected);
  const records = { deleteIntent, deleteReceipt, deleteTrashReceipt, restoreIntent, restoreReceipt };
  if (!deleteIntent) {
    if (deleteReceipt || deleteTrashReceipt || restoreIntent || restoreReceipt) invalid();
    return Object.freeze({ ...records, apply: 'absent', undo: 'absent', original: null,
      deleted: null, restoration: null, restored: null });
  }
  const original = parseIntent(deleteIntent, context, workspace, dataRoot);
  if (!deleteReceipt) {
    if (deleteTrashReceipt || restoreIntent || restoreReceipt) invalid();
    return Object.freeze({ ...records, apply: 'started', undo: 'unknown', original,
      deleted: null, restoration: null, restored: null });
  }
  const deleted = completed(deleteReceipt, deleteTrashReceipt, deleteIntent, original);
  if (!restoreIntent) {
    if (restoreReceipt) invalid();
    return Object.freeze({ ...records, apply: 'complete', undo: 'pristine', original,
      deleted, restoration: null, restored: null });
  }
  const restoration = parseRestoreIntent(restoreIntent, context, workspace, original, deleteIntent, deleted);
  if (!restoreReceipt) return Object.freeze({ ...records, apply: 'complete', undo: 'started', original,
    deleted, restoration, restored: null });
  return Object.freeze({ ...records, apply: 'complete', undo: 'complete', original, deleted, restoration,
    restored: restored(restoreReceipt, restoreIntent, restoration, original) });
}
