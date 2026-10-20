import 'server-only';

import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { captureCollaborationAdmissionRequest, collaborationAdmissionLockKey,
  type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { reserveCollaborationAdmissionOnConnection, tryLockCollaborationAdmissionWorkspace }
  from '../collaboration/room-admission';
import { requireCollaborationAdmissionMutationRequest, withCollaborationAdmissionMutation }
  from '../collaboration/room-admission-handoff';
import { readCollaborationAdmissionOutcome, captureCollaborationAdmissionOutcomeResult } from '../collaboration/room-admission-outcome';
import { lockIdentity } from '../collaboration/room-owner';
import { withWorkspaceRequestPrincipalOriginalOrigin, withWorkspaceRequestPrincipalOnConnection,
  assertWorkspaceNativeEditRequestPrincipalActiveOnConnection, type WorkspaceRequestPrincipal,
  type WorkspaceRequestPrincipalAccess, type WorkspaceRequestHistoricalOrigin }
  from '../workspaces/request-principal';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { createWorkspaceOperationNativeMoveBatchPlanV4,
  type WorkspaceOperationNativeMoveBatchPlanV4 } from './workspace-operation-native-move-plan';
import { decodeWorkspaceImplicitMoveSelectionRequest, assertWorkspaceImplicitMoveSelectionCurrent,
  getWorkspaceImplicitMoveSelectionBatchIdentity, getWorkspaceImplicitMoveSelectionDigest,
  type WorkspaceImplicitMoveSelectionV1 } from './workspace-implicit-move-selection';
import type { WorkspaceOperationBatchRecord, WorkspaceOperationBatchClaimBinding }
  from './workspace-operation-batch-store';

declare const freshMoveBrand: unique symbol;
export type WorkspaceImplicitMovePreparationHandle = Readonly<{ [freshMoveBrand]: never }>;
type Operation = Readonly<{ batch: WorkspaceOperationBatchRecord; binding: WorkspaceOperationBatchClaimBinding }>;
export type WorkspaceImplicitMoveAdmissionPreparation = Readonly<{
  request: CollaborationAdmissionRequest; preparationDigest: string;
}>;
type Identity = Readonly<{ backend: number; start: string; xid: string; databaseOid: number;
  schemaName: string; schemaOid: number; searchPath: string }>;
type Relation = Readonly<{ name: string; oid: number }>;
type Frame = {
  active: boolean; database: SqlConnection; principal: WorkspaceRequestPrincipal;
  access: WorkspaceRequestPrincipalAccess; actualCurrentOrigin: WorkspaceRequestHistoricalOrigin;
  request: ReturnType<typeof captureCollaborationAdmissionRequest>;
  selection: WorkspaceImplicitMoveSelectionV1; selectionDigest: string; identity: Identity;
  relations: readonly Relation[]; stage: 'initial' | 'planning' | 'batch' | 'p0' | 'prepared' | 'transferred';
  nativePlan?: WorkspaceOperationNativeMoveBatchPlanV4; preparedAt?: number;
  operation?: Operation; prepared?: WorkspaceImplicitMoveAdmissionPreparation;
  startedAt: number; milestones: Array<Readonly<{ stage: string; elapsedMs: number }>>;
};
const frames = new WeakMap<WorkspaceImplicitMovePreparationHandle, Frame>();
const byConnection = new WeakMap<SqlConnection, WorkspaceImplicitMovePreparationHandle>();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const names = ['workspace_file_operation_batches', 'workspace_file_operation_move_preparations',
  'collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages',
  'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets',
  'collaboration_native_file_operation_intents'] as const;
function fail(): never { throw Object.assign(new Error('The original implicit Move phase changed.'),
  { code: 'IMPLICIT_MOVE_PHASE_CHANGED', status: 409 }); }
function mark(frame: Frame, stage: string): void {
  frame.milestones.push(Object.freeze({ stage, elapsedMs: Math.round(performance.now() - frame.startedAt) }));
}

function sameReauthorizedOrigin(actual: WorkspaceRequestHistoricalOrigin, saved: WorkspaceRequestHistoricalOrigin): boolean {
  const { sessionId: actualSessionId, ...actualMetadata } = actual;
  const { sessionId: savedSessionId, ...savedMetadata } = saved;
  return typeof actualSessionId === 'string' && typeof savedSessionId === 'string' && equal(actualMetadata, savedMetadata);
}

async function identity(database: SqlConnection, origin: WorkspaceRequestHistoricalOrigin): Promise<Identity> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start,pg_catalog.pg_current_xact_id()::text AS xid,
    pg_catalog.current_schema() AS schema_name,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Record<string, unknown> | undefined;
  if (!row || !Number.isSafeInteger(row.backend) || Number(row.backend) < 1
    || typeof row.start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.start)
    || typeof row.xid !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.xid)
    || row.schema_name !== origin.schema || Number(row.schema_oid) !== origin.schemaOid
    || Number(row.database_oid) !== origin.databaseOid || row.search_path !== origin.searchPath
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') fail();
  return Object.freeze({ backend: Number(row.backend), start: row.start as string, xid: row.xid as string,
    schemaName: origin.schema, schemaOid: origin.schemaOid, databaseOid: origin.databaseOid,
    searchPath: origin.searchPath });
}
async function relationFacts(database: SqlConnection, origin: WorkspaceRequestHistoricalOrigin): Promise<readonly Relation[]> {
  const rows = await database.all(`SELECT c.relname AS name,c.oid::bigint AS oid,
    c.relnamespace::bigint AS schema_oid,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname))::oid::bigint AS resolved
    FROM pg_catalog.pg_class c WHERE c.relnamespace=$1::oid AND c.relname=ANY($2::text[])
    ORDER BY c.relname COLLATE "C"`, [origin.schemaOid, names]) as Record<string, unknown>[];
  if (rows.length !== names.length || new Set(rows.map(row => row.name)).size !== names.length
    || rows.some(row => !names.includes(row.name as typeof names[number])
      || !Number.isSafeInteger(Number(row.oid)) || Number(row.oid) < 1
      || Number(row.schema_oid) !== origin.schemaOid || Number(row.resolved) !== Number(row.oid)
      || row.relkind !== 'r' || row.relpersistence !== 'p'
      || row.relrowsecurity !== false || row.relforcerowsecurity !== false)) fail();
  return Object.freeze(rows.map(row => Object.freeze({ name: String(row.name), oid: Number(row.oid) })));
}
async function assertGuards(frame: Frame): Promise<void> {
  const keys = [collaborationAdmissionLockKey(frame.selection.scope.workspaceId),
    ...frame.request.request.expectedDocuments.map(document => lockIdentity(document.documentId).key)];
  if (new Set(keys).size !== keys.length) fail();
  const row = await frame.database.get(`SELECT count(DISTINCT ((classid::bigint << 32) | objid::bigint))::integer AS held
    FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid() AND database=$1::oid
      AND locktype='advisory' AND granted AND mode='ExclusiveLock' AND objsubid=1
      AND ((classid::bigint << 32) | objid::bigint)=ANY($2::bigint[])`,
  [frame.identity.databaseOid, keys]) as Record<string, unknown> | undefined;
  if (Number(row?.held) !== keys.length) fail();
}
async function assertFrame(database: SqlConnection, handle: WorkspaceImplicitMovePreparationHandle): Promise<Frame> {
  const frame = frames.get(handle);
  if (!frame?.active || frame.database !== database || byConnection.get(database) !== handle) fail();
  assertWorkspaceNativeEditRequestPrincipalActiveOnConnection(database, frame.principal);
  await frame.access.assertCurrent();
  const workspace = frame.access.workspace;
  if (workspace.legacy || workspace.status !== 'active' || !workspace.permissions.canRead
    || !workspace.permissions.canWrite || !workspace.permissions.canDelete
    || frame.access.userId !== frame.actualCurrentOrigin.userId || frame.access.sessionId !== frame.actualCurrentOrigin.sessionId
    || !equal(captureWorkspaceOperationJobScope(workspace), frame.selection.scope)
    || !sameReauthorizedOrigin(frame.actualCurrentOrigin, frame.selection.origin)
    || !equal(await identity(database, frame.actualCurrentOrigin), frame.identity)
    || !equal(await relationFacts(database, frame.actualCurrentOrigin), frame.relations)) fail();
  await assertGuards(frame);
  if (!frame.active || frames.get(handle) !== frame) fail();
  return frame;
}

/** Fixed consumers receive facts only from the active same-B genuine phase. */
export async function assertWorkspaceImplicitMovePreparationOnConnection(database: SqlConnection,
  handle: WorkspaceImplicitMovePreparationHandle) {
  const frame = await assertFrame(database, handle);
  if (!frame.nativePlan || frame.preparedAt === undefined || !['batch', 'p0'].includes(frame.stage)) fail();
  const active = captureCollaborationAdmissionRequest(requireCollaborationAdmissionMutationRequest(database, frame.selection.action));
  if (active.requestDigest !== frame.request.requestDigest || active.intentText !== frame.request.intentText) fail();
  return Object.freeze({ selection: frame.selection, selectionDigest: frame.selectionDigest, access: frame.access, actualCurrentOrigin: frame.actualCurrentOrigin,
    identity: frame.identity, nativePlan: frame.nativePlan, preparedAt: frame.preparedAt, operation: frame.operation });
}

/** Exact domain.mutate callback. No caller source, actor, plan or handle accepted. */
export async function prepareWorkspaceImplicitMoveOperationOnConnection(database: SqlConnection,
  request: CollaborationAdmissionRequest): Promise<Readonly<Record<string, string>>> {
  const handle = byConnection.get(database);
  if (!handle) fail();
  const frame = frames.get(handle!);
  if (!frame?.active || frame.database !== database || frame.stage !== 'initial') fail();
  frame.stage = 'planning'; // Single-use before the first await; concurrent entries cannot both plan.
  await assertFrame(database, handle!);
  const supplied = captureCollaborationAdmissionRequest(request);
  if (supplied.requestDigest !== frame.request.requestDigest || supplied.intentText !== frame.request.intentText) fail();
  return withCollaborationAdmissionMutation(database, frame.selection.action, async assertActive => {
    const actual = captureCollaborationAdmissionRequest(requireCollaborationAdmissionMutationRequest(database, frame.selection.action));
    if (actual.requestDigest !== frame.request.requestDigest || actual.intentText !== frame.request.intentText) fail();
    const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database, frame.access.workspace,
      { physicalParserVersion: 3 });
    mark(frame, 'source-collected');
    assertActive(); await assertFrame(database, handle!);
    // Pure historical anchor metadata only; current B authority was independently
    // proven by assertFrame above and is rechecked below. This does not impersonate A.
    assertWorkspaceImplicitMoveSelectionCurrent(frame.selection, { origin: frame.selection.origin,
      scope: captureWorkspaceOperationJobScope(frame.access.workspace), observation });
    const selections = frame.selection.selections.map(selection => ({ ...selection }));
    const actionId = createHash('sha256').update(JSON.stringify(['workspace-path-action-v1',
      frame.selection.scope.workspaceId, frame.selection.action, selections, false, false])).digest('hex');
    frame.nativePlan = createWorkspaceOperationNativeMoveBatchPlanV4({
      scope: { workspace: frame.access.workspace, fileOptions: { workspace: frame.access.workspace } },
      actions: [{ reviewId: `${actionId}-request`, kind: frame.selection.action, selections }], observation });
    frame.preparedAt = Date.now(); frame.stage = 'batch';
    mark(frame, 'plan-built');
    const { insertWorkspaceImplicitMoveBatchOnConnection } = await import('./workspace-operation-batch-store');
    frame.operation = await insertWorkspaceImplicitMoveBatchOnConnection(database, handle!);
    mark(frame, 'batch-inserted');
    assertActive(); await assertFrame(database, handle!); frame.stage = 'p0';
    const { prepareWorkspaceImplicitMoveAdmissionOnConnection } = await import('./workspace-operation-native-path-admission');
    frame.prepared = await prepareWorkspaceImplicitMoveAdmissionOnConnection(database, handle!);
    mark(frame, 'admission-prepared');
    assertActive(); await assertFrame(database, handle!); frame.stage = 'prepared';
    const finalRequest = captureCollaborationAdmissionRequest(frame.prepared.request);
    if (finalRequest.request.requestId === frame.request.request.requestId) fail();
    return captureCollaborationAdmissionOutcomeResult({ kind: 'implicitNativeMoveV1',
      selectionDigest: frame.selectionDigest, batchId: frame.operation.batch.batchId,
      planId: frame.nativePlan.planId, preparationDigest: frame.prepared.preparationDigest,
      finalRequestId: finalRequest.request.requestId, finalRequestDigest: finalRequest.requestDigest });
  });
}

/** Exact existing Handoff.withMutationTransaction wrapper. Caller already owns
 * B/BEGIN/COMMIT/rollback and kernel mutex through COMMIT. No capability crosses drain. */
export async function withWorkspaceImplicitMoveHandoffTransactionOnConnection<T>(database: SqlConnection,
  input: Readonly<{ originalRequest: NextRequest; request: CollaborationAdmissionRequest }>,
  execute: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const selection = decodeWorkspaceImplicitMoveSelectionRequest(input.request);
  const captured = captureCollaborationAdmissionRequest(input.request);
  if (!authenticatedNativeTextSessionEnabled() || !(input.originalRequest instanceof NextRequest)
    || byConnection.has(database) || typeof execute !== 'function') fail();
  // OriginalOrigin also observes the actual B after entry and on every current/final check.
  // It never permits replacing an original session or realm with new request selectors.
  let actualCurrentOrigin: WorkspaceRequestHistoricalOrigin | undefined;
  return withWorkspaceRequestPrincipalOriginalOrigin(input.originalRequest,
    { workspaceId: selection.scope.workspaceId, permission: 'canWrite' },
    origin => {
      if (!sameReauthorizedOrigin(origin, selection.origin) || actualCurrentOrigin && !equal(origin, actualCurrentOrigin)) fail();
      actualCurrentOrigin ??= origin; // Actual synchronous private Principal observer; never supplied by DTO.
    }, principal =>
      withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
        if (!actualCurrentOrigin || access.userId !== actualCurrentOrigin.userId || access.sessionId !== actualCurrentOrigin.sessionId
          || !access.workspace.permissions.canRead || !access.workspace.permissions.canWrite
          || !access.workspace.permissions.canDelete) fail();
        // Reentrant only on this same B; no A/B lock-skip flag or public ALS lease.
        await tryLockCollaborationAdmissionWorkspace((sql, values) => database.all(sql, values) as Promise<Record<string, unknown>[]>,
          selection.scope.workspaceId);
        const before = await relationFacts(database, selection.origin);
        await database.run(`LOCK TABLE ${names.map(name => `${quote(selection.origin.schema)}.${quote(name)}`).join(',')}
          IN ROW EXCLUSIVE MODE NOWAIT`);
        if (!equal(before, await relationFacts(database, selection.origin))) fail();
        const handle = Object.freeze({}) as WorkspaceImplicitMovePreparationHandle;
        const frame: Frame = { active: true, database, principal, access, actualCurrentOrigin, request: captured,
          selection, selectionDigest: getWorkspaceImplicitMoveSelectionDigest(selection),
          identity: await identity(database, actualCurrentOrigin), relations: before, stage: 'initial', startedAt, milestones: [] };
        frames.set(handle, frame); byConnection.set(database, handle);
        try {
          mark(frame, 'principal-bound');
          await assertFrame(database, handle);
          const outcome = await execute(); // Bootstrap completed/inactive here; no SQL COMMIT yet.
          mark(frame, 'bootstrap-outcome');
          await assertFrame(database, handle);
          const stored = await readCollaborationAdmissionOutcome(database, captured);
          if (!stored || !equal(stored, outcome) || stored.version !== 1
            || stored.result.kind !== 'implicitNativeMoveV1'
            || stored.result.selectionDigest !== frame.selectionDigest
            || stored.result.batchId !== getWorkspaceImplicitMoveSelectionBatchIdentity(selection).batchId
            || !equal(Object.keys(stored.result).sort(), ['batchId','finalRequestDigest','finalRequestId',
              'kind','planId','preparationDigest','selectionDigest'].sort())
            || !['planId','preparationDigest','finalRequestDigest'].every(key => /^[a-f0-9]{64}$/u.test(stored.result[key]))
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(stored.result.finalRequestId)) fail();
          if (frame.stage === 'initial') {
            // Concurrent completed retry: do not recreate anything. Fixed coordinator
            // must strictly read the linked final artifacts after confirmed return.
            return outcome;
          }
          if (frame.stage !== 'prepared' || !frame.operation || !frame.prepared || !frame.nativePlan) fail();
          const finalRequest = captureCollaborationAdmissionRequest(frame.prepared.request);
          const expected = captureCollaborationAdmissionOutcomeResult({ kind: 'implicitNativeMoveV1',
            selectionDigest: frame.selectionDigest, batchId: frame.operation.batch.batchId,
            planId: frame.nativePlan.planId, preparationDigest: frame.prepared.preparationDigest,
            finalRequestId: finalRequest.request.requestId, finalRequestDigest: finalRequest.requestDigest });
          if (!equal(stored.result, expected)) fail();
          const reserved = await reserveCollaborationAdmissionOnConnection(database, finalRequest.request);
          if (reserved.requestId !== finalRequest.request.requestId || reserved.requestDigest !== finalRequest.requestDigest
            || reserved.status !== 'reserved') fail();
          await assertFrame(database, handle); frame.stage = 'transferred';
          mark(frame, 'final-reserved');
          return outcome;
        } finally {
          frame.active = false; frames.delete(handle); byConnection.delete(database);
          // Durations describe this callback only; the outer transaction has not committed.
          try { console.info('[File action preparation] Final phase timings.', JSON.stringify({
            version: 1, stage: frame.stage, elapsedMs: Math.round(performance.now() - startedAt), milestones: frame.milestones })); }
          catch { /* A diagnostic sink cannot change the original phase result. */ }
        }
      }));
}
