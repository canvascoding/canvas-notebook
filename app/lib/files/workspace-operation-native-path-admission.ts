import 'server-only';
import { decodeWorkspaceOperationDeleteBatchPlan } from './workspace-operation-delete-plan-dispatch';
import { assertWorkspaceOperationPhysicalDeleteCurrentV5 } from './workspace-operation-physical-delete-html-plan-v5';

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { captureCollaborationAdmissionRequest, CollaborationAdmissionError,
  type CollaborationAdmissionRequest, type CollaborationAdmissionStatus } from '../collaboration/room-admission-contract';
import { reserveCollaborationAdmissionOnConnection, startCollaborationAdmissionDrainOnConnection,
  tryLockCollaborationAdmissionWorkspace, type CollaborationAdmissionResult } from '../collaboration/room-admission';
import { proveCollaborationAdmissionQuiescenceOnConnection } from '../collaboration/room-admission-quiescence';
import { readHistoricalCollaborationAdmissionOutcomeOnConnection, type CollaborationAdmissionOutcome } from '../collaboration/room-admission-outcome';
import { getCollaborationRoomConnectionCount } from '../collaboration/runtime-state';
import { withNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { decodeNativeFileOperationBundleText, stageNativeFileOperationBundleOnConnection } from '../markdown/native-file-operation-handoff';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationJobPolicy, withWorkspaceOperationJobPolicyOnConnection,
  type WorkspaceOperationJobPolicyAccess } from '../workspaces/workspace-operation-job-principal';
import { captureWorkspaceOperationMcpJobPrincipal, assertWorkspaceOperationMcpJobPrincipalCaptured,
  withWorkspaceOperationMcpJobPolicyOnConnection, type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import { WorkspaceOperationBatchError, readWorkspaceOperationBatchClaimBinding,
  type WorkspaceOperationBatchClaim, type WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import type { WorkspaceOperationDirectAuthorization, WorkspaceOperationDirectMcpAuthorization,
  WorkspaceOperationJobScope, WorkspaceOperationDeleteBatchPlan } from './workspace-operation-batch-contract';
import { workspaceOperationJobScopeMatches } from './workspace-operation-job-scope';
import { workspaceOperationSourceNativeEvidence } from './workspace-operation-mixed-source-evidence';
import { deriveWorkspacePathPhysicalParserVersion } from './workspace-operation-path-source-parser';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { withWorkspaceOperationJobClaimPhase } from './workspace-operation-job-phase-scheduling';
import { WorkspaceFileLifecycleBusyError } from './workspace-file-lifecycle-guard';
import { decodeWorkspaceOperationNativeMoveBatchPlan, captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness,
  WorkspaceOperationNativeMovePlanError, type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { assertWorkspaceOperationNativeDeleteBatchPlanCurrent,
  WorkspaceOperationNativeDeletePlanError } from './workspace-operation-native-delete-plan';
import { parseWorkspaceOperationOriginalMoveIntent, prepareWorkspaceOperationOriginalMoveNativeBundleData,
  decodeWorkspaceOperationOriginalMoveNativeBundleData, getWorkspaceOperationOriginalMoveNativeIds,
  type WorkspaceOperationOriginalMoveContext } from './workspace-operation-original-move';
import { createWorkspaceOperationOriginalMoveAdmissionRequest,
  createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle } from './workspace-operation-original-move-admission';
import { readWorkspaceOperationOriginalMoveIntentOnConnection } from './workspace-operation-original-move-repository';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection } from './workspace-operation-original-delete-repository';
import { captureOriginalDeleteAdmissionBinding } from './workspace-operation-original-delete-evidence';
import { createWorkspaceOperationOriginalDeleteAdmissionRequest } from './workspace-operation-original-delete-admission';
import { createWorkspaceOperationOriginalMovePreparation, readWorkspaceOperationOriginalMovePreparationOnConnection,
  insertWorkspaceOperationOriginalMovePreparationOnConnection } from './workspace-operation-original-move-preparation';
import { bindWorkspaceOperationOriginalMoveStorageOnConnection } from './workspace-operation-original-move-storage';
import { bindWorkspaceOperationOriginalDeleteStorageOnConnection } from './workspace-operation-original-delete-storage';
import { bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection } from './workspace-operation-original-move-handoff-storage';
import type { WorkspacePathImportPreparationHandle } from './workspace-path-import-preparation-phase';

type NativePathBinding = Readonly<{
  binding: WorkspaceOperationBatchClaimBinding; authorization: WorkspaceOperationDirectAuthorization | WorkspaceOperationDirectMcpAuthorization;
  scope: WorkspaceOperationJobScope; plan: WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationDeleteBatchPlan;
  kind: 'move' | 'delete';
}>;
export type WorkspaceOperationNativePathAdmissionRead = Readonly<{
  request: CollaborationAdmissionRequest; status: CollaborationAdmissionStatus; outcome: CollaborationAdmissionOutcome | null;
}>;
export type WorkspaceOperationNativePathAdmissionResult = Readonly<{ status: 'ready' | 'pending'; requestId: string }>;
type NativePathRequest = Readonly<{ request: CollaborationAdmissionRequest; requiresHeader: boolean; legacy: boolean }>;
type Row = Record<string, unknown>;
export { createWorkspaceOperationOriginalDeleteAdmissionRequest } from './workspace-operation-original-delete-admission';


function nativePathBinding(claim: WorkspaceOperationBatchClaim): NativePathBinding {
  return captureNativePathBindingFacts(readWorkspaceOperationBatchClaimBinding(claim));
}

/** Shape and original-plan facts only. This never registers a Claim or grants
 * current authorization; its two callers retain their own genuine boundary. */
function captureNativePathBindingFacts(binding: WorkspaceOperationBatchClaimBinding): NativePathBinding {
  const auth = binding.authorization;
  if (binding.actionMode !== 'apply' || auth.mode !== 'direct' && auth.mode !== 'direct-mcp' || !auth.jobScope || auth.jobScope.legacy
    || binding.workspaceId !== auth.jobScope.workspaceId || binding.plan.workspaceId !== binding.workspaceId || binding.plan.planId !== binding.planId
    || binding.plan.readiness !== 'ready' || binding.plan.version !== 2 && binding.plan.version !== 3 && binding.plan.version !== 5
    || typeof binding.source.schemaName !== 'string' || !binding.source.schemaName || Buffer.byteLength(binding.source.schemaName) > 63
    || /[\u0000-\u001f\u007f]/u.test(binding.source.schemaName)
    || Buffer.from(binding.source.schemaName, 'utf8').toString('utf8') !== binding.source.schemaName) {
    throw new WorkspaceOperationBatchError('BATCH_CLAIM_CHANGED', 409, 'The original native path claim is required.');
  }
  const plan = binding.plan.version === 3 ? decodeWorkspaceOperationNativeMoveBatchPlan(binding.plan)
    : decodeWorkspaceOperationDeleteBatchPlan(binding.plan);
  if (!equal(plan.sourceEvidence.workspaceScope, auth.jobScope)) throw new WorkspaceOperationBatchError('BATCH_SCOPE_CHANGED', 409, 'The original workspace scope changed.');
  return Object.freeze({ binding, authorization: auth, scope: auth.jobScope, plan, kind: plan.version === 3 ? 'move' : 'delete' });
}

/** Fixed borrowed B0 operation phase only. The actual Header, imports, P0 and
 * later reservation remain provisional until the caller confirms COMMIT.
 * This mints no Claim, opens no transaction and starts no room drain. */
export async function prepareWorkspacePathImportOperationAdmissionOnConnection(database: SqlConnection,
  handle: WorkspacePathImportPreparationHandle): Promise<CollaborationAdmissionRequest> {
  const { assertWorkspacePathImportOperationPreparationOnConnection } = await import('./workspace-path-import-preparation-phase');
  const current = await assertWorkspacePathImportOperationPreparationOnConnection(database, handle);
  const operation = current.operation;
  if (!operation) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  const original = captureNativePathBindingFacts(operation.binding), origin = current.record.origin;
  if (original.binding.batchId !== current.record.batchId || !equal(original.plan, current.record.nativePlan)
    || !equal(original.scope, origin.scope) || !workspaceOperationJobScopeMatches(original.scope, current.access.workspace)
    || original.authorization.actorUserId !== origin.userId || original.authorization.actorSessionId !== origin.sessionId
    || original.binding.source.schemaName !== origin.realm.schemaName || original.binding.source.schemaOid !== origin.realm.schemaOid
    || original.binding.source.databaseOid !== origin.realm.databaseOid
    || (origin.kind === 'direct-mcp' ? original.authorization.mode !== 'direct-mcp'
      || original.authorization.clientId !== origin.clientId : original.authorization.mode !== 'direct')) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  const { schemaName, schemaOid, databaseOid } = original.binding.source;
  const source = Object.freeze({ schemaName, schemaOid, databaseOid });
  const storage = original.kind === 'move' ? await bindWorkspaceOperationOriginalMoveStorageOnConnection(database, source)
    : await bindWorkspaceOperationOriginalDeleteStorageOnConnection(database, source);
  const handoff = original.kind === 'move' ? null : await bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection(database, source);
  await current.access.assertCurrent();
  const selected = await prepareNativePathRequest(database, original, 'prepare', current.access);
  if (!selected || selected.legacy || !selected.requiresHeader) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  await current.access.assertCurrent(); await storage.assertCurrent(); await handoff?.assertCurrent();
  const after = await assertWorkspacePathImportOperationPreparationOnConnection(database, handle);
  if (!after.operation || !equal(after.operation.binding, operation.binding) || !equal(after.record, current.record)
    || !workspaceOperationJobScopeMatches(original.scope, after.access.workspace)) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  return captureCollaborationAdmissionRequest(selected.request).request;
}

function nativePathMoveContext(original: NativePathBinding): WorkspaceOperationOriginalMoveContext {
  if (original.plan.version !== 3) throw new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_INVALID');
  const auth = original.authorization;
  return Object.freeze({ batchId: original.binding.batchId, requestHash: auth.requestHash, plan: original.plan,
    actor: Object.freeze({ userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: auth.actorSessionId ?? null }) });
}

/** Fixed-claim facts only. No checkout, transaction, current ACL, projection,
 * reservation or mutation is performed. The Owner retains its genuine fences. */
export async function readWorkspaceOperationNativePathAdmissionOnConnection(database: SqlConnection,
  claim: WorkspaceOperationBatchClaim): Promise<WorkspaceOperationNativePathAdmissionRead | null> {
  const original = nativePathBinding(claim), source = original.binding.source;
  const realmSql = `SELECT pg_catalog.current_schema() AS schema_name,pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.current_setting('search_path') AS search_path`;
  const realm = await database.get(realmSql) as Row | undefined;
  if (!realm || realm.schema_name !== source.schemaName || Number(realm.schema_oid) !== source.schemaOid
    || Number(realm.database_oid) !== source.databaseOid || realm.search_path !== source.searchPath) {
    throw new WorkspaceOperationBatchError('BATCH_SCOPE_CHANGED', 409, 'The original journal namespace changed.');
  }
  const prefix = `"${source.schemaName.replaceAll('"', '""')}"`;
  // Every unqualified protocol reader below must resolve these exact permanent
  // tables in the actual Claim realm; pg_temp cannot replace a historical read.
  const names = ['collaboration_admission_requests', 'collaboration_admission_targets', 'collaboration_native_file_operation_intents',
    ...(original.kind === 'move' ? ['workspace_file_operation_move_intents', 'workspace_file_operation_move_preparations'] : ['workspace_file_operation_delete_intents'])];
  const relations = await database.all(`SELECT n.name,c.oid::bigint AS oid,c.relnamespace::bigint AS schema_oid,c.relkind,c.relpersistence,
    c.relrowsecurity,c.relforcerowsecurity,pg_catalog.to_regclass(pg_catalog.quote_ident(n.name))::oid::bigint AS resolved
    FROM pg_catalog.unnest($2::text[]) n(name) LEFT JOIN pg_catalog.pg_class c
      ON c.oid=pg_catalog.to_regclass($1||'.'||pg_catalog.quote_ident(n.name)) ORDER BY n.name COLLATE "C"`, [prefix, names]) as Row[];
  if (relations.length !== names.length || new Set(relations.map(row => row.name)).size !== names.length || relations.some(row =>
    !names.includes(String(row.name)) || Number(row.schema_oid) !== source.schemaOid || !Number.isSafeInteger(Number(row.oid)) || Number(row.oid) < 1
    || Number(row.resolved) !== Number(row.oid) || row.relkind !== 'r' || row.relpersistence !== 'p'
    || row.relrowsecurity !== false || row.relforcerowsecurity !== false)) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  const selected = await prepareNativePathRequest(database, original, 'read');
  if (!selected) {
    if (readWorkspaceOperationBatchClaimBinding(claim) !== original.binding || !equal(await database.get(realmSql), realm)) {
      throw new WorkspaceOperationBatchError('BATCH_SCOPE_CHANGED', 409, 'The original journal namespace changed.');
    }
    return null;
  }
  const captured = captureCollaborationAdmissionRequest(selected.request);
  const header = await database.get(`SELECT CASE WHEN octet_length(request_id)=36 THEN request_id END AS request_id,
    CASE WHEN octet_length(request_digest)=64 THEN request_digest END AS request_digest,
    CASE WHEN octet_length(intent_text)=$2 AND octet_length(intent_text)<=16777216 THEN intent_text END AS intent_text,
    CASE WHEN octet_length(status)<=32 THEN status END AS status FROM ${prefix}.collaboration_admission_requests WHERE request_id=$1`,
  [captured.request.requestId, Buffer.byteLength(captured.intentText)]) as Row | undefined;
  if (!header) {
    if (selected.requiresHeader) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    if (readWorkspaceOperationBatchClaimBinding(claim) !== original.binding || !equal(await database.get(realmSql), realm)) {
      throw new WorkspaceOperationBatchError('BATCH_SCOPE_CHANGED', 409, 'The original journal namespace changed.');
    }
    return null;
  }
  if (header.request_id !== captured.request.requestId || header.request_digest !== captured.requestDigest || header.intent_text !== captured.intentText
    || !['reserved', 'draining', 'recovery_required', 'committed', 'cancelled'].includes(header.status as string)) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  const outcome = await readHistoricalCollaborationAdmissionOutcomeOnConnection(database, captured, { readOnly: true });
  if (header.status === 'committed' && !outcome) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  if (outcome && header.status !== 'committed') throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  if (readWorkspaceOperationBatchClaimBinding(claim) !== original.binding || !equal(await database.get(realmSql), realm)) {
    throw new WorkspaceOperationBatchError('BATCH_SCOPE_CHANGED', 409, 'The original journal namespace changed.');
  }
  return Object.freeze({ request: captured.request, status: header.status as CollaborationAdmissionStatus, outcome });
}

/** Capture the genuine live handle before any FS/pool await. The returned
 * status is published only after the complete original Claim phase settles. */
export function advanceWorkspaceOperationNativePathAdmission(claim: WorkspaceOperationBatchClaim,
  options: Readonly<{ mcpPrincipal?: WorkspaceOperationMcpJobPrincipal; openConnection?: () => Promise<SqlConnection> }> = {}
): Promise<WorkspaceOperationNativePathAdmissionResult> {
  try {
    const original = nativePathBinding(claim);
    if (!options || typeof options !== 'object' || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype
      || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['mcpPrincipal', 'openConnection'].includes(key))) {
      throw new WorkspaceOperationBatchError('BATCH_CLAIM_CHANGED', 409, 'Native path admission options are invalid.');
    }
    const fields = Object.getOwnPropertyDescriptors(options);
    for (const key of Object.keys(fields)) if (!fields[key].enumerable || !Object.hasOwn(fields[key], 'value')) {
      throw new WorkspaceOperationBatchError('BATCH_CLAIM_CHANGED', 409, 'Native path admission options must be own data.');
    }
    const value = fields.mcpPrincipal?.value;
    const mcp = value === undefined ? undefined : captureWorkspaceOperationMcpJobPrincipal(value);
    if (original.authorization.mode === 'direct-mcp') {
      if (!mcp) throw new WorkspaceOperationBatchError('MCP_JOB_PRINCIPAL_REQUIRED', 401, 'The genuine live MCP principal is required.');
      assertWorkspaceOperationMcpJobPrincipalCaptured(mcp, original.binding);
    } else if (mcp) throw new WorkspaceOperationBatchError('BATCH_CLAIM_CHANGED', 409, 'A legacy job cannot adopt an MCP handle.');
    const open = fields.openConnection?.value === undefined ? openDb : fields.openConnection.value;
    if (typeof open !== 'function') throw new WorkspaceOperationBatchError('BATCH_CLAIM_CHANGED', 409, 'A real connection factory is required.');
    return withWorkspaceMutationLock(original.binding.workspaceId, () => withNativePathClaimPhase(claim, original, mcp, open, async (database, access) => {
      const startedAt = performance.now();
      type Stage = 'admission-read' | 'active-census' | 'request-prepare' | 'reserve' | 'targets' | 'ready';
      let stage: Stage = 'admission-read', finishedCallback = false;
      const milestones: Array<Readonly<{ stage: Stage; elapsedMs: number }>> = [];
      const mark = (completed: Stage) => {
        if (milestones.length < 6) milestones.push({ stage: completed, elapsedMs: Math.round(performance.now() - startedAt) });
      };
      try {
        const existing = await readWorkspaceOperationNativePathAdmissionOnConnection(database, claim);
        mark('admission-read'); stage = 'active-census';
        const prefix = `"${original.binding.source.schemaName.replaceAll('"', '""')}"`;
        const active = await database.all(`SELECT DISTINCT CASE WHEN octet_length(r.request_id)=36 THEN r.request_id END AS request_id
        FROM ${prefix}.collaboration_admission_scopes s JOIN ${prefix}.collaboration_admission_requests r USING(request_id)
        WHERE s.workspace_id=$1 AND r.status NOT IN('committed','cancelled') LIMIT 3`, [original.binding.workspaceId]) as Row[];
        mark('active-census');
        if (active.length > 1 || active.some(row => !existing || row.request_id !== existing.request.requestId)) throw new WorkspaceFileLifecycleBusyError();
        if (existing?.outcome) {
          if (existing.outcome.version === 2) throw original.kind === 'move'
            ? new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_CHANGED') : new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_CHANGED');
          stage = 'ready'; mark('ready'); finishedCallback = true;
          return Object.freeze({ status: 'ready', requestId: existing.request.requestId });
        }
        if (existing && !['reserved', 'draining'].includes(existing.status)) {
          if (existing.status === 'cancelled') throw original.kind === 'move'
            ? new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_CHANGED') : new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_CHANGED');
          throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        }
        stage = 'request-prepare';
        const selected = existing ? { request: existing.request, requiresHeader: true, legacy: false }
          : await prepareNativePathRequest(database, original, 'prepare', access);
        mark('request-prepare');
        if (!selected) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
        if (selected.legacy) {
          stage = 'ready'; mark('ready'); finishedCallback = true;
          return Object.freeze({ status: 'ready', requestId: selected.request.requestId });
        }
        stage = 'reserve';
        let reserved: CollaborationAdmissionResult;
        try { reserved = await reserveCollaborationAdmissionOnConnection(database, selected.request); }
        catch (error) {
          if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT') throw new WorkspaceFileLifecycleBusyError();
          throw error;
        }
        mark('reserve');
        if (!['reserved', 'draining'].includes(reserved.status)) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
        stage = 'targets';
        const pending = await advanceNativePathTargets(database, original, selected.request, reserved, access);
        mark('targets'); stage = 'ready'; mark('ready'); finishedCallback = true;
        return Object.freeze({ status: pending ? 'pending' : 'ready', requestId: selected.request.requestId });
      } finally {
        // Fixed diagnostics only: callback completion is not a COMMIT claim.
        try { console.info('[Native path admission] Callback timings.', JSON.stringify({ version: 1, stage,
          elapsedMs: Math.round(performance.now() - startedAt), finishedCallback, milestones })); }
        catch { /* Preserve the original result or error. */ }
      }
    }));
  } catch (error) { return Promise.reject(error); }
}

/** Wait only between fully settled phases. No owner, SQL connection, room
 * guard or workspace mutation lock is retained while a real room drains.
 * A timeout leaves the original request available to explicit recovery. */
export async function waitForWorkspaceOperationNativePathAdmission(claim: WorkspaceOperationBatchClaim,
  openConnection: () => Promise<SqlConnection> = openDb, mcp?: WorkspaceOperationMcpJobPrincipal): Promise<void> {
  const original = nativePathBinding(claim);
  const documentIds = workspaceOperationSourceNativeEvidence(original.plan.sourceEvidence).nativeBindings.map(item => item.expected.documentId);
  const options = Object.freeze({ openConnection,
    ...(mcp === undefined ? {} : { mcpPrincipal: captureWorkspaceOperationMcpJobPrincipal(mcp) }) });
  const deadline = performance.now() + 10_000;
  let requestId: string | undefined;
  for (;;) {
    const result = await advanceWorkspaceOperationNativePathAdmission(claim, options);
    if (requestId !== undefined && result.requestId !== requestId) throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
    requestId = result.requestId;
    // The durable release precedes the server's final local room unload. A
    // proven PG snapshot cannot substitute for that final local retirement.
    if (result.status === 'ready' && documentIds.every(id => getCollaborationRoomConnectionCount(id) === 0)) return;
    if (performance.now() >= deadline) throw new WorkspaceFileLifecycleBusyError();
    await delay(50);
  }
}

async function withNativePathClaimPhase<T>(claim: WorkspaceOperationBatchClaim, original: NativePathBinding,
  mcp: WorkspaceOperationMcpJobPrincipal | undefined, openConnection: () => Promise<SqlConnection>,
  operation: (database: SqlConnection, access: WorkspaceOperationJobPolicyAccess) => Promise<T>): Promise<T> {
  // Fixed editor grammar only, scoped through confirmed disposal of this one
  // attempt. No document facts or current authorization are cached.
  return withNativeInspectionSchema(() => withWorkspaceOperationJobClaimPhase(claim, async () => {
    const policy = mcp ? undefined : await captureWorkspaceOperationJobPolicy();
    let executed = false, closed = false;
    try {
      return await executeLifecycleTransaction({
        openConnection: async () => {
          const actual = await openConnection();
          // Forward the same actual B. Only awaited disposal uncertainty is
          // classified here; no SQL result or authority is manufactured.
          return { get: (sql, values) => actual.get(sql, values), all: (sql, values) => actual.all(sql, values),
            run: (sql, values) => actual.run(sql, values), close: async error => {
              try { await actual.close(error); closed = true; }
              catch (cause) { throw Object.assign(new WorkspaceOperationBatchError('BATCH_CLAIM_DISPOSAL_UNCONFIRMED', 503,
                'Native path admission connection disposal is unconfirmed.'), { cause }); }
            } } satisfies SqlConnection;
        },
        execute: async database => {
          executed = true;
          await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
          await database.run("SET LOCAL statement_timeout='5s'"); await database.run("SET LOCAL lock_timeout='50ms'");
          const authorize = mcp
            ? (run: (access: WorkspaceOperationJobPolicyAccess) => Promise<T>) => withWorkspaceOperationMcpJobPolicyOnConnection(database, { claim, principal: mcp }, run)
            : (run: (access: WorkspaceOperationJobPolicyAccess) => Promise<T>) => withWorkspaceOperationJobPolicyOnConnection(database, { claim, policy: policy! }, run);
          return authorize(async access => {
            if (readWorkspaceOperationBatchClaimBinding(claim) !== original.binding || !workspaceOperationJobScopeMatches(original.scope, access.workspace)) {
              throw new WorkspaceOperationBatchError('BATCH_SCOPE_CHANGED', 409, 'The original native path workspace changed.');
            }
            try { await tryLockCollaborationAdmissionWorkspace(async (sql, values) => await database.all(sql, values) as Row[], original.binding.workspaceId); }
            catch (error) {
              if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT') throw new WorkspaceFileLifecycleBusyError();
              throw error;
            }
            const { schemaName, schemaOid, databaseOid } = original.binding.source;
            const source = Object.freeze({ schemaName, schemaOid, databaseOid });
            const storage = original.kind === 'move' ? await bindWorkspaceOperationOriginalMoveStorageOnConnection(database, source)
              : await bindWorkspaceOperationOriginalDeleteStorageOnConnection(database, source);
            const handoff = original.kind === 'move' ? null : await bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection(database, source);
            await access.assertCurrent(); const result = await operation(database, access);
            await access.assertCurrent(); await storage.assertCurrent(); await handoff?.assertCurrent();
            if (readWorkspaceOperationBatchClaimBinding(claim) !== original.binding || !workspaceOperationJobScopeMatches(original.scope, access.workspace)) {
              throw new WorkspaceOperationBatchError('BATCH_SCOPE_CHANGED', 409, 'The original native path workspace changed.');
            }
            return result;
          });
        },
        recoverCommitted: async (_value, cause) => { throw Object.assign(new WorkspaceOperationBatchError('BATCH_CLAIM_COMMIT_UNCONFIRMED', 503,
          'Native path admission COMMIT is unconfirmed.'), { cause }); },
      });
    } catch (error) {
      if (executed && closed && error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === '55P03') {
        // The lifecycle helper returned the original SQL error only after its
        // rollback and awaited close; never continue an aborted transaction.
        throw new WorkspaceFileLifecycleBusyError();
      }
      if (error instanceof AggregateError) throw Object.assign(new WorkspaceOperationBatchError('BATCH_CLAIM_DISPOSAL_UNCONFIRMED', 503,
        'Native path admission transaction cleanup is unconfirmed.'), { cause: error });
      throw error;
    }
  }));
}

async function prepareNativePathRequest(database: SqlConnection, original: NativePathBinding, mode: 'read' | 'prepare',
  access?: Pick<WorkspaceOperationJobPolicyAccess, 'workspace' | 'assertCurrent'>): Promise<NativePathRequest | null> {
  const { binding, plan, authorization: auth } = original, prefix = `"${binding.source.schemaName.replaceAll('"', '""')}"`;
  if (plan.version === 3) {
    const context = nativePathMoveContext(original);
    const row = await readWorkspaceOperationOriginalMoveIntentOnConnection(database, { schema: binding.source.schemaName, batchId: binding.batchId, readOnly: true });
    const intent = row ? parseWorkspaceOperationOriginalMoveIntent(row, context) : null;
    const prepared = plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4
      ? await readWorkspaceOperationOriginalMovePreparationOnConnection(database, { schema: binding.source.schemaName, context, readOnly: true }) : null;
    if ((plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4) && intent && !prepared) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    if (intent || prepared) {
      const request = intent ? createWorkspaceOperationOriginalMoveAdmissionRequest(context, intent) : prepared!.request;
      if (intent && prepared && (intent.version !== (plan.planIdentityVersion === 4 ? 4 : plan.planIdentityVersion === 3 ? 3 : 2) || !equal(intent.currentWitness, prepared.preparation.currentWitness)
        || !equal(intent.nativeBundle, prepared.nativeBundleData)
        || !equal(captureCollaborationAdmissionRequest(request), captureCollaborationAdmissionRequest(prepared.request)))) {
        throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
      }
      // A historical B1 intent without its old admission header must stay on
      // its original path. A new durable P0, in contrast, requires its header.
      return Object.freeze({ request, requiresHeader: prepared !== null, legacy: mode === 'prepare' && prepared === null });
    }
    if (plan.planIdentityVersion !== 2 && plan.planIdentityVersion !== 3 && plan.planIdentityVersion !== 4) return Object.freeze({ request: createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle(context, null), requiresHeader: false, legacy: true });
    if (mode === 'read') {
      const native = getWorkspaceOperationOriginalMoveNativeIds(context), fallback = createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle(context, null);
      const orphan = await database.get(`SELECT 1 AS present FROM ${prefix}.collaboration_admission_requests WHERE request_id=ANY($1::text[]) LIMIT 1`,
        [[native.requestId, fallback.requestId]]);
      if (orphan) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
      return null;
    }
  } else {
    const size = await database.get(`SELECT octet_length(intent_text) AS bytes FROM ${prefix}.workspace_file_operation_delete_intents WHERE batch_id=$1`, [binding.batchId]) as Row | undefined;
    if (size && (!Number.isSafeInteger(Number(size.bytes)) || Number(size.bytes) < 1 || Number(size.bytes) > 1048576)) {
      throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    }
    const row = size ? await readWorkspaceOperationOriginalDeleteIntentOnConnection(database, { schema: binding.source.schemaName, batchId: binding.batchId }) : null;
    if (row) {
      // Facts only. The real Delete Owner must additionally run parseIntent
      // with its actual current Workspace and DATA before any domain action.
      if (row.batchId !== binding.batchId || row.planId !== binding.planId || row.workspaceId !== binding.workspaceId
        || row.requestHash !== auth.requestHash || createHash('sha256').update(row.intentText).digest('hex') !== row.intentDigest) {
        throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
      }
      const body = JSON.parse(row.intentText) as Row;
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.batchId !== binding.batchId || body.planId !== binding.planId
        || body.requestHash !== auth.requestHash || !equal(body.jobScope, original.scope) || !equal(body.actor,
          { userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: auth.actorSessionId ?? null })) {
        throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
      }
      const request = createWorkspaceOperationOriginalDeleteAdmissionRequest(binding);
      if (plan.version === 5 ? body.version !== 7 : plan.planIdentityVersion === 4 ? body.version !== 6 : plan.planIdentityVersion === 3 ? body.version !== 5 : body.version === 5 || body.version === 6 || body.version === 7) {
        throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
      }
      if (body.version === 4 || body.version === 5 || body.version === 6 || body.version === 7) {
        const reference = captureOriginalDeleteAdmissionBinding(body.admission), captured = captureCollaborationAdmissionRequest(request);
        if (reference.requestId !== captured.request.requestId || reference.requestDigest !== captured.requestDigest) throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
        return Object.freeze({ request, requiresHeader: true, legacy: false });
      }
      if (![1, 2, 3].includes(body.version as number)) throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
      return Object.freeze({ request, requiresHeader: false, legacy: mode === 'prepare' });
    }
    const legacy = plan.version !== 5 && plan.planIdentityVersion !== 2 && plan.planIdentityVersion !== 3 && plan.planIdentityVersion !== 4;
    if (mode === 'read' || legacy) return Object.freeze({ request: createWorkspaceOperationOriginalDeleteAdmissionRequest(binding), requiresHeader: false, legacy });
  }
  if (!access || mode !== 'prepare' || !workspaceOperationJobScopeMatches(original.scope, access.workspace)) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  // Existing rooms persist without taking workspace admission on each save.
  // Pin every actual native target row before census so the final P0 witness
  // and reserve.captureTargets cannot see different clocks inside this RC B.
  const expected = new Map(workspaceOperationSourceNativeEvidence(plan.sourceEvidence).nativeBindings.map(item => [item.expected.documentId, item.expected]));
  const actual = await database.all(`SELECT CASE WHEN octet_length(s.document_id) BETWEEN 1 AND 256
      AND (s.organization_id IS NULL OR octet_length(s.organization_id) BETWEEN 1 AND 256) THEN s.document_id END AS document_id,
    CASE WHEN octet_length(s.workspace_id) BETWEEN 1 AND 256 THEN s.workspace_id END AS workspace_id,
    CASE WHEN octet_length(s.organization_id) BETWEEN 1 AND 256 THEN s.organization_id END AS organization_id,
    CASE WHEN octet_length(s.path) BETWEEN 1 AND 4096 THEN s.path END AS path,
    CASE WHEN octet_length(s.representation) BETWEEN 1 AND 32 THEN s.representation END AS representation,
    s.lifecycle_generation,s.schema_version,s.status FROM ${prefix}.collaboration_yjs_states s
    WHERE s.workspace_id=$1 AND s.status='active' ORDER BY s.document_id COLLATE "C" LIMIT 1025 FOR UPDATE NOWAIT`, [binding.workspaceId]) as Row[];
  if (actual.length !== expected.size || new Set(actual.map(row => row.document_id)).size !== actual.length || actual.some(row => {
    const selected = expected.get(row.document_id as string);
    return !selected || row.document_id !== selected.documentId || row.workspace_id !== selected.workspaceId || row.organization_id !== selected.organizationId
      || row.path !== selected.path || row.representation !== selected.representation || Number(row.lifecycle_generation) !== selected.lifecycleGeneration
      || Number(row.schema_version) !== selected.schemaVersion || row.status !== 'active';
  })) throw original.kind === 'move' ? new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_CHANGED')
    : new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_CHANGED');
  await access.assertCurrent(); const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace,
    { physicalParserVersion: deriveWorkspacePathPhysicalParserVersion(plan.sourceEvidence) });
  await access.assertCurrent();
  if (plan.version === 5) {
    assertWorkspaceOperationPhysicalDeleteCurrentV5(plan,observation,original.scope);
    return Object.freeze({request:createWorkspaceOperationOriginalDeleteAdmissionRequest(binding),requiresHeader:true,legacy:false});
  }
  if (plan.version === 2) {
    assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, observation, original.scope);
    return Object.freeze({ request: createWorkspaceOperationOriginalDeleteAdmissionRequest(binding), requiresHeader: true, legacy: false });
  }
  if (plan.planIdentityVersion !== 2 && plan.planIdentityVersion !== 3 && plan.planIdentityVersion !== 4) throw new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_CHANGED');
  const context = nativePathMoveContext(original), currentWitness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, observation, original.scope);
  const nativeBundleData = prepareWorkspaceOperationOriginalMoveNativeBundleData(context, observation, currentWitness);
  const prepared = createWorkspaceOperationOriginalMovePreparation(context, { currentWitness, nativeBundleData });
  const inserted = await insertWorkspaceOperationOriginalMovePreparationOnConnection(database, { schema: binding.source.schemaName, context, prepared });
  if (inserted.kind === 'conflict') throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  const bundle = decodeWorkspaceOperationOriginalMoveNativeBundleData(prepared.nativeBundleData, context, currentWitness);
  if (bundle) {
    const bytes = decodeNativeFileOperationBundleText(prepared.nativeBundleData!.privateText);
    if (bytes.privateText !== prepared.nativeBundleData!.privateText || bytes.changesBundleProof !== prepared.nativeBundleData!.changesBundleProof
      || bytes.actionPayloadText !== prepared.nativeBundleData!.actionPayloadText) throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
    const staged = await stageNativeFileOperationBundleOnConnection(database, bundle);
    // The genuine stage helper checks the exact persisted privateText itself;
    // its public return deliberately contains only the proof and payload.
    if (staged.changesBundleProof !== bytes.changesBundleProof || staged.actionPayloadText !== bytes.actionPayloadText) {
      throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
    }
  }
  await access.assertCurrent();
  return Object.freeze({ request: prepared.request, requiresHeader: true, legacy: false });
}

async function advanceNativePathTargets(database: SqlConnection, original: NativePathBinding, request: CollaborationAdmissionRequest,
  reserved: CollaborationAdmissionResult, access: WorkspaceOperationJobPolicyAccess): Promise<boolean> {
  const startedAt = performance.now(), total = request.expectedDocuments.length;
  let stage: 'rows' | 'target-check' | 'drain' | 'prove' | 'current-check' | 'done' = 'rows';
  let completed = 0, ordinal: number | null = null, finishedTargets = false;
  try {
    const prefix = `"${original.binding.source.schemaName.replaceAll('"', '""')}"`;
    const rows = await database.all(`SELECT document_id,status,active FROM ${prefix}.collaboration_admission_targets
    WHERE request_id=$1 ORDER BY document_id COLLATE "C" LIMIT $2 FOR UPDATE`, [request.requestId, request.expectedDocuments.length + 1]) as Row[];
    const byId = new Map(rows.map(row => [row.document_id, row]));
    if (rows.length !== request.expectedDocuments.length || reserved.targets.length !== request.expectedDocuments.length
      || byId.size !== rows.length || rows.some(row => row.active !== true
        || !['reserved', 'draining', 'released'].includes(row.status as string))
      || request.expectedDocuments.some(document => !byId.has(document.documentId))) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
    // Human durable-job policy holds its actual auth/ACL tables in SHARE and
    // the claim row in SHARE through this transaction. DA03 has only atomic
    // SQL effects: its complete target set may share a current-policy fence.
    // MCP and Agent runtime revocation retain their per-target checks. Every
    // target still gets its own genuine room/header/state/hash proof below.
    const atomicHumanPolicy = original.authorization.mode === 'direct' && original.authorization.actorType === 'user';
    if (atomicHumanPolicy) await access.assertCurrent();
    let pending = false;
    for (const document of request.expectedDocuments) {
      ordinal = completed; stage = 'target-check';
      const target = reserved.targets.find(item => item.document.documentId === document.documentId);
      if (!target || !equal(target.document, document)) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
      if (target.ownerToken !== null && byId.get(document.documentId)!.status !== 'released') {
        stage = 'drain';
        await startCollaborationAdmissionDrainOnConnection(database, request, document.documentId);
      }
      stage = 'prove';
      try { await proveCollaborationAdmissionQuiescenceOnConnection(database, request, document.documentId, { lockTimeout: '50ms' }); }
      catch (error) {
        // pg_try_advisory_xact_lock returns false without aborting B. Only that
        // genuine room contention is pending; SQL errors must roll back outside.
        if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT') pending = true;
        else throw error;
      }
      if (!atomicHumanPolicy) {
        stage = 'current-check';
        await access.assertCurrent();
      }
      completed++;
    }
    // An error here rolls back every provisional DA03 update. The enclosing
    // principal and storage checks are also awaited before COMMIT.
    if (atomicHumanPolicy) { stage = 'current-check'; await access.assertCurrent(); }
    stage = 'done'; finishedTargets = true;
    return pending;
  } finally {
    // Ordinal is zero-based; no document identity or request bytes are logged.
    try { console.info('[Native path admission] Target timings.', JSON.stringify({ version: 1, stage,
      elapsedMs: Math.round(performance.now() - startedAt), total, completed, ordinal, finishedTargets })); }
    catch { /* Preserve the original result or error. */ }
  }
}


export async function prepareWorkspaceImplicitMoveAdmissionOnConnection(database: SqlConnection,
  handle: import('./workspace-implicit-move-phase').WorkspaceImplicitMovePreparationHandle
): Promise<import('./workspace-implicit-move-phase').WorkspaceImplicitMoveAdmissionPreparation> {
  const startedAt = performance.now(), milestones: Array<Readonly<{ stage: string; elapsedMs: number }>> = [];
  const mark = (stage: string) => { milestones.push({ stage, elapsedMs: Math.round(performance.now() - startedAt) }); };
  try {
    const { assertWorkspaceImplicitMovePreparationOnConnection } = await import('./workspace-implicit-move-phase');
    const { getWorkspaceImplicitMoveSelectionBatchIdentity } = await import('./workspace-implicit-move-selection');
    const frame = await assertWorkspaceImplicitMovePreparationOnConnection(database, handle);
    if (!frame.operation) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    const original = captureNativePathBindingFacts(frame.operation.binding), selected = getWorkspaceImplicitMoveSelectionBatchIdentity(frame.selection);
    if (original.kind !== 'move' || original.plan.version !== 3 || original.plan.planIdentityVersion !== 4
      || original.authorization.mode !== 'direct' || original.authorization.actorType !== 'user'
      || original.authorization.actorId !== frame.access.userId || original.authorization.actorUserId !== frame.access.userId
      || original.authorization.actorSessionId !== undefined || original.authorization.requestHash !== selected.requestHash
      || original.binding.batchId !== selected.batchId || !equal(original.plan, frame.nativePlan)
      || !equal(original.scope, frame.selection.scope) || !workspaceOperationJobScopeMatches(original.scope, frame.access.workspace)
      || original.binding.source.schemaName !== frame.identity.schemaName
      || original.binding.source.schemaOid !== frame.identity.schemaOid
      || original.binding.source.databaseOid !== frame.identity.databaseOid
      || original.binding.source.searchPath !== frame.identity.searchPath) throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
    const source = Object.freeze({ schemaName: frame.identity.schemaName, schemaOid: frame.identity.schemaOid,
      databaseOid: frame.identity.databaseOid });
    mark('binding-captured');
    const storage = await bindWorkspaceOperationOriginalMoveStorageOnConnection(database, source);
    mark('storage-bound');
    const prepared = await prepareNativePathRequest(database, original, 'prepare', frame.access);
    mark('native-request-prepared');
    if (!prepared || prepared.legacy || !prepared.requiresHeader) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
    await storage.assertCurrent();
    const context = nativePathMoveContext(original);
    const saved = await readWorkspaceOperationOriginalMovePreparationOnConnection(database,
      { schema: source.schemaName, context, readOnly: true });
    mark('preparation-read');
    if (!saved || saved.preparation.version !== 3
      || !equal(captureCollaborationAdmissionRequest(saved.request), captureCollaborationAdmissionRequest(prepared.request))) {
      throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
    }
    if (!equal(await assertWorkspaceImplicitMovePreparationOnConnection(database, handle), frame)) {
      throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
    }
    return Object.freeze({ request: captureCollaborationAdmissionRequest(saved.request).request,
      preparationDigest: saved.preparationDigest });
  } finally {
    try { console.info('[File action preparation] Admission phase timings.', JSON.stringify({
      version: 1, elapsedMs: Math.round(performance.now() - startedAt), milestones })); }
    catch { /* Preserve the original operation result. */ }
  }
}
