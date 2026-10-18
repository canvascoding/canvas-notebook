import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import type * as YTypes from 'yjs';
import { Y } from '../collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../collaboration/types';
import { captureIdentity, nativeBudget, validateNativeDocumentEditCandidate } from '../collaboration/native-document-edit-validation';
import { assertNativeDocumentWithinReadBudget } from '../collaboration/native-search-budget';
import { collaborationStateProof } from '../collaboration/state-proof';
import { captureNativeDocumentEditOriginal, captureNativeDocumentEditAfter,
  type NativeDocumentEditOriginalV1, type NativeDocumentEditAfterV1 } from '../collaboration/native-document-edit-operation-contract';
import { documentVersionV1, type DocumentVersionIdentityV1 } from '../documents/read-version';
import { DocumentEditError } from '../documents/edit-contracts';
import type { WorkspaceContext } from '../workspaces/types';
import type { FileRevisionRecord } from '../files/collaboration-policy';
import type { FileVersionCenterTransaction } from './database';
import type { FileVersionContentBinding } from './version-content-store';
import { FILE_VERSION_CENTER_LIMITS_V1 } from './policy-v1';

export const NATIVE_OPERATION_HISTORY_FORMAT = 'native-yjs-update-v1' as const;
const MAX_JSON_BYTES = 64 * 1024;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
function invalid(): never { throw new DocumentEditError('EDIT_OUTCOME_UNCONFIRMED'); }
export type PreparedNativeAgentOperationHistorySnapshot = Readonly<
  { status: 'ready'; format: typeof NATIVE_OPERATION_HISTORY_FORMAT; bytes: Uint8Array; sha256: string;
    sizeBytes: number; stateProof: string; version: string; stateVector: Uint8Array }
  | { status: 'over_limit'; format: typeof NATIVE_OPERATION_HISTORY_FORMAT; sizeBytes: number | null }
>;
export type NativeAgentOperationHistoryCaptureInput = Readonly<{
  operationId: string; workspace: WorkspaceContext; original: NativeDocumentEditOriginalV1;
  after: NativeDocumentEditAfterV1; bytes: Uint8Array | null;
}>;
export type NativeAgentOperationHistoryCaptureResult = Readonly<{
  outcome: 'captured' | 'already_captured' | 'disabled' | 'over_limit' | 'quota_exceeded';
  revision: FileRevisionRecord | null; binding: FileVersionContentBinding | null;
  quotaCode?: 'raw_version_too_large' | 'stored_blob_too_large' | 'lineage_quota_exceeded'
    | 'workspace_quota_exceeded' | 'version_count_exceeded';
}>;

/** Only the real Room owner calls this synchronously after actual apply.
 * A history size refusal is independent of native persistence. The caller
 * persists this descriptor and exact bytes with its actual After receipt. */
export function prepareNativeAgentOperationHistorySnapshot(input: {
  doc: YTypes.Doc; identity: DocumentVersionIdentityV1;
}): PreparedNativeAgentOperationHistorySnapshot {
  const identity = captureIdentity(input.identity);
  if (identity.schemaVersion !== COLLABORATION_SCHEMA_VERSION) invalid();
  try { assertNativeDocumentWithinReadBudget(input.doc, nativeBudget); }
  catch (error) {
    const code = error && typeof error === 'object' && !types.isProxy(error)
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown : undefined;
    if (code === 'DOCUMENT_TOO_LARGE') return Object.freeze({ status: 'over_limit', format: NATIVE_OPERATION_HISTORY_FORMAT, sizeBytes: null });
    throw error;
  }
  const proof = collaborationStateProof(input.doc, Y); if (!proof) invalid();
  const bytes = Y.encodeStateAsUpdate(input.doc);
  if (bytes.byteLength > FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes) {
    return Object.freeze({ status: 'over_limit', format: NATIVE_OPERATION_HISTORY_FORMAT, sizeBytes: bytes.byteLength });
  }
  const clone = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(clone, bytes);
    if (validateNativeDocumentEditCandidate(clone, identity.representation) !== null
      || collaborationStateProof(clone, Y) !== proof) invalid();
    const stateVector = Y.encodeStateVector(clone);
    return Object.freeze({ status: 'ready', format: NATIVE_OPERATION_HISTORY_FORMAT,
      bytes, sha256: digest(bytes), sizeBytes: bytes.byteLength, stateProof: proof,
      version: documentVersionV1(identity, proof), stateVector });
  } finally { clone.destroy(); }
}

type OperationRow = {
  workspace_id: string; document_id: string; document_path: string | null;
  document_representation: string | null; document_lifecycle_generation: number | string | null;
  schema_version: number | string | null; initiated_by_user_id: string; actor_id: string;
  actor_session_id: string | null; original_bytes: number | string | null; after_bytes: number | string | null;
  original_json: string | null; after_json: string | null;
};
type PayloadRow = { workspace_id: string; original_proof: string; after_proof: string; format: string;
  sha256: string; size_bytes: number | string; actual_bytes: number | string; created_at: number | string };
export type CheckedNativeAgentOperationHistory = Readonly<{
  operationId: string; workspace: WorkspaceContext; original: NativeDocumentEditOriginalV1;
  after: NativeDocumentEditAfterV1; bytes: Uint8Array | null; stateVector: Uint8Array | null;
}>;

function assertCaptureInputData(input: NativeAgentOperationHistoryCaptureInput): void {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const keys = ['operationId', 'workspace', 'original', 'after', 'bytes'], descriptors = Object.getOwnPropertyDescriptors(input);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
}

/** Facts only, on the caller's B. The owner's actual principal and room fences
 * remain outside this module. Headers are bounded before JSON/blob transfer. */
export async function readNativeAgentOperationHistoryOnConnection(transaction: FileVersionCenterTransaction,
  input: NativeAgentOperationHistoryCaptureInput): Promise<CheckedNativeAgentOperationHistory> {
  assertCaptureInputData(input);
  if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.operationId)) invalid();
  const original = captureNativeDocumentEditOriginal(input.original), after = captureNativeDocumentEditAfter(input.after, original);
  if (original.identity.schemaVersion !== COLLABORATION_SCHEMA_VERSION) invalid();
  const workspace = input.workspace;
  if (!workspace || types.isProxy(workspace) || workspace.workspaceId !== original.identity.workspaceId
    || (workspace.organizationId ?? null) !== original.identity.organizationId
    || workspace.workspaceType !== original.origin.workspaceType
    || (workspace.customerId ?? null) !== original.origin.customerId
    || (workspace.projectId ?? null) !== original.origin.projectId) invalid();
  const rows = (await transaction.query<OperationRow>(`SELECT workspace_id,document_id,document_path,
    document_representation,document_lifecycle_generation,schema_version,initiated_by_user_id,actor_id,actor_session_id,
    octet_length(native_edit_original_json::text) AS original_bytes,octet_length(native_edit_after_json::text) AS after_bytes,
    CASE WHEN octet_length(native_edit_original_json::text)<=$3 THEN native_edit_original_json::text ELSE NULL END AS original_json,
    CASE WHEN octet_length(native_edit_after_json::text)<=$3 THEN native_edit_after_json::text ELSE NULL END AS after_json
    FROM collaboration_agent_operations WHERE operation_id=$1 AND workspace_id=$2 FOR SHARE`,
  [input.operationId,workspace.workspaceId,MAX_JSON_BYTES])).rows;
  if (rows.length !== 1) invalid(); const row = rows[0];
  if (row.workspace_id !== original.identity.workspaceId || row.document_id !== original.identity.documentId
    || row.document_path !== original.source.path || row.document_representation !== original.identity.representation
    || Number(row.document_lifecycle_generation) !== original.identity.lifecycleGeneration
    || Number(row.schema_version) !== original.identity.schemaVersion || row.initiated_by_user_id !== original.actor.userId
    || row.actor_id !== original.actor.actorId || row.actor_session_id !== original.actor.sessionId
    || typeof row.original_json !== 'string' || typeof row.after_json !== 'string'
    || !Number.isSafeInteger(Number(row.original_bytes)) || Number(row.original_bytes) < 1 || Number(row.original_bytes) > MAX_JSON_BYTES
    || !Number.isSafeInteger(Number(row.after_bytes)) || Number(row.after_bytes) < 1 || Number(row.after_bytes) > MAX_JSON_BYTES) invalid();
  let actualOriginal: NativeDocumentEditOriginalV1, actualAfter: NativeDocumentEditAfterV1;
  try { actualOriginal = captureNativeDocumentEditOriginal(JSON.parse(row.original_json));
    actualAfter = captureNativeDocumentEditAfter(JSON.parse(row.after_json), actualOriginal); }
  catch { return invalid(); }
  if (!isDeepStrictEqual(actualOriginal, original) || !isDeepStrictEqual(actualAfter, after)) invalid();
  const payloads = (await transaction.query<PayloadRow>(`SELECT workspace_id,original_proof,after_proof,format,sha256,size_bytes,
    octet_length(yjs_update) AS actual_bytes,created_at FROM collaboration_agent_native_edit_payloads
    WHERE operation_id=$1 FOR SHARE`, [input.operationId])).rows;
  if (after.history.status === 'over_limit') {
    if (input.bytes !== null || payloads.length !== 0) invalid();
    return Object.freeze({ operationId: input.operationId, workspace, original, after, bytes: null, stateVector: null });
  }
  if (payloads.length !== 1 || !types.isUint8Array(input.bytes) || types.isProxy(input.bytes)) invalid();
  const size: unknown = Reflect.apply(typedArrayByteLength, input.bytes, []);
  if (size !== after.history.sizeBytes || Number(size) > FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes) invalid();
  const bytes = new Uint8Array(input.bytes), payload = payloads[0];
  if (bytes.byteLength !== after.history.sizeBytes || digest(bytes) !== after.history.sha256
    || payload.workspace_id !== workspace.workspaceId || payload.original_proof !== original.originalProof
    || payload.after_proof !== after.afterProof || payload.format !== NATIVE_OPERATION_HISTORY_FORMAT
    || payload.sha256 !== after.history.sha256 || Number(payload.size_bytes) !== after.history.sizeBytes
    || Number(payload.actual_bytes) !== after.history.sizeBytes
    || !Number.isSafeInteger(Number(payload.created_at)) || Number(payload.created_at) < 0) invalid();
  const stored = (await transaction.query<{ yjs_update: Uint8Array }>(`SELECT yjs_update
    FROM collaboration_agent_native_edit_payloads WHERE operation_id=$1 AND workspace_id=$2
      AND original_proof=$3 AND after_proof=$4 AND format=$5 AND sha256=$6 AND size_bytes=$7
      AND octet_length(yjs_update)=$7 AND size_bytes<=$8`, [input.operationId,workspace.workspaceId,original.originalProof,
    after.afterProof,NATIVE_OPERATION_HISTORY_FORMAT,after.history.sha256,after.history.sizeBytes,
    FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes])).rows;
  if (stored.length !== 1 || !types.isUint8Array(stored[0].yjs_update)
    || !Buffer.from(stored[0].yjs_update).equals(Buffer.from(bytes))) invalid();
  const clone = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(clone, bytes);
    const proof = collaborationStateProof(clone, Y), stateVector = Y.encodeStateVector(clone);
    if (!proof) invalid();
    if (validateNativeDocumentEditCandidate(clone, original.identity.representation) !== null
      || proof !== after.stateProof || documentVersionV1(original.identity, proof) !== after.afterVersion
      || digest(stateVector) !== after.stateVectorHash) invalid();
    return Object.freeze({ operationId: input.operationId, workspace, original, after, bytes, stateVector });
  } catch { return invalid(); } finally { clone.destroy(); }
}

/** Caller owns B/COMMIT/release. A private savepoint prevents quota/refusal from
 * leaving a half-created HistoryOnly revision in an otherwise successful B. */
export async function captureNativeAgentOperationHistoryOnConnection(transaction: FileVersionCenterTransaction,
  input: NativeAgentOperationHistoryCaptureInput): Promise<NativeAgentOperationHistoryCaptureResult> {
  const { createFileVersionHistoryService } = await import('./history-service');
  const database = { transaction: async <T>(action: (tx: FileVersionCenterTransaction) => Promise<T>): Promise<T> => {
    const name = `canvas_native_history_${randomUUID().replaceAll('-', '')}`;
    await transaction.query(`SAVEPOINT "${name}"`);
    try { const result = await action(transaction); await transaction.query(`RELEASE SAVEPOINT "${name}"`); return result; }
    catch (error) {
      try { await transaction.query(`ROLLBACK TO SAVEPOINT "${name}"`); await transaction.query(`RELEASE SAVEPOINT "${name}"`); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Native operation history savepoint cleanup failed.'); }
      throw error;
    }
  } };
  return createFileVersionHistoryService({ database }).captureNativeAgentOperation(input);
}
