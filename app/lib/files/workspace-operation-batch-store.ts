import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { decodeWorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-native-delete-plan';
import { decodeWorkspaceOperationNativeMoveBatchPlan, type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { decodeWorkspaceOperationMcpAuthorization, createWorkspaceOperationMcpAuthorization,
  assertWorkspaceOperationMcpAuthorizationCurrent, workspaceOperationMcpBatchId } from './workspace-operation-mcp-authorization';
import { assertDirectMcpWorkspaceMovePrincipalCaptured, assertDirectMcpWorkspaceDeletePrincipalCaptured,
  withDirectMcpWorkspaceMovePrincipalOnConnection, withDirectMcpWorkspaceDeletePrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipal, type DirectMcpWorkspaceDeletePrincipal,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { assertWorkspaceFileUndoEnabled } from './workspace-file-undo-policy';
import { workspaceOperationBatchTotalActions } from './workspace-operation-native-delete-effects';
import type { WorkspaceOperationBatchAuthorization, WorkspaceOperationDirectAuthorization,
  WorkspaceOperationBatchPlan, WorkspaceOperationBatchProgress,
  WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';

export type WorkspaceOperationBatchStatus = 'preview' | 'blocked' | 'queued' | 'applying' | 'applied'
  | 'needs_review' | 'needs_recovery' | 'failed' | 'undone';
export type WorkspaceOperationBatchReviewRef = { reviewId: string; planId: string; status: string };
export type WorkspaceOperationBatchRecord = {
  batchId: string; planId: string; workspaceId: string; reviewIds: string[];
  reviewRefs: WorkspaceOperationBatchReviewRef[]; plan: WorkspaceOperationBatchPlan;
  authorization: WorkspaceOperationBatchAuthorization;
  status: WorkspaceOperationBatchStatus; actionMode: 'apply' | 'undo';
  reviewerUserId: string | null; reviewerDisplayName: string | null;
  completedActions: number; totalActions: number; phase: WorkspaceOperationBatchProgress['phase'];
  errorCode: string | null; trashEntryIds: string[]; leaseOwner: string | null;
  createdAt: number; updatedAt: number;
};

export class WorkspaceOperationBatchError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message); this.name = 'WorkspaceOperationBatchError';
  }
}

declare const claimBrand: unique symbol;
/** Private claim provenance only; this grants no actor, SQL-owner or file authority. */
export type WorkspaceOperationBatchClaim = Readonly<{ [claimBrand]: true }>;
export type WorkspaceOperationBatchClaimBinding = Readonly<{
  batchId: string; planId: string; workspaceId: string; plan: WorkspaceOperationBatchPlan;
  authorization: WorkspaceOperationBatchAuthorization; actionMode: 'apply' | 'undo';
  totalActions: number; createdAt: number; reviewIds: string[]; reviewRefs: WorkspaceOperationBatchReviewRef[];
  reviewerUserId: string | null; reviewerDisplayName: string | null;
  source: Readonly<{ databaseOid: number; schemaOid: number; schemaName: string; tableOid: number; searchPath: string }>;
}>;
type Runtime = { connect: () => Promise<SqlConnection>; now: () => number };
type ClaimCapture = {
  store: WorkspaceOperationBatchStore; runtime: Runtime; original: WorkspaceOperationBatchRecord;
  binding: WorkspaceOperationBatchClaimBinding; originalFingerprint: string;
  planBytes: string; authorizationBytes: string; reviewIdsBytes: string; reviewRefsBytes: string;
  leaseOwner: string; leaseToken: string; expiresAt: number;
  state: 'claimed' | 'active' | 'closed'; accepting: boolean; failure: unknown;
  pending: Set<Promise<unknown>>; capability?: WorkspaceOperationBatchClaim; finished: boolean;
};
const runtimes = new WeakMap<WorkspaceOperationBatchStore, Runtime>();
const claimedRows = new WeakMap<object, ClaimCapture>();
const claims = new WeakMap<object, ClaimCapture>();
const claimContext = new AsyncLocalStorage<ClaimCapture>();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const relation = (binding: WorkspaceOperationBatchClaimBinding) => `${quote(binding.source.schemaName)}.workspace_file_operation_batches`;
function claimError(code: string, status = 409): WorkspaceOperationBatchError {
  return new WorkspaceOperationBatchError(code, status, 'The original file action claim is unavailable.');
}
function claimFailure(error: unknown): Error { return error instanceof Error ? error : claimError('BATCH_CLAIM_FAILED'); }
function poisonClaim(captured: ClaimCapture, error: unknown): never {
  const failure = claimFailure(error);
  captured.failure ??= failure;
  const active = claimContext.getStore();
  if (active && active !== captured) active.failure ??= failure;
  throw failure;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function fingerprint(batch: WorkspaceOperationBatchRecord): string {
  return JSON.stringify([batch.batchId, batch.planId, batch.workspaceId, batch.plan, batch.authorization,
    batch.actionMode, batch.totalActions, batch.createdAt, batch.leaseOwner,
    batch.reviewIds, batch.reviewRefs, batch.reviewerUserId, batch.reviewerDisplayName]);
}
function claimCurrent(captured: ClaimCapture, finalizing = false): void {
  try {
    if (runtimes.get(captured.store) !== captured.runtime || claimedRows.get(captured.original) !== captured
      || !finalizing && (captured.state !== 'active' || !captured.accepting || claimContext.getStore() !== captured)) {
      throw claimError('BATCH_CLAIM_REQUIRED');
    }
    if (!finalizing && captured.failure !== undefined) throw captured.failure;
    if (fingerprint(captured.original) !== captured.originalFingerprint) throw claimError('BATCH_CLAIM_CHANGED');
    if (!Number.isSafeInteger(captured.runtime.now()) || captured.runtime.now() >= captured.expiresAt) throw claimError('BATCH_CLAIM_EXPIRED');
  } catch (error) { poisonClaim(captured, error); }
}
function originalClaim(store: WorkspaceOperationBatchStore, original: WorkspaceOperationBatchRecord): ClaimCapture {
  const captured = original && typeof original === 'object' ? claimedRows.get(original) : undefined;
  if (!captured || captured.store !== store || runtimes.get(store) !== captured.runtime) {
    const error = claimError('BATCH_CLAIM_REQUIRED'), active = claimContext.getStore();
    if (active) poisonClaim(active, error);
    throw error;
  }
  return captured;
}
function trackedClaim<T>(captured: ClaimCapture, operation: () => Promise<T>): Promise<T> {
  const pending = (async () => {
    try { return await operation(); } catch (error) { poisonClaim(captured, error); }
  })();
  captured.pending.add(pending);
  void pending.then(() => captured.pending.delete(pending), () => captured.pending.delete(pending));
  return pending;
}
function parseClaimSourceRow(row: Record<string, unknown> | undefined, oid: number): WorkspaceOperationBatchClaimBinding['source'] {
  if (!row || Number(row.table_oid) !== oid || !Number.isSafeInteger(Number(row.schema_oid)) || Number(row.schema_oid) < 1
    || typeof row.schema_name !== 'string' || !row.schema_name || row.schema_name.length > 63 || /[\u0000-\u001f\u007f]/u.test(row.schema_name)
    || row.schema_name.startsWith('pg_') || row.relname !== 'workspace_file_operation_batches' || row.relkind !== 'r' || row.relpersistence !== 'p'
    || typeof row.search_path !== 'string' || !row.search_path || row.search_path.length > 4096
    || !Number.isSafeInteger(Number(row.database_oid)) || Number(row.database_oid) < 1) throw claimError('BATCH_CLAIM_CHANGED');
  return Object.freeze({ databaseOid: Number(row.database_oid), schemaOid: Number(row.schema_oid), schemaName: row.schema_name,
    tableOid: oid, searchPath: row.search_path });
}
async function readClaimSource(database: SqlConnection, tableOid: unknown): Promise<WorkspaceOperationBatchClaimBinding['source']> {
  const oid = Number(tableOid);
  if (!Number.isSafeInteger(oid) || oid < 1) throw claimError('BATCH_CLAIM_CHANGED');
  const row = await database.get(`SELECT c.oid::bigint AS table_oid,n.oid::bigint AS schema_oid,n.nspname AS schema_name,
    c.relname,c.relkind,c.relpersistence,pg_catalog.current_setting('search_path') AS search_path,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1::pg_catalog.oid`, [oid]) as Record<string, unknown> | undefined;
  return parseClaimSourceRow(row, oid);
}
async function assertClaimSource(database: SqlConnection, captured: Pick<ClaimCapture, 'binding'>): Promise<void> {
  const current = await readClaimSource(database, captured.binding.source.tableOid), expected = captured.binding.source;
  if (Object.keys(expected).some(key => current[key as keyof typeof current] !== expected[key as keyof typeof expected])) {
    throw claimError('BATCH_CLAIM_CHANGED');
  }
  const resolved = await database.get(`SELECT pg_catalog.to_regclass('workspace_file_operation_batches')::oid::bigint AS table_oid,
    pg_catalog.to_regclass($1)::oid::bigint AS qualified_oid`, [relation(captured.binding)]) as Record<string, unknown> | undefined;
  if (Number(resolved?.table_oid) !== expected.tableOid || Number(resolved?.qualified_oid) !== expected.tableOid) throw claimError('BATCH_CLAIM_CHANGED');
}
const claimPredicates = `batch_id=$1 AND lease_owner=$2 AND lease_token=$3 AND status='applying'
  AND lease_expires_at>$4 AND plan_id=$5 AND workspace_id=$6 AND plan_json=$7 AND authorization_json=$8
  AND action_mode=$9 AND total_actions=$10 AND created_at=$11 AND tableoid=$12::pg_catalog.oid
  AND review_ids_json=$13 AND review_refs_json=$14 AND reviewer_user_id IS NOT DISTINCT FROM $15
  AND reviewer_display_name IS NOT DISTINCT FROM $16`;
function claimParameters(captured: ClaimCapture): unknown[] {
  const binding = captured.binding;
  return [binding.batchId, captured.leaseOwner, captured.leaseToken, captured.runtime.now(), binding.planId,
    binding.workspaceId, captured.planBytes, captured.authorizationBytes, binding.actionMode, binding.totalActions, binding.createdAt,
    binding.source.tableOid, captured.reviewIdsBytes, captured.reviewRefsBytes, binding.reviewerUserId, binding.reviewerDisplayName];
}

async function claimConnection<T>(captured: Pick<ClaimCapture, 'runtime'>, operation: (database: SqlConnection) => Promise<T>): Promise<T> {
  const database = await captured.runtime.connect();
  let value: T | undefined, failure: unknown;
  try { value = await operation(database); } catch (error) { failure = claimFailure(error); }
  try { await database.close(); }
  catch (error) { failure = failure === undefined ? claimFailure(error) : new AggregateError([failure, claimFailure(error)], 'File action claim checkout cleanup failed.'); }
  if (failure !== undefined) throw failure;
  return value as T;
}

/** Original frozen facts for preparation only. No fresh DB, actor, ACL or SQL-owner proof. */
export function readWorkspaceOperationBatchClaimBinding(claim: WorkspaceOperationBatchClaim): WorkspaceOperationBatchClaimBinding {
  const captured = claim && typeof claim === 'object' ? claims.get(claim) : undefined;
  if (!captured) {
    const error = claimError('BATCH_CLAIM_REQUIRED'), active = claimContext.getStore();
    if (active) poisonClaim(active, error);
    throw error;
  }
  claimCurrent(captured);
  if (captured.finished) poisonClaim(captured, claimError('BATCH_CLAIM_REQUIRED'));
  return captured.binding;
}

/** Borrowed short transaction only. Never opens/closes/commits B, and grants no actor or lifecycle-owner authority. */
export function assertWorkspaceOperationBatchClaimOnConnection(database: SqlConnection,
  claim: WorkspaceOperationBatchClaim): Promise<WorkspaceOperationBatchClaimBinding> {
  const captured = claim && typeof claim === 'object' ? claims.get(claim) : undefined;
  if (!captured) {
    const error = claimError('BATCH_CLAIM_REQUIRED'), active = claimContext.getStore();
    if (active) { try { poisonClaim(active, error); } catch { /* The same failure is returned below. */ } }
    return Promise.reject(error);
  }
  return trackedClaim(captured, async () => {
    claimCurrent(captured);
    if (captured.binding.authorization.mode !== 'review' && (!captured.binding.authorization.jobScope
      || captured.binding.authorization.jobScope.workspaceId !== captured.binding.workspaceId)) throw claimError('BATCH_CLAIM_CHANGED');
    const first = await database.get(`SELECT pg_catalog.pg_current_xact_id()::text AS transaction_id,
      pg_catalog.current_setting('transaction_isolation') AS isolation,
      pg_catalog.current_setting('transaction_read_only') AS read_only,
      c.oid::bigint AS table_oid,n.oid::bigint AS schema_oid,n.nspname AS schema_name,
      c.relname,c.relkind,c.relpersistence,pg_catalog.current_setting('search_path') AS search_path,
      (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
      pg_catalog.to_regclass('workspace_file_operation_batches')::oid::bigint AS resolved_table_oid,
      pg_catalog.to_regclass($2)::oid::bigint AS qualified_oid
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid=$1::pg_catalog.oid`, [captured.binding.source.tableOid, relation(captured.binding)]) as Record<string, unknown> | undefined;
    if (first?.isolation !== 'read committed' || first.read_only !== 'off') throw claimError('BATCH_CLAIM_CHANGED');
    claimCurrent(captured);
    const current = parseClaimSourceRow(first, captured.binding.source.tableOid), expected = captured.binding.source;
    if (Object.keys(expected).some(key => current[key as keyof typeof current] !== expected[key as keyof typeof expected])) {
      throw claimError('BATCH_CLAIM_CHANGED');
    }
    if (Number(first.resolved_table_oid) !== expected.tableOid || Number(first.qualified_oid) !== expected.tableOid) throw claimError('BATCH_CLAIM_CHANGED');
    const row = await database.get(`WITH held_claim AS MATERIALIZED (
      SELECT tableoid::oid::bigint AS table_oid FROM ${relation(captured.binding)}
        WHERE ${claimPredicates}
          AND lease_expires_at>floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint
        FOR SHARE NOWAIT
      )
      SELECT held_claim.table_oid,pg_catalog.pg_current_xact_id_if_assigned()::text AS transaction_id,
        floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint AS server_now
      FROM held_claim`, claimParameters(captured)) as Record<string, unknown> | undefined;
    claimCurrent(captured);
    if (!row || Number(row.table_oid) !== captured.binding.source.tableOid) throw claimError('BATCH_CLAIM_CHANGED');
    claimCurrent(captured);
    if (!first || typeof first.transaction_id !== 'string' || !/^[0-9]{1,32}$/u.test(first.transaction_id)
      || row.transaction_id !== first.transaction_id) throw claimError('BATCH_CLAIM_CHANGED');
    if (!Number.isSafeInteger(Number(row.server_now)) || Number(row.server_now) >= captured.expiresAt) throw claimError('BATCH_CLAIM_EXPIRED');
    return captured.binding;
  });
}

function authorization(value: unknown): WorkspaceOperationBatchAuthorization {
  if (value === undefined || value === null) return { mode: 'review' };
  const parsed = JSON.parse(String(value)) as WorkspaceOperationBatchAuthorization;
  if (parsed?.mode === 'review') return { mode: 'review' };
  if (parsed?.mode === 'direct-mcp') return decodeWorkspaceOperationMcpAuthorization(parsed);
  if (parsed?.mode !== 'direct' || ![parsed.actorUserId, parsed.actorId, parsed.actorDisplayName]
    .every((field) => typeof field === 'string' && field.trim().length > 0)
    || !['user', 'agent'].includes(parsed.actorType) || typeof parsed.requestHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(parsed.requestHash)
    || parsed.actorType === 'agent' && (typeof parsed.actorSessionId !== 'string' || !parsed.actorSessionId.trim())) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'File action authorization is unavailable.');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'jobScope')) {
    try { parsed.jobScope = parseWorkspaceOperationJobScope(parsed.jobScope); }
    catch { throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'File action job scope is unavailable.'); }
  }
  return parsed;
}

function directInputData(input: unknown, key: string, optional = false): unknown {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'Direct file action data is required.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor && optional) return undefined;
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'Direct file action data is required.');
  }
  return descriptor.value;
}

/** Copy primitive authorization and its exact scope before any database await. */
function captureDirectAuthorization(input: unknown): WorkspaceOperationDirectAuthorization {
  const required = ['mode', 'actorUserId', 'actorId', 'actorDisplayName', 'actorType', 'requestHash'];
  const optional = ['actorSessionId', 'jobScope'];
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'Direct file action authorization is required.');
  }
  const captured = Object.fromEntries(required.map(key => [key, directInputData(input, key)]));
  for (const key of optional) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = directInputData(input, key);
    if (key === 'jobScope') {
      try { captured.jobScope = parseWorkspaceOperationJobScope(value); }
      catch { throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'File action job scope is unavailable.'); }
    } else if (value !== undefined && typeof value !== 'string') {
      throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'Direct file action session is invalid.');
    } else captured[key] = value;
  }
  if (required.some(key => typeof captured[key] !== 'string')) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'Direct file action authorization is required.');
  }
  const parsed = authorization(JSON.stringify(captured));
  if (parsed.mode !== 'direct') {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'Direct file action authorization is required.');
  }
  return Object.freeze(parsed);
}

export function workspaceOperationBatchAuthorityUserId(batch: WorkspaceOperationBatchRecord): string | null {
  return batch.authorization?.mode === 'direct' || batch.authorization?.mode === 'direct-mcp'
    ? batch.authorization.actorUserId : batch.reviewerUserId;
}

function decodeStoredPlan(input: unknown): WorkspaceOperationBatchPlan {
  let version: unknown;
  try {
    version = directInputData(input, 'version');
    if ((version === 2 || version === 3) && directInputData(input, 'kind')
      !== (version === 2 ? 'native-original-delete' : 'native-path-change')) {
      throw claimError('BATCH_INVALID_PLAN');
    }
  } catch { throw claimError('BATCH_INVALID_PLAN'); }
  if (version === 2) return decodeWorkspaceOperationNativeDeleteBatchPlan(input);
  if (version === 3) return decodeWorkspaceOperationNativeMoveBatchPlan(input);
  // Never reinterpret a downgraded/unknown native envelope as historical V1.
  if (version !== 1 || ['kind', 'sourceEvidence', 'nativeTarget', 'nativeGraphPlan', 'nativePathPlan', 'compilerPlanProof',
    'finalGraphProof', 'executionReady'].some(key => Object.hasOwn(input as object, key))) {
    throw claimError('BATCH_INVALID_PLAN');
  }
  try {
    const linkPlan = directInputData(input, 'linkPlan');
    const kind = directInputData(linkPlan, 'kind'), planId = directInputData(linkPlan, 'planId'), readiness = directInputData(linkPlan, 'readiness');
    if (directInputData(linkPlan, 'contractVersion') !== 1 || directInputData(linkPlan, 'status') !== 'planned'
      || typeof kind !== 'string' || !['rename', 'move', 'copy', 'overwrite', 'delete'].includes(kind)
      || typeof planId !== 'string' || !/^[a-f0-9]{64}$/u.test(planId)
      || typeof readiness !== 'string' || !['ready', 'blocked'].includes(readiness)
      || typeof directInputData(linkPlan, 'recoveryReady') !== 'boolean') throw claimError('BATCH_INVALID_PLAN');
    for (const key of ['pathMappings', 'linkEdits', 'expectedPathState', 'collisions', 'issues', 'previewContents']) {
      const array = directInputData(linkPlan, key);
      if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype) throw claimError('BATCH_INVALID_PLAN');
    }
    const coverage = directInputData(linkPlan, 'coverage');
    if (typeof directInputData(coverage, 'complete') !== 'boolean'
      || !Array.isArray(directInputData(coverage, 'omittedSources')) || !Array.isArray(directInputData(coverage, 'unresolvedLinks'))) {
      throw claimError('BATCH_INVALID_PLAN');
    }
  } catch { throw claimError('BATCH_INVALID_PLAN'); }
  return input as WorkspaceOperationBatchPlan;
}

function record(row: Record<string, unknown>): WorkspaceOperationBatchRecord {
  const planText = String(row.plan_json);
  // Existing V1 content budgets can legitimately exceed the native DTO budget.
  // Bound the initial JSON allocation, then strictly decode V2 before minting
  // any genuine claim or returning stored native plan data.
  if (Buffer.byteLength(planText) > 256 * 1024 * 1024) throw claimError('BATCH_INVALID_PLAN');
  const plan = decodeStoredPlan(JSON.parse(planText));
  const parsedAuthorization = authorization(row.authorization_json);
  if (plan?.version !== 1 && (plan.planId !== row.plan_id || plan.workspaceId !== row.workspace_id)) throw claimError('BATCH_INVALID_PLAN');
  if (plan?.version !== 1 && parsedAuthorization.mode !== 'review'
    && !isDeepStrictEqual(plan.sourceEvidence.workspaceScope, parsedAuthorization.jobScope)) throw claimError('BATCH_INVALID_PLAN');
  if (parsedAuthorization.mode === 'direct-mcp' && (row.action_mode !== 'apply'
    || (parsedAuthorization.tool === 'move_knowledge_source' ? plan.version !== 3 : plan.version !== 2)
    || String(row.review_ids_json) !== '[]' || String(row.review_refs_json) !== '[]'
    || row.reviewer_user_id !== null || row.reviewer_display_name !== null
    || workspaceOperationBatchTotalActions(plan) !== Number(row.total_actions))) throw claimError('BATCH_INVALID_PLAN');
  return {
    batchId: String(row.batch_id), planId: String(row.plan_id), workspaceId: String(row.workspace_id),
    reviewIds: JSON.parse(String(row.review_ids_json)), reviewRefs: JSON.parse(String(row.review_refs_json)),
    authorization: parsedAuthorization,
    plan, status: row.status as WorkspaceOperationBatchStatus,
    actionMode: row.action_mode as 'apply' | 'undo', reviewerUserId: row.reviewer_user_id == null ? null : String(row.reviewer_user_id),
    reviewerDisplayName: row.reviewer_display_name == null ? null : String(row.reviewer_display_name),
    completedActions: Number(row.completed_actions), totalActions: Number(row.total_actions),
    phase: row.phase as WorkspaceOperationBatchProgress['phase'], errorCode: row.error_code == null ? null : String(row.error_code),
    trashEntryIds: JSON.parse(String(row.trash_entry_ids_json)), leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** Pure stored-row decoding. This does not mint a claim or grant current rights. */
export function decodeWorkspaceOperationBatchRecord(row: Record<string, unknown>): WorkspaceOperationBatchRecord {
  return record(row);
}

type ReturnedClaim = {
  batch: WorkspaceOperationBatchRecord; binding: WorkspaceOperationBatchClaimBinding;
  planBytes: string; authorizationBytes: string; reviewIdsBytes: string; reviewRefsBytes: string;
  owner: string; token: string; expiresAt: number;
};
/** Only actual RETURNING rows and their same-B relation proof enter here. */
function captureReturnedClaim(row: Record<string, unknown>, source: WorkspaceOperationBatchClaimBinding['source'],
  owner: string, token: string, expiresAt: number): ReturnedClaim {
  if (typeof row.plan_json !== 'string' || typeof row.authorization_json !== 'string'
    || typeof row.review_ids_json !== 'string' || typeof row.review_refs_json !== 'string'
    || row.lease_token !== token || row.lease_owner !== owner || Number(row.lease_expires_at) !== expiresAt
    || Number(row.claim_table_oid) !== source.tableOid) throw claimError('BATCH_CLAIM_CHANGED');
  const batch = record(row), planBytes = row.plan_json, authorizationBytes = row.authorization_json;
  const reviewIdsBytes = row.review_ids_json, reviewRefsBytes = row.review_refs_json;
  const binding = frozen({ batchId: batch.batchId, planId: batch.planId, workspaceId: batch.workspaceId,
    plan: JSON.parse(planBytes) as WorkspaceOperationBatchPlan, authorization: authorization(authorizationBytes),
    actionMode: batch.actionMode, totalActions: batch.totalActions, createdAt: batch.createdAt,
    reviewIds: JSON.parse(reviewIdsBytes) as string[], reviewRefs: JSON.parse(reviewRefsBytes) as WorkspaceOperationBatchReviewRef[],
    reviewerUserId: batch.reviewerUserId, reviewerDisplayName: batch.reviewerDisplayName, source });
  return { batch, binding, planBytes, authorizationBytes, reviewIdsBytes, reviewRefsBytes, owner, token, expiresAt };
}
/** Registration is deliberately separate from SQL/COMMIT/awaited disposal. */
function registerClaimedBatch(store: WorkspaceOperationBatchStore, runtime: Runtime, selected: ReturnedClaim): void {
  claimedRows.set(selected.batch, { store, runtime, original: selected.batch, binding: selected.binding,
    originalFingerprint: fingerprint(selected.batch), planBytes: selected.planBytes, authorizationBytes: selected.authorizationBytes,
    reviewIdsBytes: selected.reviewIdsBytes, reviewRefsBytes: selected.reviewRefsBytes,
    leaseOwner: selected.owner, leaseToken: selected.token, expiresAt: selected.expiresAt,
    state: 'claimed', accepting: false, failure: undefined, pending: new Set(), finished: false });
}

export type WorkspaceOperationMcpClaimResult = Readonly<
  { kind: 'claimed'; batch: WorkspaceOperationBatchRecord }
  | { kind: 'historical-header'; batch: WorkspaceOperationBatchRecord }
  | { kind: 'absent' }
>;
type McpSelection = Readonly<{ kind: 'move'; principal: DirectMcpWorkspaceMovePrincipal }>
  | Readonly<{ kind: 'delete'; principal: DirectMcpWorkspaceDeletePrincipal }>;
type McpCommand = Readonly<{ operationId: string; workspaceId: string }> & (
  Readonly<{ mode: 'create'; plan: WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationNativeDeleteBatchPlan }>
  | Readonly<{ mode: 'existing'; planId: string }>
);
type McpAccess = DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess;
function mcpSelection(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== names.length || names.some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) throw claimError('BATCH_INVALID_REQUEST');
  return input as Record<string, unknown>;
}
function captureMcpCreateInput(kind: McpSelection['kind'], input: unknown): McpCommand {
  const selected = mcpSelection(input, ['operationId', 'plan']);
  const plan = kind === 'move' ? decodeWorkspaceOperationNativeMoveBatchPlan(selected.plan)
    : decodeWorkspaceOperationNativeDeleteBatchPlan(selected.plan);
  if (typeof selected.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(selected.operationId)
    || plan.readiness !== 'ready') throw claimError('BATCH_INVALID_REQUEST');
  return Object.freeze({ mode: 'create', operationId: selected.operationId, workspaceId: plan.workspaceId, plan });
}
function captureMcpExistingInput(input: unknown): McpCommand {
  const selected = mcpSelection(input, ['operationId', 'workspaceId', 'planId']);
  if (typeof selected.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(selected.operationId)
    || typeof selected.workspaceId !== 'string' || !selected.workspaceId || selected.workspaceId.length > 256
    || selected.workspaceId !== selected.workspaceId.trim() || /[\u0000-\u001f\u007f]/u.test(selected.workspaceId)
    || Buffer.from(selected.workspaceId).toString('utf8') !== selected.workspaceId
    || typeof selected.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(selected.planId)) throw claimError('BATCH_INVALID_REQUEST');
  return Object.freeze({ mode: 'existing', operationId: selected.operationId, workspaceId: selected.workspaceId, planId: selected.planId });
}
function withMcpStorePolicy<T>(database: SqlConnection, selected: McpSelection,
  operation: (access: McpAccess) => Promise<T>): Promise<T> {
  return selected.kind === 'move'
    ? withDirectMcpWorkspaceMovePrincipalOnConnection(database, selected.principal, operation)
    : withDirectMcpWorkspaceDeletePrincipalOnConnection(database, selected.principal, operation);
}
async function assertMcpClaimSource(database: SqlConnection,
  expected?: WorkspaceOperationBatchClaimBinding['source']): Promise<WorkspaceOperationBatchClaimBinding['source']> {
  const row = await database.get(`SELECT pg_catalog.to_regclass('workspace_file_operation_batches')::oid::bigint AS table_oid,
    pg_catalog.current_schema() AS schema_name,pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid`) as Record<string, unknown> | undefined;
  const source = await readClaimSource(database, row?.table_oid);
  if (source.schemaName !== row?.schema_name || source.schemaOid !== Number(row?.schema_oid)
    || expected && !isDeepStrictEqual(source, expected)) throw claimError('BATCH_CLAIM_CHANGED');
  const qualified = await database.get(`SELECT pg_catalog.to_regclass($1)::oid::bigint AS table_oid`,
    [`${quote(source.schemaName)}.workspace_file_operation_batches`]) as Record<string, unknown> | undefined;
  if (Number(qualified?.table_oid) !== source.tableOid) throw claimError('BATCH_CLAIM_CHANGED');
  return source;
}
async function readMcpJobRow(database: SqlConnection, source: WorkspaceOperationBatchClaimBinding['source'], batchId: string) {
  const row = await database.get(`SELECT batch_id,plan_id,workspace_id,
    CASE WHEN octet_length(review_ids_json)<=2 THEN review_ids_json END AS review_ids_json,
    CASE WHEN octet_length(review_refs_json)<=2 THEN review_refs_json END AS review_refs_json,
    CASE WHEN octet_length(plan_json)<=16777216 THEN plan_json END AS plan_json,
    CASE WHEN octet_length(authorization_json)<=65536 THEN authorization_json END AS authorization_json,
    status,action_mode,reviewer_user_id,reviewer_display_name,completed_actions,total_actions,phase,
    CASE WHEN octet_length(error_code)<=256 THEN error_code END AS error_code,
    octet_length(error_code) AS error_code_bytes,
    CASE WHEN octet_length(trash_entry_ids_json)<=65536 THEN trash_entry_ids_json END AS trash_entry_ids_json,
    lease_owner,lease_expires_at,lease_token,created_at,updated_at,tableoid::oid::bigint AS claim_table_oid
    FROM ${quote(source.schemaName)}.workspace_file_operation_batches WHERE batch_id=$1`, [batchId]) as Record<string, unknown> | undefined;
  if (row && (typeof row.plan_json !== 'string' || typeof row.authorization_json !== 'string'
    || row.review_ids_json !== '[]' || row.review_refs_json !== '[]' || typeof row.trash_entry_ids_json !== 'string'
    || row.error_code_bytes !== null && Number(row.error_code_bytes) > 256
    || Number(row.claim_table_oid) !== source.tableOid)) throw claimError('BATCH_CLAIM_CHANGED');
  return row;
}
async function assertMcpPredecessor(database: SqlConnection, source: WorkspaceOperationBatchClaimBinding['source'],
  workspaceId: string, batchId: string): Promise<void> {
  const earlier = await database.get(`SELECT batch_id FROM ${quote(source.schemaName)}.workspace_file_operation_batches
    WHERE workspace_id=$1 AND batch_id<>$2 AND (status='applying' OR status='queued') LIMIT 1`, [workspaceId, batchId]);
  if (earlier) throw claimError('BATCH_CLAIM_BUSY');
}
/** Fixed MCP lease/header mechanics. No operation callback, auth DTO or proof supplied by callers. */
async function runMcpClaim(store: WorkspaceOperationBatchStore, selected: McpSelection,
  command: McpCommand): Promise<WorkspaceOperationMcpClaimResult> {
  if (selected.kind === 'move') assertDirectMcpWorkspaceMovePrincipalCaptured(selected.principal, { workspaceId: command.workspaceId });
  else assertDirectMcpWorkspaceDeletePrincipalCaptured(selected.principal, { workspaceId: command.workspaceId });
  const runtime = runtimes.get(store);
  if (!runtime) throw claimError('BATCH_CLAIM_REQUIRED');
  const owner = randomUUID(), token = randomUUID(), database = await runtime.connect();
  let began = false, commitAttempted = false, committed = false, failed = false, failure: unknown;
  let result: WorkspaceOperationMcpClaimResult | undefined;
  const returned: { value?: ReturnedClaim } = {};
  try {
    await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
    result = await withMcpStorePolicy(database, selected, async access => {
      const tool = selected.kind === 'move' ? 'move_knowledge_source' as const : 'delete_knowledge_source' as const;
      if (access.tool !== tool || access.workspace.workspaceId !== command.workspaceId) throw claimError('BATCH_SCOPE_CHANGED');
      const facts = { userId: access.userId, clientId: access.clientId, sessionId: access.sessionId, workspace: access.workspace, tool };
      const batchId = workspaceOperationMcpBatchId({ userId: access.userId, clientId: access.clientId,
        workspaceId: command.workspaceId, tool, operationId: command.operationId });
      const source = await assertMcpClaimSource(database), table = `${quote(source.schemaName)}.workspace_file_operation_batches`;
      const validate = (row: Record<string, unknown>) => {
        const batch = record(row);
        if (batch.authorization.mode !== 'direct-mcp' || batch.workspaceId !== command.workspaceId
          || batch.planId !== (command.mode === 'create' ? command.plan.planId : command.planId)) throw claimError('BATCH_IDEMPOTENCY_CONFLICT');
        assertWorkspaceOperationMcpAuthorizationCurrent(batch.authorization, facts, batch.plan);
        if (command.mode === 'create' && !isDeepStrictEqual(batch.plan, command.plan)) throw claimError('BATCH_IDEMPOTENCY_CONFLICT');
        return batch;
      };
      let row = await readMcpJobRow(database, source, batchId);
      if (row && validate(row).status === 'applied') {
        await access.assertCurrent(); await assertMcpClaimSource(database, source);
        return Object.freeze({ kind: 'historical-header' as const, batch: validate(row) });
      }
      if (!row && command.mode === 'existing') return Object.freeze({ kind: 'absent' as const });
      try { await database.run(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE NOWAIT`); }
      catch (error) {
        if (error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === '55P03') throw claimError('BATCH_CLAIM_BUSY');
        throw error;
      }
      await assertMcpClaimSource(database, source); await access.assertCurrent();
      row = await readMcpJobRow(database, source, batchId);
      const now = runtime.now(), expiresAt = now + 90_000;
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt)) throw claimError('BATCH_CLAIM_INVALID');
      if (row) {
        const original = validate(row);
        if (original.status === 'applied') return Object.freeze({ kind: 'historical-header' as const, batch: original });
        if (original.status === 'applying') {
          if (typeof row.lease_owner !== 'string' || !row.lease_owner || typeof row.lease_token !== 'string' || !row.lease_token
            || row.lease_expires_at === null || !Number.isSafeInteger(Number(row.lease_expires_at))
            || Number(row.lease_expires_at) < 1) throw claimError('BATCH_CLAIM_CHANGED');
          if (Number(row.lease_expires_at) > now) throw claimError('BATCH_CLAIM_BUSY');
        }
        if (!['failed', 'needs_recovery', 'applying'].includes(original.status)) throw claimError('BATCH_CONFLICT');
        await assertMcpPredecessor(database, source, command.workspaceId, batchId);
        const updated = await database.get(`UPDATE ${table} SET status='applying',lease_owner=$2,lease_token=$3,
          lease_expires_at=$4,updated_at=$5 WHERE batch_id=$1 AND plan_json=$6 AND authorization_json=$7
          AND status=$8 AND action_mode='apply' AND tableoid=$9::pg_catalog.oid RETURNING *,tableoid::oid::bigint AS claim_table_oid`,
        [batchId, owner, token, expiresAt, now, row.plan_json, row.authorization_json, row.status, source.tableOid]) as Record<string, unknown> | undefined;
        if (!updated) throw claimError('BATCH_CLAIM_CHANGED');
        returned.value = captureReturnedClaim(updated, source, owner, token, expiresAt);
      } else {
        if (command.mode === 'existing') return Object.freeze({ kind: 'absent' as const });
        await assertMcpPredecessor(database, source, command.workspaceId, batchId);
        const original = createWorkspaceOperationMcpAuthorization({ ...facts, plan: command.plan });
        const inserted = await database.get(`INSERT INTO ${table}
          (batch_id,plan_id,workspace_id,review_ids_json,review_refs_json,plan_json,authorization_json,status,
           action_mode,total_actions,lease_owner,lease_token,lease_expires_at,created_at,updated_at)
          VALUES($1,$2,$3,'[]','[]',$4,$5,'applying','apply',$6,$7,$8,$9,$10,$10)
          RETURNING *,tableoid::oid::bigint AS claim_table_oid`,
        [batchId, command.plan.planId, command.workspaceId, JSON.stringify(command.plan), JSON.stringify(original),
          workspaceOperationBatchTotalActions(command.plan), owner, token, expiresAt, now]) as Record<string, unknown> | undefined;
        if (!inserted) throw claimError('BATCH_CLAIM_CHANGED');
        returned.value = captureReturnedClaim(inserted, source, owner, token, expiresAt);
      }
      await access.assertCurrent(); await assertMcpClaimSource(database, source);
      return Object.freeze({ kind: 'claimed' as const, batch: returned.value.batch });
    });
    commitAttempted = true; await database.run('COMMIT'); committed = true;
  } catch (error) {
    failed = true;
    failure = commitAttempted ? Object.assign(new WorkspaceOperationBatchError('BATCH_CLAIM_COMMIT_UNCONFIRMED', 503,
      'MCP file action commit is unconfirmed.'), { cause: error }) : error;
    if (began && !committed && !commitAttempted) try { await database.run('ROLLBACK'); }
    catch (rollback) { failure = Object.assign(new WorkspaceOperationBatchError('BATCH_CLAIM_DISPOSAL_UNCONFIRMED', 503,
      'MCP file action rollback is unconfirmed.'), { cause: new AggregateError([failure, rollback]) }); }
  }
  try { await database.close(failed ? claimFailure(failure) : undefined); }
  catch (close) { failure = Object.assign(new WorkspaceOperationBatchError('BATCH_CLAIM_DISPOSAL_UNCONFIRMED', 503,
    'MCP file action connection disposal is unconfirmed.'), { cause: failure === undefined ? close : new AggregateError([failure, close]) }); }
  if (failed || failure !== undefined) throw failure;
  if (!committed || !result) throw claimError('BATCH_CLAIM_COMMIT_UNCONFIRMED', 503);
  if (result.kind === 'claimed') {
    if (!returned.value) throw claimError('BATCH_CLAIM_CHANGED');
    registerClaimedBatch(store, runtime, returned.value);
  }
  return result;
}

/** SQL leases select work; the executor additionally owns the kernel workspace mutation lock. */
export class WorkspaceOperationBatchStore {
  constructor(private readonly connect: () => Promise<SqlConnection> = openDb, private readonly now = Date.now) {
    // Constructor DI is trusted persistence configuration. Retain its original
    // closures privately; changing public/TS-private properties cannot rebind a claim.
    runtimes.set(this, Object.freeze({ connect, now }));
  }

  private async query(sql: string, params: unknown[]): Promise<WorkspaceOperationBatchRecord | null> {
    const db = await this.connect();
    try { const row = await db.get(sql, params); return row ? record(row as Record<string, unknown>) : null; }
    finally { await db.close(); }
  }

  async get(batchId: string): Promise<WorkspaceOperationBatchRecord | null> {
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(batchId)) return null;
    return this.query('SELECT * FROM workspace_file_operation_batches WHERE batch_id = $1', [batchId]);
  }

  async create(input: { batchId: string; plan: WorkspaceOperationBatchPlan; reviewRefs: WorkspaceOperationBatchReviewRef[] }): Promise<WorkspaceOperationBatchRecord> {
    const result = await this.query(`INSERT INTO workspace_file_operation_batches
      (batch_id,plan_id,workspace_id,review_ids_json,review_refs_json,plan_json,status,total_actions,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
    [input.batchId, input.plan.planId, input.plan.workspaceId, JSON.stringify(input.reviewRefs.map((ref) => ref.reviewId)),
      JSON.stringify(input.reviewRefs), JSON.stringify(input.plan), input.plan.readiness === 'ready' ? 'preview' : 'blocked',
      workspaceOperationBatchTotalActions(input.plan), this.now()]);
    return result!;
  }

  async createDirect(input: { batchId: string; plan: WorkspaceOperationBatchPlan;
    authorization: WorkspaceOperationDirectAuthorization }): Promise<WorkspaceOperationBatchRecord> {
    const selected = captureDirectAuthorization(directInputData(input, 'authorization'));
    const batchId = directInputData(input, 'batchId');
    const plan = decodeStoredPlan(directInputData(input, 'plan'));
    const workspaceId = directInputData(plan, 'workspaceId');
    if (typeof workspaceId !== 'string' || selected.jobScope && selected.jobScope.workspaceId !== workspaceId) {
      throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'File action job scope does not match the plan.');
    }
    if (plan.version !== 1 && selected.jobScope && !isDeepStrictEqual(plan.sourceEvidence.workspaceScope, selected.jobScope)) {
      throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'Native file action evidence does not match its original job scope.');
    }
    if (typeof batchId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(batchId)) {
      throw new WorkspaceOperationBatchError('BATCH_INVALID_ID', 422, 'Invalid file action identity.');
    }
    const planId = plan.planId, planText = JSON.stringify(plan), authorizationText = JSON.stringify(selected);
    const status = plan.readiness === 'ready' ? 'queued' : 'blocked';
    const totalActions = workspaceOperationBatchTotalActions(plan);
    const matchingExisting = (existing: WorkspaceOperationBatchRecord | null): WorkspaceOperationBatchRecord => {
      if (!existing || existing.workspaceId !== workspaceId || existing.authorization.mode !== 'direct'
        || existing.authorization.actorUserId !== selected.actorUserId
        || existing.authorization.actorId !== selected.actorId
        || existing.authorization.actorType !== selected.actorType
        || existing.authorization.actorSessionId !== selected.actorSessionId
        || existing.authorization.requestHash !== selected.requestHash
        || existing.authorization.jobScope !== undefined
          && JSON.stringify(existing.authorization.jobScope) !== JSON.stringify(selected.jobScope ?? null)) {
        throw new WorkspaceOperationBatchError('BATCH_IDEMPOTENCY_CONFLICT', 409, 'This file action identity belongs to another request.');
      }
      return existing;
    };
    if (!selected.jobScope) {
      const existing = await this.get(batchId);
      if (!existing) throw new WorkspaceOperationBatchError('BATCH_INVALID_AUTHORIZATION', 409, 'A new direct file action requires its original job scope.');
      return matchingExisting(existing);
    }
    const result = await this.query(`INSERT INTO workspace_file_operation_batches
      (batch_id,plan_id,workspace_id,review_ids_json,review_refs_json,plan_json,authorization_json,
       status,error_code,total_actions,created_at,updated_at)
      VALUES ($1,$2,$3,'[]','[]',$4,$5,$6,$7,$8,$9,$9)
      ON CONFLICT (batch_id) DO NOTHING RETURNING *`,
    [batchId, planId, workspaceId, planText, authorizationText,
      status, status === 'queued' ? null : 'PREVIEW_BLOCKED', totalActions, this.now()]);
    if (result) return result;
    return matchingExisting(await this.get(batchId));
  }

  async createMcpMoveAndClaim(principal: DirectMcpWorkspaceMovePrincipal,
    input: { operationId: string; plan: WorkspaceOperationNativeMoveBatchPlan }): Promise<WorkspaceOperationMcpClaimResult> {
    return runMcpClaim(this, { kind: 'move', principal }, captureMcpCreateInput('move', input));
  }

  async createMcpDeleteAndClaim(principal: DirectMcpWorkspaceDeletePrincipal,
    input: { operationId: string; plan: WorkspaceOperationNativeDeleteBatchPlan }): Promise<WorkspaceOperationMcpClaimResult> {
    return runMcpClaim(this, { kind: 'delete', principal }, captureMcpCreateInput('delete', input));
  }

  async claimExistingMcpMove(principal: DirectMcpWorkspaceMovePrincipal,
    input: { operationId: string; workspaceId: string; planId: string }): Promise<WorkspaceOperationMcpClaimResult> {
    return runMcpClaim(this, { kind: 'move', principal }, captureMcpExistingInput(input));
  }

  async claimExistingMcpDelete(principal: DirectMcpWorkspaceDeletePrincipal,
    input: { operationId: string; workspaceId: string; planId: string }): Promise<WorkspaceOperationMcpClaimResult> {
    return runMcpClaim(this, { kind: 'delete', principal }, captureMcpExistingInput(input));
  }

  async enqueue(input: { batchId: string; planId: string; userId: string; displayName: string;
    action?: 'accept' | 'resume' | 'undo' }): Promise<WorkspaceOperationBatchRecord> {
    const action = input.action ?? 'accept';
    if (action === 'undo') assertWorkspaceFileUndoEnabled();
    return executeLifecycleTransaction({ openConnection: this.connect, execute: async (db) => {
      const row = await db.get('SELECT * FROM workspace_file_operation_batches WHERE batch_id = $1 FOR UPDATE', [input.batchId]);
      if (!row) throw new WorkspaceOperationBatchError('BATCH_NOT_FOUND', 404, 'File action batch not found.');
      const batch = record(row as Record<string, unknown>);
      if (batch.authorization.mode === 'direct-mcp') throw claimError('BATCH_DIRECT_AUTHORIZATION_REQUIRED', 403);
      if (batch.planId !== input.planId) throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409, 'The exact batch plan is required.');
      const direct = batch.authorization.mode === 'direct';
      const authorityUserId = workspaceOperationBatchAuthorityUserId(batch);
      if (direct && (action === 'accept' || authorityUserId !== input.userId)) {
        throw new WorkspaceOperationBatchError('BATCH_DIRECT_AUTHORIZATION_REQUIRED', 403,
          'Only the initiating user can resume or undo this direct file action.');
      }
      if (action === 'resume' && authorityUserId !== input.userId) {
        throw new WorkspaceOperationBatchError('BATCH_RESUME_REVIEWER_REQUIRED', 403,
          'Only the reviewer who approved this job can resume it. Their current workspace permissions are still required.');
      }
      if (action === 'resume' && batch.actionMode === 'undo') assertWorkspaceFileUndoEnabled();
      if (['queued', 'applying'].includes(batch.status)) {
        const expectedMode = action === 'undo' ? 'undo' : action === 'accept' ? 'apply' : batch.actionMode;
        if (authorityUserId !== input.userId || expectedMode !== batch.actionMode) {
          throw new WorkspaceOperationBatchError('BATCH_CONFLICT', 409, 'The batch is already assigned to another accepted action.');
        }
        return batch;
      }
      if (action === 'accept' && batch.status === 'applied' || action === 'undo' && batch.status === 'undone') return batch;
      if (action === 'resume' && ['applied', 'undone'].includes(batch.status)) return batch;
      const allowed = action === 'accept' ? ['preview'] : action === 'undo' ? ['applied'] : ['needs_recovery', 'failed'];
      if (!allowed.includes(batch.status)) throw new WorkspaceOperationBatchError('BATCH_CONFLICT', 409, 'This batch requires a fresh preview before approval.');
      if (action === 'accept') {
        for (const ref of batch.reviewRefs) {
          const reviewed = await db.get(`SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1 FOR UPDATE`, [ref.reviewId]) as Record<string, unknown> | undefined;
          if (!reviewed || reviewed.plan_id !== ref.planId || reviewed.source_workspace_id !== batch.workspaceId
            || reviewed.successor_review_id || reviewed.batch_id
            || !['pending', 'stale', 'blocked'].includes(String(reviewed.status))) {
            throw new WorkspaceOperationBatchError('REVIEW_CONFLICT', 409, 'A selected review changed before approval.');
          }
          await db.run(`UPDATE workspace_file_operation_reviews SET status = 'queued', batch_id = $2,
            operation_id = $2, reviewer_user_id = $3, revision = revision + 1, updated_at = $4 WHERE review_id = $1`,
          [ref.reviewId, batch.batchId, input.userId, this.now()]);
        }
      }
      const updated = await db.get(`UPDATE workspace_file_operation_batches SET status = 'queued',
        reviewer_user_id = $2, reviewer_display_name = $3, action_mode = $4,
        lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = $5,
        completed_actions = CASE WHEN $6 THEN 0 ELSE completed_actions END,
        phase = CASE WHEN $6 THEN 'preparing' ELSE phase END
        WHERE batch_id = $1 RETURNING *`,
      [input.batchId, direct ? null : input.userId,
        direct ? null : action === 'resume' ? batch.reviewerDisplayName ?? input.displayName : input.displayName,
        action === 'undo' ? 'undo' : batch.actionMode, this.now(), action === 'undo']);
      return record(updated as Record<string, unknown>);
    }, recoverCommitted: async (value, commitError) => {
      const persisted = await this.get(value.batchId);
      if (persisted?.planId === value.planId && workspaceOperationBatchAuthorityUserId(persisted) === input.userId
        && ['queued', 'applying', 'applied', 'undone'].includes(persisted.status)) return persisted;
      throw new WorkspaceOperationBatchError('BATCH_COMMIT_UNCONFIRMED', 503,
        commitError instanceof Error ? commitError.message : 'Batch approval could not be confirmed. Retry the same approval.');
    } });
  }

  async claim(owner: string, leaseMs = 90_000): Promise<WorkspaceOperationBatchRecord | null> {
    const runtime = runtimes.get(this);
    if (!runtime) throw claimError('BATCH_CLAIM_REQUIRED');
    const now = runtime.now(), token = randomUUID();
    if (typeof owner !== 'string' || !owner || owner.length > 256 || /[\u0000-\u001f\u007f]/u.test(owner)
      || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(now + leaseMs)) throw claimError('BATCH_CLAIM_INVALID');
    const database = await runtime.connect();
    let selected: ReturnedClaim | undefined, failure: unknown;
    try {
      const row = await database.get(`UPDATE workspace_file_operation_batches AS batch SET status = 'applying',
      lease_owner = $1, lease_expires_at = $2, updated_at = $3, lease_token = $4 FROM (
        SELECT candidate.batch_id FROM workspace_file_operation_batches candidate
        WHERE (candidate.status = 'queued' OR candidate.status = 'applying' AND candidate.lease_expires_at <= $3)
          AND CASE WHEN candidate.authorization_json IS JSON OBJECT
            THEN candidate.authorization_json::jsonb->>'mode' IN ('review','direct') ELSE false END
          AND NOT EXISTS (SELECT 1 FROM workspace_file_operation_batches earlier
            WHERE earlier.workspace_id = candidate.workspace_id AND earlier.batch_id <> candidate.batch_id
              AND (earlier.status = 'applying' OR earlier.status = 'queued'
                AND CASE WHEN earlier.authorization_json IS JSON OBJECT
                  THEN earlier.authorization_json::jsonb->>'mode' IN ('review','direct') ELSE false END
                AND (earlier.created_at,earlier.batch_id) < (candidate.created_at,candidate.batch_id)))
        ORDER BY candidate.created_at,candidate.batch_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) AS candidate WHERE batch.batch_id = candidate.batch_id RETURNING batch.*,batch.tableoid::oid::bigint AS claim_table_oid`,
      [owner, now + leaseMs, now, token]) as Record<string, unknown> | undefined;
      if (row) {
        const source = await readClaimSource(database, row.claim_table_oid);
        selected = captureReturnedClaim(row, source, owner, token, now + leaseMs);
      }
    } catch (error) { failure = claimFailure(error); }
    try { await database.close(); }
    catch (error) { failure = failure === undefined ? claimFailure(error) : new AggregateError([failure, claimFailure(error)], 'File action claim checkout cleanup failed.'); }
    if (failure !== undefined) throw failure;
    if (selected) {
      const { binding, batch } = selected;
      await claimConnection({ runtime }, async db => {
        await assertClaimSource(db, { binding });
        await db.run(`UPDATE ${quote(binding.source.schemaName)}.workspace_file_operation_reviews SET status = 'applying',
          revision = revision + 1, updated_at = $3 WHERE batch_id = $1 AND status = 'queued'
          AND EXISTS (SELECT 1 FROM ${quote(binding.source.schemaName)}.workspace_file_operation_batches
            WHERE batch_id = $1 AND lease_owner = $2 AND lease_token=$4 AND status = 'applying')`,
        [batch.batchId, owner, now, token]);
      });
      registerClaimedBatch(this, runtime, selected);
    }
    return selected?.batch ?? null;
  }

  async withClaim<T>(originalBatch: WorkspaceOperationBatchRecord,
    operation: (claim: WorkspaceOperationBatchClaim) => Promise<T>): Promise<T> {
    const captured = originalClaim(this, originalBatch), previous = claimContext.getStore();
    if (previous || captured.state !== 'claimed' || captured.failure !== undefined || typeof operation !== 'function') {
      const error = claimError(previous ? 'BATCH_CLAIM_REENTRANT' : 'BATCH_CLAIM_REQUIRED');
      if (previous) { try { poisonClaim(previous, error); } catch { /* Both invocations fail closed. */ } }
      poisonClaim(captured, error);
    }
    const capability = Object.freeze(Object.create(null)) as WorkspaceOperationBatchClaim;
    captured.capability = capability; captured.state = 'active'; captured.accepting = true; claims.set(capability, captured);
    return claimContext.run(captured, async () => {
      let value: T | undefined, operationFailure: unknown;
      try {
        claimCurrent(captured);
        try { value = await operation(capability); }
        catch (error) { operationFailure = claimFailure(error); captured.failure ??= operationFailure; }
        captured.accepting = false;
        if (captured.pending.size) {
          captured.failure ??= claimError('BATCH_CLAIM_DETACHED');
          await Promise.allSettled([...captured.pending]);
        }
        if (operationFailure !== undefined) throw operationFailure;
        if (captured.failure !== undefined) throw captured.failure;
        claimCurrent(captured, true);
        if (captured.failure !== undefined) throw captured.failure;
        return value as T;
      } finally { captured.accepting = false; captured.state = 'closed'; }
    });
  }

  heartbeatClaim(originalBatch: WorkspaceOperationBatchRecord, progress?: WorkspaceOperationBatchProgress): Promise<boolean> {
    let captured: ClaimCapture;
    try { captured = originalClaim(this, originalBatch); } catch (error) { return Promise.reject(error); }
    return trackedClaim(captured, async () => {
      claimCurrent(captured);
      if (captured.finished) throw claimError('BATCH_CLAIM_CHANGED');
      const now = captured.runtime.now(), expiresAt = now + 90_000;
      const completedActions = progress?.completedActions ?? null, phase = progress?.phase ?? null;
      const row = await claimConnection(captured, async database => {
        await assertClaimSource(database, captured); claimCurrent(captured);
        return database.get(`UPDATE ${relation(captured.binding)} SET lease_expires_at=$17,updated_at=$18,
          completed_actions=COALESCE($19,completed_actions),phase=COALESCE($20,phase)
          WHERE ${claimPredicates} RETURNING tableoid::oid::bigint AS table_oid,lease_expires_at`,
        [...claimParameters(captured), expiresAt, now, completedActions, phase]) as Promise<Record<string, unknown> | undefined>;
      });
      claimCurrent(captured);
      if (!row || Number(row.table_oid) !== captured.binding.source.tableOid || Number(row.lease_expires_at) !== expiresAt) throw claimError('BATCH_CLAIM_CHANGED');
      captured.expiresAt = expiresAt; return true;
    });
  }

  finishClaim(originalBatch: WorkspaceOperationBatchRecord, input: { status: WorkspaceOperationBatchStatus;
    errorCode?: string | null; trashEntryIds?: string[]; completedActions?: number; phase?: string }): Promise<WorkspaceOperationBatchRecord | null> {
    let captured: ClaimCapture;
    try { captured = originalClaim(this, originalBatch); } catch (error) { return Promise.reject(error); }
    const errorFinalization = ['failed', 'needs_recovery', 'needs_review'].includes(input.status);
    return trackedClaim(captured, async () => {
      claimCurrent(captured, errorFinalization);
      if (captured.finished) throw claimError('BATCH_CLAIM_CHANGED');
      const selected = { status: input.status, errorCode: input.errorCode ?? null,
        trashEntryIds: input.trashEntryIds ? JSON.stringify(input.trashEntryIds) : null,
        completedActions: input.completedActions ?? null, phase: input.phase ?? null };
      const value = await executeLifecycleTransaction({ openConnection: captured.runtime.connect, execute: async database => {
        await assertClaimSource(database, captured); claimCurrent(captured, errorFinalization);
        const row = await database.get(`UPDATE ${relation(captured.binding)} SET status=$17,error_code=$18,
          trash_entry_ids_json=COALESCE($19,trash_entry_ids_json),completed_actions=COALESCE($20,completed_actions),
          phase=COALESCE($21,phase),lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,updated_at=$22
          WHERE ${claimPredicates} RETURNING *,tableoid::oid::bigint AS claim_table_oid`,
        [...claimParameters(captured), selected.status, selected.errorCode, selected.trashEntryIds,
          selected.completedActions, selected.phase, captured.runtime.now()]) as Record<string, unknown> | undefined;
        if (!row || Number(row.claim_table_oid) !== captured.binding.source.tableOid) throw claimError('BATCH_CLAIM_CHANGED');
        const batch = record(row), reviewStatus = batch.status === 'needs_review' ? 'stale' : batch.status === 'undone' ? 'applied' : batch.status;
        await database.run(`UPDATE ${quote(captured.binding.source.schemaName)}.workspace_file_operation_reviews SET status=$2,error_code=$3,
          trash_entry_ids_json=$4,revision=revision+1,updated_at=$5,
          batch_id=CASE WHEN $2='stale' THEN NULL ELSE batch_id END,operation_id=CASE WHEN $2='stale' THEN NULL ELSE operation_id END
          WHERE batch_id=$1 AND status IN ('queued','applying','applied','needs_recovery','failed')`,
        [batch.batchId, reviewStatus, batch.status === 'undone' ? 'BATCH_UNDONE' : batch.errorCode, JSON.stringify(batch.trashEntryIds), captured.runtime.now()]);
        await assertClaimSource(database, captured); claimCurrent(captured, errorFinalization); return batch;
      }, recoverCommitted: async () => { throw claimError('BATCH_CLAIM_COMMIT_UNCONFIRMED', 503); } });
      captured.finished = true; return value;
    });
  }

  async heartbeat(batchId: string, owner: string, progress?: WorkspaceOperationBatchProgress): Promise<boolean> {
    const existing = await this.get(batchId);
    if (existing?.authorization.mode === 'direct-mcp') throw claimError('BATCH_DIRECT_AUTHORIZATION_REQUIRED', 403);
    const now = this.now();
    const batch = await this.query(`UPDATE workspace_file_operation_batches SET lease_expires_at = $3,
      updated_at = $4, completed_actions = COALESCE($5,completed_actions), phase = COALESCE($6,phase)
      WHERE batch_id = $1 AND lease_owner = $2 AND status = 'applying'
        AND CASE WHEN authorization_json IS JSON OBJECT THEN authorization_json::jsonb->>'mode' IN ('review','direct') ELSE false END RETURNING *`,
    [batchId, owner, now + 90_000, now, progress?.completedActions ?? null, progress?.phase ?? null]);
    return Boolean(batch);
  }

  async finish(batchId: string, owner: string, input: { status: WorkspaceOperationBatchStatus;
    errorCode?: string | null; trashEntryIds?: string[]; completedActions?: number; phase?: string }): Promise<WorkspaceOperationBatchRecord | null> {
    return executeLifecycleTransaction({ openConnection: this.connect, execute: async (db) => {
      const selected = await db.get('SELECT authorization_json FROM workspace_file_operation_batches WHERE batch_id=$1 FOR UPDATE', [batchId]) as Record<string, unknown> | undefined;
      if (selected && authorization(selected.authorization_json).mode === 'direct-mcp') throw claimError('BATCH_DIRECT_AUTHORIZATION_REQUIRED', 403);
      const row = await db.get(`UPDATE workspace_file_operation_batches SET status = $3, error_code = $4,
        trash_entry_ids_json = COALESCE($5,trash_entry_ids_json), completed_actions = COALESCE($6,completed_actions),
        phase = COALESCE($7,phase), lease_owner = NULL, lease_expires_at = NULL, updated_at = $8
        WHERE batch_id = $1 AND lease_owner = $2 AND status = 'applying'
          AND CASE WHEN authorization_json IS JSON OBJECT THEN authorization_json::jsonb->>'mode' IN ('review','direct') ELSE false END RETURNING *`,
      [batchId, owner, input.status, input.errorCode ?? null,
        input.trashEntryIds ? JSON.stringify(input.trashEntryIds) : null, input.completedActions ?? null,
        input.phase ?? null, this.now()]);
      if (!row) return null;
      const batch = record(row as Record<string, unknown>);
      const reviewStatus = batch.status === 'needs_review' ? 'stale' : batch.status === 'undone' ? 'applied' : batch.status;
      await db.run(`UPDATE workspace_file_operation_reviews SET status = $2, error_code = $3,
        trash_entry_ids_json = $4, revision = revision + 1, updated_at = $5,
        batch_id = CASE WHEN $2 = 'stale' THEN NULL ELSE batch_id END,
        operation_id = CASE WHEN $2 = 'stale' THEN NULL ELSE operation_id END
        WHERE batch_id = $1 AND status IN ('queued','applying','applied','needs_recovery','failed')`,
      [batchId, reviewStatus, batch.status === 'undone' ? 'BATCH_UNDONE' : batch.errorCode,
        JSON.stringify(batch.trashEntryIds), this.now()]);
      return batch;
    }, recoverCommitted: async (value, error) => {
      if (!value) return null;
      const persisted = await this.get(batchId);
      if (persisted?.authorization.mode !== 'direct-mcp' && persisted?.status === value.status && persisted.leaseOwner === null) return persisted;
      throw error;
    } });
  }
}
