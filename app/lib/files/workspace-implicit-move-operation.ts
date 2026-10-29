import 'server-only';

import type { WorkspaceImplicitMoveSelectionPublic, WorkspaceImplicitMoveBindingPublic, WorkspaceImplicitMoveLegacyReplayPublic } from './workspace-implicit-move-public';

import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { withNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { captureCollaborationAdmissionRequest, CollaborationAdmissionError,
  type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { reserveCollaborationAdmissionOnConnection, startCollaborationAdmissionDrainOnConnection,
  tryLockCollaborationAdmissionWorkspace, decodeCollaborationAdmissionTarget } from '../collaboration/room-admission';
import { proveCollaborationAdmissionQuiescenceOnConnection } from '../collaboration/room-admission-quiescence';
import { readHistoricalCollaborationAdmissionOutcomeOnConnection,
  type CollaborationAdmissionOutcome } from '../collaboration/room-admission-outcome';
import { createCollaborationAdmissionHandoffService } from '../collaboration/room-admission-handoff';
import { lockIdentity } from '../collaboration/room-owner';
import { WorkspaceRequestPrincipalError, withWorkspaceRequestPrincipalOriginalOrigin, withWorkspaceRequestPrincipalOnConnection,
  type WorkspaceRequestHistoricalOrigin, type WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { createWorkspaceOperationNativeMoveBatchPlanV4, decodeWorkspaceOperationNativeMoveBatchPlan }
  from './workspace-operation-native-move-plan';
import { workspaceOperationBatchTotalActions } from './workspace-operation-native-delete-effects';
import { readWorkspaceOperationOriginalMovePreparationOnConnection } from './workspace-operation-original-move-preparation';
import { decodeWorkspaceOperationBatchRecord, type WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import { getExistingDirectWorkspacePathOperation } from './workspace-path-operation-service';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { reportWorkspaceOperationFailureDiagnostics } from './workspace-operation-failure-diagnostics';
import { captureWorkspaceImplicitMoveSelection, decodeWorkspaceImplicitMoveSelectionRequest,
  getWorkspaceImplicitMoveRequestIdentity, getWorkspaceImplicitMoveSelectionBatchIdentity,
  getWorkspaceImplicitMoveSelectionDigest, type WorkspaceImplicitMoveSelectionV1 } from './workspace-implicit-move-selection';
import { prepareWorkspaceImplicitMoveOperationOnConnection,
  withWorkspaceImplicitMoveHandoffTransactionOnConnection } from './workspace-implicit-move-phase';

type Selection = Readonly<{ sourcePath: string; destinationPath: string }>;
type Input = Readonly<{ workspaceId: string; operationId: string; kind: 'move' | 'rename'; selections: readonly Selection[] }>;
type Lookup = Readonly<{ workspaceId: string; requestId: string }>;
type Saved = Readonly<{ request: CollaborationAdmissionRequest; selection: WorkspaceImplicitMoveSelectionV1;
  headerStatus: string; outcome: CollaborationAdmissionOutcome | null }>;
type BatchResult = Readonly<{ state: 'batch'; operationId: string; requestId?: string;
  batch: WorkspaceOperationBatchRecord; scope: WorkspaceOperationBatchScope; historical: boolean; legacy: boolean; implicitBinding?: WorkspaceImplicitMoveBindingPublic; legacyImplicitReplay?: WorkspaceImplicitMoveLegacyReplayPublic }>;
type PendingResult = WorkspaceImplicitMoveSelectionPublic & Readonly<{ state: 'pending';
  status: 'reserved' | 'draining' | 'recovery_required'; canResume: boolean; statusUrl: string; resumeUrl: string }>;
type AbortedResult = WorkspaceImplicitMoveSelectionPublic & Readonly<{ state: 'aborted'; reason: 'user_cancelled' | 'precondition_failed' }>;
export type WorkspaceImplicitMoveOperationResult = BatchResult | PendingResult | AbortedResult;
type Snapshot = Readonly<{ saved: Saved; result: WorkspaceImplicitMoveOperationResult }>;
type Progress = Readonly<{ documentId: string; proofText: string | null }>;
type PhaseResult = Readonly<{ snapshot?: Snapshot; legacy?: BatchResult; progress?: readonly Progress[] }>;
type Command = Readonly<{ kind: 'select'; input: Input }>
  | Readonly<{ kind: 'observe'; lookup: Lookup }>
  | Readonly<{ kind: 'advance'; lookup: Lookup; expected: CollaborationAdmissionRequest;
    documentIds: readonly string[]; deadline: number }>;
type Row = Record<string, unknown>;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tables = ['collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets',
  'workspace_file_operation_batches', 'workspace_file_operation_move_preparations', 'collaboration_native_file_operation_intents',
  'workspace_path_import_preparations'];
const ADVANCE_DOCUMENTS_PER_PHASE = 8;
export class WorkspaceImplicitMoveOperationError extends Error {
  constructor(readonly code: string, readonly status: 401 | 403 | 409 | 422 | 503,
    readonly operationId?: string, readonly requestId?: string, options?: ErrorOptions) {
    super(code, options); this.name = 'WorkspaceImplicitMoveOperationError';
  }
}
// A public Busy code alone never permits replay. This private, single-use
// witness belongs to one exact advance command after all its scopes close.
const retryableAdvanceFailures = new WeakMap<WorkspaceImplicitMoveOperationError, Extract<Command, { kind: 'advance' }>>();
function fail(code = 'IMPLICIT_MOVE_HISTORY_CHANGED', status: 401 | 403 | 409 | 422 | 503 = 409): never {
  throw new WorkspaceImplicitMoveOperationError(code, status);
}
function sameReauthorizedOrigin(actual: WorkspaceRequestHistoricalOrigin, saved: WorkspaceRequestHistoricalOrigin): boolean {
  const { sessionId: actualSessionId, ...actualMetadata } = actual;
  const { sessionId: savedSessionId, ...savedMetadata } = saved;
  return typeof actualSessionId === 'string' && typeof savedSessionId === 'string' && equal(actualMetadata, savedMetadata);
}
function captureInput(input: Input): Input {
  const value = captureWorkspaceOperationNativePlanData(input, () => fail('IMPLICIT_MOVE_INVALID_REQUEST', 422), 65536) as Input;
  if (!value || !equal(Object.keys(value).sort(), ['kind','operationId','selections','workspaceId'])
    || !['move','rename'].includes(value.kind) || typeof value.workspaceId !== 'string' || !value.workspaceId
    || typeof value.operationId !== 'string' || !value.operationId || Buffer.byteLength(value.operationId) > 512
    || !Array.isArray(value.selections) || !value.selections.length || value.selections.length > 1000
    || value.selections.some(selection => !selection || !equal(Object.keys(selection).sort(), ['destinationPath','sourcePath'])
      || typeof selection.sourcePath !== 'string' || typeof selection.destinationPath !== 'string')) fail('IMPLICIT_MOVE_INVALID_REQUEST', 422);
  // Exact path/UTF-8/overlap limits are also checked by the sole selection codec before reserve.
  return value;
}
function captureLookup(input: Lookup): Lookup {
  const value = captureWorkspaceOperationNativePlanData(input, () => fail('IMPLICIT_MOVE_INVALID_REQUEST', 422), 4096) as Lookup;
  if (!value || !equal(Object.keys(value).sort(), ['requestId','workspaceId']) || !uuid.test(value.requestId)
    || typeof value.workspaceId !== 'string' || !value.workspaceId || Buffer.byteLength(value.workspaceId) > 256) fail('IMPLICIT_MOVE_INVALID_REQUEST', 422);
  return value;
}
function scope(access: WorkspaceRequestPrincipalAccess): WorkspaceOperationBatchScope {
  return { workspace: access.workspace, fileOptions: { workspace: access.workspace } };
}
async function assertCurrent(database: SqlConnection, access: WorkspaceRequestPrincipalAccess,
  actual: WorkspaceRequestHistoricalOrigin, saved?: WorkspaceImplicitMoveSelectionV1): Promise<void> {
  await access.assertCurrent();
  if (access.userId !== actual.userId || access.sessionId !== actual.sessionId || access.workspace.legacy
    || access.workspace.status !== 'active' || !access.workspace.permissions.canRead
    || !access.workspace.permissions.canWrite || !access.workspace.permissions.canDelete
    || saved && (!sameReauthorizedOrigin(actual, saved.origin)
      || !equal(captureWorkspaceOperationJobScope(access.workspace), saved.scope))) fail('IMPLICIT_MOVE_ACCESS_CHANGED', 403);
  const row = await database.get(`SELECT pg_catalog.current_schema() AS schema,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.current_setting('search_path') AS search_path`) as Row | undefined;
  if (!row || row.schema !== actual.schema || Number(row.schema_oid) !== actual.schemaOid
    || Number(row.database_oid) !== actual.databaseOid || row.search_path !== actual.searchPath) fail();
}
async function pinHistoryRelations(database: SqlConnection, origin: WorkspaceRequestHistoricalOrigin): Promise<void> {
  const sql = `SELECT n.name,c.oid::bigint AS oid,c.relnamespace::bigint AS schema_oid,
    c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    pg_catalog.to_regclass(pg_catalog.quote_ident(n.name))::oid::bigint AS resolved
    FROM pg_catalog.unnest($2::text[]) n(name) LEFT JOIN pg_catalog.pg_class c
      ON c.oid=pg_catalog.to_regclass($1||'.'||pg_catalog.quote_ident(n.name)) ORDER BY n.name COLLATE "C"`;
  const values = [quote(origin.schema), tables];
  const rows = await database.all(sql, values) as Row[];
  if (rows.length !== tables.length || new Set(rows.map(row => row.name)).size !== tables.length || rows.some(row =>
    !tables.includes(String(row.name)) || Number(row.schema_oid) !== origin.schemaOid
    || !Number.isSafeInteger(Number(row.oid)) || Number(row.oid) < 1 || Number(row.resolved) !== Number(row.oid)
    || row.relkind !== 'r' || row.relpersistence !== 'p' || row.relrowsecurity !== false || row.relforcerowsecurity !== false)) fail();
  await database.run(`LOCK TABLE ${tables.map(name => `${quote(origin.schema)}.${quote(name)}`).join(',')} IN ACCESS SHARE MODE NOWAIT`);
  if (!equal(rows, await database.all(sql, values))) fail();
  // The actual principal separately pins all auth/ACL schema and metadata DML through COMMIT.
}
async function loadSaved(database: SqlConnection, access: WorkspaceRequestPrincipalAccess,
  actual: WorkspaceRequestHistoricalOrigin, requestId: string): Promise<Saved | null> {
  if (!uuid.test(requestId)) fail('IMPLICIT_MOVE_INVALID_REQUEST', 422);
  const row = await database.get(`SELECT request_id,request_digest,status,revision,
    CASE WHEN octet_length(intent_text) BETWEEN 1 AND 2097152 THEN intent_text END AS intent_text
    FROM ${quote(actual.schema)}.collaboration_admission_requests WHERE request_id=$1 FOR SHARE`, [requestId]) as Row | undefined;
  if (!row) return null;
  if (typeof row.intent_text !== 'string' || !['reserved','draining','recovery_required','committed','cancelled'].includes(String(row.status))
    || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) fail();
  let request: CollaborationAdmissionRequest;
  try { request = JSON.parse(row.intent_text); } catch { return fail(); }
  const selection = decodeWorkspaceImplicitMoveSelectionRequest(request), captured = captureCollaborationAdmissionRequest(request);
  if (captured.intentText !== row.intent_text || captured.requestDigest !== row.request_digest || requestId !== row.request_id
    || selection.scope.workspaceId !== access.workspace.workspaceId) fail();
  await assertCurrent(database, access, actual, selection);
  const outcome = await readHistoricalCollaborationAdmissionOutcomeOnConnection(database, captured, { readOnly: true });
  if (row.status === 'committed' && !outcome || row.status !== 'committed' && outcome) fail();
  return Object.freeze({ request: captured.request, selection, headerStatus: String(row.status), outcome });
}
/** Primitive permitted metadata from the decoded original selection. Callers have
 * separately verified the actual current principal; this is never a grant. */
function publicSelection(saved: Saved): WorkspaceImplicitMoveSelectionPublic {
  const selection = saved.selection;
  return Object.freeze({ actorUserId: selection.origin.userId, workspaceId: selection.scope.workspaceId,
    operationId: selection.operationId, requestId: saved.request.requestId,
    selectionDigest: getWorkspaceImplicitMoveSelectionDigest(selection), action: selection.action,
    selections: Object.freeze(selection.selections.map(item => Object.freeze({ ...item }))) });
}
function publicBinding(saved: Saved): WorkspaceImplicitMoveBindingPublic {
  const identity = publicSelection(saved);
  return Object.freeze({ version: 1, kind: 'implicit-move-binding', actorUserId: identity.actorUserId,
    workspaceId: identity.workspaceId, operationId: identity.operationId, requestId: identity.requestId, selectionDigest: identity.selectionDigest });
}
async function readFinalBatch(database: SqlConnection, access: WorkspaceRequestPrincipalAccess, saved: Saved): Promise<BatchResult> {
  const { selection, outcome } = saved;
  if (!outcome || outcome.version !== 1) fail();
  const result = outcome.result, identity = getWorkspaceImplicitMoveSelectionBatchIdentity(selection);
  if (!equal(Object.keys(result).sort(), ['batchId','finalRequestDigest','finalRequestId','kind','planId','preparationDigest','selectionDigest'].sort())
    || result.kind !== 'implicitNativeMoveV1' || result.selectionDigest !== getWorkspaceImplicitMoveSelectionDigest(selection)
    || result.batchId !== identity.batchId || !uuid.test(result.finalRequestId)
    || !['planId','preparationDigest','finalRequestDigest'].every(key => /^[a-f0-9]{64}$/u.test(result[key]))) fail();
  const prefix = quote(selection.origin.schema);
  const row = await database.get(`SELECT batch_id,plan_id,workspace_id,status,action_mode,reviewer_user_id,reviewer_display_name,
    completed_actions,total_actions,phase,error_code,lease_owner,created_at,updated_at,
    CASE WHEN octet_length(plan_json) BETWEEN 1 AND 16777216 THEN plan_json END AS plan_json,
    CASE WHEN octet_length(authorization_json) BETWEEN 1 AND 65536 THEN authorization_json END AS authorization_json,
    CASE WHEN octet_length(review_ids_json)<=65536 THEN review_ids_json END AS review_ids_json,
    CASE WHEN octet_length(review_refs_json)<=65536 THEN review_refs_json END AS review_refs_json,
    CASE WHEN octet_length(trash_entry_ids_json)<=65536 THEN trash_entry_ids_json END AS trash_entry_ids_json
    FROM ${prefix}.workspace_file_operation_batches WHERE batch_id=$1`, [identity.batchId]) as Row | undefined;
  if (!row || typeof row.plan_json !== 'string' || typeof row.authorization_json !== 'string') fail();
  const batch = decodeWorkspaceOperationBatchRecord(row), plan = decodeWorkspaceOperationNativeMoveBatchPlan(batch.plan);
  const auth = batch.authorization;
  if (plan.planIdentityVersion !== 4 || batch.batchId !== identity.batchId || batch.planId !== result.planId
    || batch.workspaceId !== selection.scope.workspaceId || batch.actionMode !== 'apply'
    || auth.mode !== 'direct' || auth.actorType !== 'user' || auth.actorId !== selection.origin.userId
    || auth.actorUserId !== selection.origin.userId || auth.actorSessionId !== undefined || auth.requestHash !== identity.requestHash
    || !equal(auth.jobScope, selection.scope) || !equal(plan.sourceEvidence.workspaceScope, selection.scope)
    || plan.actions.length !== 1 || plan.actions[0].kind !== selection.action || !equal(plan.actions[0].selections, selection.selections)
    || batch.reviewIds.length || batch.reviewRefs.length || batch.reviewerUserId !== null || batch.reviewerDisplayName !== null
    || batch.totalActions !== workspaceOperationBatchTotalActions(plan) || !Number.isSafeInteger(batch.completedActions)
    || batch.completedActions < 0 || batch.completedActions > batch.totalActions
    || !Number.isSafeInteger(batch.createdAt) || !Number.isSafeInteger(batch.updatedAt) || batch.updatedAt < batch.createdAt
    || !['queued','applying','applied','needs_review','needs_recovery','failed'].includes(batch.status)
    || !['preparing','paths','links','complete','recovery'].includes(batch.phase)) fail();
  const prepared = await readWorkspaceOperationOriginalMovePreparationOnConnection(database, { schema: selection.origin.schema,
    context: { batchId: batch.batchId, requestHash: auth.requestHash, plan,
      actor: { userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: null } }, readOnly: true });
  if (!prepared || prepared.preparation.version !== 3 || prepared.preparationDigest !== result.preparationDigest) fail();
  const final = captureCollaborationAdmissionRequest(prepared.request);
  if (final.request.requestId !== result.finalRequestId || final.requestDigest !== result.finalRequestDigest
    || prepared.preparation.requestId !== final.request.requestId || prepared.preparation.requestDigest !== final.requestDigest) fail();
  const header = await database.get(`SELECT request_id,request_digest,status,
    CASE WHEN octet_length(intent_text)=$2 THEN intent_text END AS intent_text
    FROM ${prefix}.collaboration_admission_requests WHERE request_id=$1 FOR SHARE`,
  [final.request.requestId, Buffer.byteLength(final.intentText)]) as Row | undefined;
  if (!header || header.request_digest !== final.requestDigest || header.intent_text !== final.intentText
    || !['reserved','draining','recovery_required','committed','cancelled'].includes(String(header.status))) fail();
  const targets = await database.all(`SELECT document_id,status,active,
    CASE WHEN octet_length(snapshot_text)<=32768 THEN snapshot_text END AS snapshot_text
    FROM ${prefix}.collaboration_admission_targets WHERE request_id=$1 ORDER BY document_id COLLATE "C" LIMIT $2`,
  [final.request.requestId, final.request.expectedDocuments.length + 1]) as Row[];
  if (targets.length !== final.request.expectedDocuments.length || targets.some((target, index) => {
    const expected = final.request.expectedDocuments[index];
    if (!expected || target.document_id !== expected.documentId || typeof target.snapshot_text !== 'string') return true;
    decodeCollaborationAdmissionTarget(target.snapshot_text, expected);
    return header.status === 'committed' ? target.active !== false || target.status !== 'completed'
      : header.status === 'cancelled' ? target.active !== false || target.status !== 'cancelled'
        : target.active !== true || !['reserved','draining','released'].includes(String(target.status));
  })) fail();
  if (header.status === 'committed' && !await readHistoricalCollaborationAdmissionOutcomeOnConnection(database, final, { readOnly: true })) fail();
  await access.assertCurrent();
  return Object.freeze({ state: 'batch', operationId: selection.operationId, requestId: saved.request.requestId,
    batch, scope: scope(access), historical: true, legacy: false, implicitBinding: publicBinding(saved) });
}
async function snapshot(database: SqlConnection, access: WorkspaceRequestPrincipalAccess, saved: Saved): Promise<Snapshot> {
  if (saved.outcome?.version === 2) return { saved, result: { state: 'aborted', ...publicSelection(saved), reason: saved.outcome.reasonCode } };
  if (saved.outcome) return { saved, result: await readFinalBatch(database, access, saved) };
  if (saved.headerStatus === 'cancelled') fail('IMPLICIT_MOVE_PREPARATION_CANCELLED');
  const status = saved.headerStatus;
  if (status !== 'reserved' && status !== 'draining' && status !== 'recovery_required') fail();
  const url = `/api/files/operations/implicit-moves/${saved.request.requestId}`;
  return { saved, result: { state: 'pending', ...publicSelection(saved), status, canResume: status === 'reserved' || status === 'draining', statusUrl: url, resumeUrl: url } };
}
class UnconfirmedPhase extends Error {
  constructor(readonly attempted: PhaseResult, cause: unknown) { super('Implicit Move phase COMMIT is unconfirmed.', { cause }); }
}
async function runPhase(original: NextRequest, command: Command): Promise<PhaseResult> {
  const workspaceId = command.kind === 'select' ? command.input.workspaceId : command.lookup.workspaceId;
  let rollbackClosedFailure: { error: unknown } | undefined;
  const execute = (): Promise<PhaseResult> => {
    let actual: WorkspaceRequestHistoricalOrigin | undefined;
    return withWorkspaceRequestPrincipalOriginalOrigin(original, { workspaceId, permission: 'canWrite' }, origin => {
      if (actual && !equal(actual, origin)) fail(); actual ??= origin;
    }, principal => executeLifecycleTransaction<PhaseResult>({ openConnection: openDb,
      execute: async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
        await database.run("SET LOCAL statement_timeout='5s'");
        await database.run("SET LOCAL lock_timeout='4s'");
        return withWorkspaceRequestPrincipalOnConnection<PhaseResult>(database, principal, async access => {
        if (!actual) fail();
        await assertCurrent(database, access, actual!); await pinHistoryRelations(database, actual!);
        // SQL-only historical reads must coexist with the already running final worker.
        if (command.kind !== 'observe') await tryLockCollaborationAdmissionWorkspace(
          (sql, values) => database.all(sql, values) as Promise<Row[]>, workspaceId);
        const ids = command.kind === 'select' ? getWorkspaceImplicitMoveRequestIdentity({ workspaceId,
          userId: access.userId, operationId: command.input.operationId }) : { requestId: command.lookup.requestId };
        const existing = await loadSaved(database, access, actual!, ids.requestId);
        const originalImportBatchId = command.kind === 'select' ? (ids as { batchId: string }).batchId
          : existing?.selection.batchId;
        if (originalImportBatchId && await database.get(`SELECT batch_id
          FROM ${quote(actual!.schema)}.workspace_path_import_preparations WHERE workspace_id=$1 AND batch_id=$2 FOR SHARE`,
        [workspaceId, originalImportBatchId])) {
          // A previous import record, including an orphan or malformed one,
          // never grants permission to create a fresh implicit preparation.
          fail('IMPLICIT_MOVE_IMPORT_HISTORY_CONFLICT');
        }
        if (existing) {
          if (command.kind === 'select' && (existing.selection.operationId !== command.input.operationId
            || existing.selection.action !== command.input.kind || !equal(existing.selection.selections, command.input.selections))) fail('IMPLICIT_MOVE_IDEMPOTENCY_CONFLICT');
          if (command.kind === 'advance') {
            const expected = captureCollaborationAdmissionRequest(command.expected), stored = captureCollaborationAdmissionRequest(existing.request);
            if (expected.requestDigest !== stored.requestDigest || expected.intentText !== stored.intentText) fail();
          }
          if (command.kind !== 'advance' || existing.outcome) return { snapshot: await snapshot(database, access, existing) };
          // This fixed internal group shares one genuine Principal/B and its
          // held auth/ACL locks. It carries no authority across transactions.
          const documentIds = command.documentIds;
          if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > ADVANCE_DOCUMENTS_PER_PHASE
            || !Number.isSafeInteger(command.deadline) || command.deadline < 0) fail();
          const selected = existing.request.expectedDocuments.filter(document => documentIds.includes(document.documentId));
          if (!equal(selected.map(document => document.documentId), documentIds)) fail();
          // Header -> target -> state follows the real drain server's order.
          // Upgrade BEFORE locking any target, never while a server header reader waits on that target.
          const header = await database.get(`SELECT request_digest,intent_text,status,revision
            FROM ${quote(actual!.schema)}.collaboration_admission_requests WHERE request_id=$1 FOR UPDATE`,
          [existing.request.requestId]) as Row | undefined;
          const expectedRequest = captureCollaborationAdmissionRequest(existing.request);
          if (!header || header.request_digest !== expectedRequest.requestDigest || header.intent_text !== expectedRequest.intentText
            || !['reserved','draining'].includes(String(header.status)) || !Number.isSafeInteger(Number(header.revision))
            || Number(header.revision) < 1 || Number(header.revision) >= Number.MAX_SAFE_INTEGER) fail();
          const progress: Progress[] = [];
          for (const expected of selected) {
            if (Date.now() >= command.deadline) break;
            const documentId = expected.documentId;
            const target = await database.get(`SELECT status,active,
              CASE WHEN octet_length(snapshot_text)<=32768 THEN snapshot_text END AS snapshot_text
              FROM ${quote(actual!.schema)}.collaboration_admission_targets WHERE request_id=$1 AND document_id=$2 FOR UPDATE`,
            [existing.request.requestId, documentId]) as Row | undefined;
            if (!target || target.active !== true || typeof target.snapshot_text !== 'string'
              || !['reserved','draining','released'].includes(String(target.status))) fail();
            const captured = decodeCollaborationAdmissionTarget(target.snapshot_text as string, expected);
            if (captured.ownerToken !== null && target.status !== 'released') {
              await startCollaborationAdmissionDrainOnConnection(database, existing.request, documentId);
            }
            let proofText: string | null = null;
            try { proofText = (await proveCollaborationAdmissionQuiescenceOnConnection(database, existing.request,
              documentId, { lockTimeout: '50ms' })).proofText; }
            catch (error) { if (!(error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT')) throw error; }
            // Keep a fresh policy/realm check after EVERY actual target proof,
            // including a Busy target, before advancing to the next document.
            await assertCurrent(database, access, actual!, existing.selection);
            progress.push(Object.freeze({ documentId, proofText }));
          }
          return { snapshot: await snapshot(database, access, existing), progress: Object.freeze(progress) };
        }
        if (command.kind !== 'select') fail('IMPLICIT_MOVE_NOT_FOUND');
        const input = command.input;
        // Lock an already-existing legacy batch before calling its unchanged validation.
        // It therefore cannot disappear and accidentally cause that service to fresh-plan.
        const legacy = await database.get(`SELECT batch_id FROM ${quote(actual!.schema)}.workspace_file_operation_batches
          WHERE batch_id=$1 FOR SHARE`, [(ids as { batchId: string }).batchId]);
        if (legacy) {
          const batch = await getExistingDirectWorkspacePathOperation({ scope: scope(access), kind: input.kind,
            selections: input.selections.map(selection => ({ ...selection })), idempotencyKey: input.operationId,
            actorUserId: access.userId, actorId: access.userId, actorDisplayName: access.userId, actorType: 'user' });
          if (!batch) fail(); await access.assertCurrent();
          return { legacy: { state: 'batch', operationId: input.operationId, batch: batch!, scope: scope(access), historical: true, legacy: true,
            // Only this strict historical lookup + actual current Principal may project the tag.
            legacyImplicitReplay: Object.freeze({ version: 1, kind: 'implicit-move-legacy-replay', actorUserId: access.userId,
              workspaceId, operationId: input.operationId, batchId: batch!.batchId, planId: batch!.planId }) } };
        }
        const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace, { physicalParserVersion: 3 });
        const actionId = hash(['workspace-path-action-v1', workspaceId, input.kind, input.selections, false, false]);
        // Strict readiness classification only, discarded before reserving the selection.
        // Unsupported Raw imports/HTML/blockers never create an orphan root reservation.
        createWorkspaceOperationNativeMoveBatchPlanV4({ scope: scope(access),
          actions: [{ reviewId: `${actionId}-request`, kind: input.kind, selections: input.selections.map(selection => ({ ...selection })) }], observation });
        const captured = captureWorkspaceImplicitMoveSelection({ operationId: input.operationId, kind: input.kind,
          selections: input.selections, origin: actual!, scope: captureWorkspaceOperationJobScope(access.workspace), observation });
        const reserved = await reserveCollaborationAdmissionOnConnection(database, captured.request);
        if (reserved.status !== 'reserved') fail();
        await assertCurrent(database, access, actual!, captured.selection);
        const saved = await loadSaved(database, access, actual!, captured.request.requestId);
        if (!saved || !equal(saved.request, captured.request)) fail();
        return { snapshot: await snapshot(database, access, saved!) };
        });
      }, recoverCommitted: async (attempted, cause) => { throw new UnconfirmedPhase(attempted, cause); },
      afterRollbackClosed: error => {
        if (command.kind === 'advance' && (error instanceof WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_BUSY'
          || error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT')) rollbackClosedFailure = { error };
      } }));
  };
  try {
    if (command.kind === 'observe') return await execute();
    if (command.kind === 'select') return await withWorkspaceMutationLock(workspaceId,
      () => withNativeInspectionSchema(execute));
    const settled = await withWorkspaceMutationLock(workspaceId, async (): Promise<
      { kind: 'value'; value: PhaseResult } | { kind: 'rolled-back-busy'; error: unknown }> => {
      try { return { kind: 'value', value: await execute() }; }
      catch (error) {
        // execute has also left the Principal scope. Returning a private value
        // makes a later mutex disposal rejection ineligible, even if it throws
        // the very same error object as the original SQL failure.
        if (rollbackClosedFailure && rollbackClosedFailure.error === error) return { kind: 'rolled-back-busy', error };
        throw error;
      }
    });
    if (settled.kind === 'value') return settled.value;
    const retryable = new WorkspaceImplicitMoveOperationError('IMPLICIT_MOVE_BUSY', 503,
      undefined, command.lookup.requestId, { cause: settled.error });
    retryableAdvanceFailures.set(retryable, command);
    throw retryable;
  }
  catch (error) {
    if (!(error instanceof UnconfirmedPhase)) {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      const operationId = command.kind === 'select' ? command.input.operationId : undefined;
      const requestId = command.kind === 'select' ? undefined : command.lookup.requestId;
      if (code === 'PRINCIPAL_AUTH_REVOKED') throw new WorkspaceImplicitMoveOperationError(
        'IMPLICIT_MOVE_AUTH_REQUIRED', 401, operationId, requestId, { cause: error });
      if (code === 'PRINCIPAL_ACCESS_DENIED' || code === 'PRINCIPAL_SCOPE_CHANGED') throw new WorkspaceImplicitMoveOperationError(
        'IMPLICIT_MOVE_ACCESS_DENIED', 403, operationId, requestId, { cause: error });
      if (['PRINCIPAL_REQUIRED','PRINCIPAL_INVALID','PRINCIPAL_WORKSPACE_UNCONFIRMED','PRINCIPAL_SCHEMA_INVALID',
        'PRINCIPAL_DETACHED','PRINCIPAL_REENTRANT','PRINCIPAL_TOO_LARGE'].includes(code)) throw new WorkspaceImplicitMoveOperationError(
        'IMPLICIT_MOVE_PRINCIPAL_UNCONFIRMED', 503, operationId, requestId, { cause: error });
      // A real guard denial before a prebatch row exists is unavailable, not a
      // fabricated pending operation. Preserve the stable caller operation ID.
      if (['ADMISSION_CONFLICT','PRINCIPAL_BUSY','PRINCIPAL_EXPIRED','55P03','25P04',
        'FILE_MUTATION_LOCK_BUSY','FILE_MUTATION_LOCK_TIMEOUT','FILE_MUTATION_LOCK_UNAVAILABLE'].includes(code)) {
        reportWorkspaceOperationFailureDiagnostics(error, diagnostic => console.error(
          '[workspace-implicit-move] Preparation phase unavailable.', { phase: command.kind, diagnostic }));
        throw new WorkspaceImplicitMoveOperationError(code === '25P04' || code === 'PRINCIPAL_EXPIRED'
          ? 'IMPLICIT_MOVE_PHASE_TIMEOUT' : 'IMPLICIT_MOVE_BUSY', 503,
        command.kind === 'select' ? command.input.operationId : undefined,
        command.kind === 'select' ? undefined : command.lookup.requestId, { cause: error });
      }
      throw error;
    }
    if (command.kind === 'observe') throw new WorkspaceImplicitMoveOperationError('IMPLICIT_MOVE_HISTORY_UNCONFIRMED', 503,
      error.attempted.snapshot?.saved.selection.operationId, error.attempted.snapshot?.saved.request.requestId, { cause: error });
    // Old B and its kernel/capability scopes have fully unwound before fresh reauthentication.
    const attempted = error.attempted.snapshot;
    if (!attempted) throw error;
    const observed = await runPhase(original, { kind: 'observe', lookup: { workspaceId, requestId: attempted.saved.request.requestId } });
    if (!observed.snapshot || !equal(observed.snapshot.saved.request, attempted.saved.request)) throw error;
    if (error.attempted.progress?.some(progress => progress.proofText !== null)) {
      // A lost proof-commit is not promoted from a header alone: require its exact saved proof.
      // Fixed next advance re-proves it; return pending now rather than inventing progress.
      return { snapshot: observed.snapshot };
    }
    return observed;
  }
}
async function finish(original: NextRequest, saved: Saved): Promise<Snapshot> {
  const workspaceId = saved.selection.scope.workspaceId, lookup = { workspaceId, requestId: saved.request.requestId };
  let mutationEntered = false, closeFailed = false;
  const roomKeys = saved.request.expectedDocuments.map(document => lockIdentity(document.documentId).key);
  const uniqueRoomKeys = new Set(roomKeys).size === roomKeys.length;
  const handoff = createCollaborationAdmissionHandoffService({ openConnection: async () => {
    const database = await openDb();
    return { ...database, close: async (error?: Error) => {
      try { await database.close(error); }
      catch (closeError) { closeFailed = true; throw closeError; }
    } };
  },
    withMutationLocks: (ids, execute) => {
      if (!equal(ids, [workspaceId])) fail(); return withWorkspaceMutationLock(workspaceId, execute);
    } });
  const authorize = async (request: CollaborationAdmissionRequest) => {
    if (!equal(captureCollaborationAdmissionRequest(request), captureCollaborationAdmissionRequest(saved.request))) fail();
    const current = await runPhase(original, { kind: 'observe', lookup });
    if (!current.snapshot || !equal(current.snapshot.saved.request, saved.request)) fail();
  };
  const prepare = async (database: SqlConnection) => {
    const captured = captureCollaborationAdmissionRequest(saved.request);
    const row = await database.get(`SELECT request_digest,intent_text FROM ${quote(saved.selection.origin.schema)}.collaboration_admission_requests
      WHERE request_id=$1`, [saved.request.requestId]) as Row | undefined;
    if (row?.request_digest !== captured.requestDigest || row?.intent_text !== captured.intentText) fail();
  };
  let boundHere = false;
  try {
    await handoff.execute(saved.request, { authorize, prepare,
      mutate: async database => {
        mutationEntered = true; // Before the first await: a failed mutation is never a busy retry.
        const result = await prepareWorkspaceImplicitMoveOperationOnConnection(database, saved.request);
        boundHere = true; return result;
      },
      withMutationTransaction: (database, execute) => withWorkspaceImplicitMoveHandoffTransactionOnConnection(database,
        { originalRequest: original, request: saved.request }, execute) });
  } catch (error) {
    reportWorkspaceOperationFailureDiagnostics(error, diagnostics => {
      console.error('[File action preparation] Final handoff failed.', JSON.stringify({
        version: 1, stage: 'final-handoff', diagnostics }));
    });
    // Every failed/uncertain final handoff is observed with a new genuine Principal
    // AFTER its actual B/mutex scope unwound. This performs no selection replan.
    const recovered = await runPhase(original, { kind: 'observe', lookup });
    if (!recovered.snapshot) fail('IMPLICIT_MOVE_OUTCOME_UNCONFIRMED', 503);
    // A failed close may itself throw an admission-shaped error. Neither it nor
    // an aggregate can become a retry or be silently upgraded by saved facts.
    if (closeFailed || error instanceof AggregateError) throw new WorkspaceImplicitMoveOperationError(
      'IMPLICIT_MOVE_DISPOSAL_UNCONFIRMED', 503, saved.selection.operationId, saved.request.requestId, { cause: error });
    if (recovered.snapshot.result.state !== 'pending') return recovered.snapshot;
    if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT'
      && !mutationEntered && uniqueRoomKeys && recovered.snapshot.saved.outcome === null
      && ['reserved','draining'].includes(recovered.snapshot.saved.headerStatus)
      && recovered.snapshot.result.canResume
      && equal(recovered.snapshot.saved.request, saved.request)
      && equal(recovered.snapshot.saved.selection, saved.selection)) {
      // Only a fresh identical sealed reservation may resume after every old
      // connection, Principal, room guard and kernel scope has fully unwound.
      return recovered.snapshot;
    }
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    if (['IMPLICIT_MOVE_SELECTION_CHANGED','NATIVE_MOVE_PLAN_CHANGED','NATIVE_MOVE_PLAN_UNSUPPORTED'].includes(code)) {
      // Only these explicit no-write precondition failures terminate the original
      // sealed selection. The existing abort protocol independently re-proves it.
      await handoff.abort(saved.request, { authorize, prepare,
        withMutationTransaction: async (database, execute) => {
          await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
          await database.run("SET LOCAL statement_timeout='5s'");
        await database.run("SET LOCAL lock_timeout='4s'");
          let actual: WorkspaceRequestHistoricalOrigin | undefined;
          return withWorkspaceRequestPrincipalOriginalOrigin(original,
            { workspaceId, permission: 'canWrite' }, origin => {
              if (!sameReauthorizedOrigin(origin, saved.selection.origin) || actual && !equal(actual, origin)) fail();
              actual ??= origin;
            }, principal => withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
              if (!actual) fail();
              await assertCurrent(database, access, actual!, saved.selection);
              await tryLockCollaborationAdmissionWorkspace((sql, values) => database.all(sql, values) as Promise<Row[]>, workspaceId);
              await pinHistoryRelations(database, actual!);
              const outcome = await execute();
              await assertCurrent(database, access, actual!, saved.selection);
              return outcome;
            }));
        } }, 'precondition_failed');
      const aborted = await runPhase(original, { kind: 'observe', lookup });
      if (!aborted.snapshot || aborted.snapshot.result.state === 'pending') fail('IMPLICIT_MOVE_OUTCOME_UNCONFIRMED', 503);
      return aborted.snapshot;
    }
    throw new WorkspaceImplicitMoveOperationError('IMPLICIT_MOVE_OUTCOME_UNCONFIRMED', 503,
      saved.selection.operationId, saved.request.requestId, { cause: error });
  }
  // Required even when generic Handoff took its committed fast path or confirmed a lost COMMIT.
  const observed = await runPhase(original, { kind: 'observe', lookup });
  if (!observed.snapshot || observed.snapshot.result.state === 'pending') fail('IMPLICIT_MOVE_OUTCOME_UNCONFIRMED', 503);
  if (observed.snapshot.result.state === 'aborted') return observed.snapshot;
  return { ...observed.snapshot, result: { ...observed.snapshot.result, historical: !boundHere } };
}

async function continueSaved(original: NextRequest, first: Snapshot, waitMs: number): Promise<WorkspaceImplicitMoveOperationResult> {
  if (first.result.state !== 'pending') return first.result;
  const deadline = Date.now() + waitMs;
  let current = first;
  const pause = () => new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  while (Date.now() < deadline) {
    let pending = false;
    const documents = current.saved.request.expectedDocuments;
    for (let offset = 0; offset < documents.length; offset += ADVANCE_DOCUMENTS_PER_PHASE) {
      if (Date.now() >= deadline) return current.result;
      const command: Extract<Command, { kind: 'advance' }> = { kind: 'advance', lookup: {
        workspaceId: current.saved.selection.scope.workspaceId, requestId: current.saved.request.requestId },
      expected: current.saved.request, deadline,
      documentIds: Object.freeze(documents.slice(offset, offset + ADVANCE_DOCUMENTS_PER_PHASE).map(document => document.documentId)) };
      let advanced: PhaseResult;
      while (true) {
        if (Date.now() >= deadline) return current.result;
        try { advanced = await runPhase(original, command); break; }
        catch (error) {
          if (!(error instanceof WorkspaceImplicitMoveOperationError) || retryableAdvanceFailures.get(error) !== command) throw error;
          retryableAdvanceFailures.delete(error);
          // Fresh authentication and SQL on the next attempt, with the same
          // request/group and original deadline. No scope survives this wait.
          if (Date.now() >= deadline) return current.result;
          await pause();
        }
      }
      if (!advanced.snapshot) fail(); current = advanced.snapshot!;
      if (current.result.state !== 'pending') return current.result;
      pending ||= advanced.progress?.length !== command.documentIds.length
        || advanced.progress.some(progress => progress.proofText === null);
    }
    if (!pending) {
      if (Date.now() >= deadline) return current.result;
      current = await finish(original, current.saved);
      if (current.result.state !== 'pending') return current.result;
    }
    if (Date.now() >= deadline) return current.result;
    // No SQL connection, Principal phase, kernel mutex or lifecycle lease remains while waiting.
    await pause();
  }
  return current.result;
}
function boundedWait(waitMs: number): number {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 20_000) fail('IMPLICIT_MOVE_INVALID_REQUEST', 422);
  return waitMs;
}
/** Route invokes this only AFTER leaving its outer selection mutex. Operation ID is generated once by the route. */
export async function prepareWorkspaceImplicitMoveOperation(original: NextRequest, supplied: Input,
  waitMs = 20_000): Promise<WorkspaceImplicitMoveOperationResult> {
  const started = Date.now(), input = captureInput(supplied); boundedWait(waitMs);
  if (!(original instanceof NextRequest) || !authenticatedNativeTextSessionEnabled()) fail('IMPLICIT_MOVE_UNAVAILABLE', 503);
  const initial = await runPhase(original, { kind: 'select', input });
  if (initial.legacy) return initial.legacy;
  if (!initial.snapshot) fail(); return continueSaved(original, initial.snapshot!, Math.max(0, waitMs - (Date.now() - started)));
}
/** SQL-only status. It never collects the removed path or advances a reservation. */
export async function readWorkspaceImplicitMoveOperation(original: NextRequest, lookup: Lookup): Promise<WorkspaceImplicitMoveOperationResult> {
  const captured = captureLookup(lookup);
  const observed = await runPhase(original, { kind: 'observe', lookup: captured });
  if (!observed.snapshot) fail('IMPLICIT_MOVE_NOT_FOUND'); return observed.snapshot!.result;
}
/** Explicit resume uses exactly the saved immutable selection and original identity. */
export async function resumeWorkspaceImplicitMoveOperation(original: NextRequest, lookup: Lookup,
  waitMs = 20_000): Promise<WorkspaceImplicitMoveOperationResult> {
  const started = Date.now(), captured = captureLookup(lookup); boundedWait(waitMs);
  const observed = await runPhase(original, { kind: 'observe', lookup: captured });
  if (!observed.snapshot) fail('IMPLICIT_MOVE_NOT_FOUND');
  return continueSaved(original, observed.snapshot!, Math.max(0, waitMs - (Date.now() - started)));
}
