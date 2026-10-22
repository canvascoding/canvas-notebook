import 'server-only';
import { decodeWorkspaceOperationCohortDeletePlan, captureWorkspaceOperationCohortDeleteCurrent,
  WorkspaceOperationCohortDeleteError, failCohortDelete } from './workspace-operation-cohort-delete-plan';
import { parseCohortDeleteIntent, type CohortDeleteIntent, type CohortDeleteResult } from './workspace-operation-cohort-delete-evidence';
import { completeCohortDeleteDomain, readCohortDeleteObservationOnConnection, prepareCohortDeleteIntent, assertCohortDeletePending,
  type CohortDeleteObservation, type CohortDeletePrepared, type CohortDeletePhysical } from './workspace-operation-cohort-delete-domain';
import { readCohortDeleteAdmissionOnConnection, cohortDeleteAdmissionResult } from './workspace-operation-cohort-delete-admission';
import { readPreparedWorkspacePathTrash, readPreparedWorkspacePathTrashReceipt,
  assertPreparedWorkspacePathTrashCurrent, assertPreparedWorkspacePathTrashSourceVacant } from '../filesystem/prepared-workspace-path-trash';

import { decodeWorkspaceOperationDeleteBatchPlan, getWorkspaceOperationDeleteLinkRecipes } from './workspace-operation-delete-plan-dispatch';
import { captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5, WorkspaceOperationPhysicalDeleteHtmlPlanError } from './workspace-operation-physical-delete-html-plan-v5';
import { assertOriginalPhysicalDeleteLinkPlanV5 } from './workspace-operation-original-physical-delete-links-v5';

import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { getWorkspaceFileLifecycleLeases, withWorkspaceFileLifecycleLeases, type WorkspaceFileLifecycleLease } from '../collaboration/file-lifecycle-admission-context';
import { hasCollaborationHandoffExecutionContext } from '../collaboration/handoff-execution-context';
import { captureCollaborationAdmissionRequest, type CollaborationAdmissionRequest, collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import { workspaceAbsoluteRoot } from '../workspaces/contracts';
import { captureWorkspaceOperationJobPolicy, withWorkspaceOperationJobPolicyOnConnection,
  type WorkspaceOperationJobPolicyAccess } from '../workspaces/workspace-operation-job-principal';
import { captureWorkspaceOperationMcpJobPrincipal, assertWorkspaceOperationMcpJobPrincipalCaptured, withWorkspaceOperationMcpJobPolicyOnConnection,
  type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import { readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim,
  type WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import { withWorkspaceFileLifecycleGuard } from './workspace-file-lifecycle-guard';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { bindWorkspaceOperationOriginalDeleteStorageOnConnection } from './workspace-operation-original-delete-storage';
import { withWorkspaceOperationJobClaimPhase } from './workspace-operation-job-phase-scheduling';
import { lockFileCollaborationPaths } from './collaboration-repository';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection, insertWorkspaceOperationOriginalDeleteIntentOnConnection,
  type WorkspaceOperationOriginalDeleteIntent } from './workspace-operation-original-delete-repository';
import { readWorkspaceOperationNativePathAdmissionOnConnection } from './workspace-operation-native-path-admission';
import { readWorkspaceOperationOriginalMovePreparationOnConnection } from './workspace-operation-original-move-preparation';
import { parseIntent, assertOriginalDeleteIntentPlan, type WorkspaceOperationOriginalDeleteResult } from './workspace-operation-original-delete-evidence';
import { readWorkspaceOperationOriginalDeleteObservationOnConnection } from './workspace-operation-original-delete-observation';
import { archiveOriginalNativeDeleteTargetOnConnection } from './workspace-operation-original-delete-native';
import type { NativeFileArchiveTransition } from '../collaboration/native-file-archive-transition';
import { withNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { completeWorkspaceOperationOriginalDeleteDomain } from './workspace-operation-original-delete-domain';
import { readWorkspaceOperationOriginalDeleteAdmissionOnConnection,
  workspaceOperationOriginalDeleteAdmissionResult } from './workspace-operation-original-delete-admission';
import { readPreparedWorkspaceSingleFileTrash, assertPreparedWorkspaceSingleFileTrashCurrent,
  type PreparedWorkspaceSingleFileTrash, type PreparedSingleFileTrashReceipt } from '../filesystem/prepared-single-file-trash';
import { applyOriginalDeleteNativeHtmlLinksV4 } from './workspace-operation-original-delete-html-links';
import { applyOriginalDeleteNativeLinks, assertOriginalDeleteNativeLinkPlan,
  type AnyOriginalDeleteNativeLinkReceipt } from './workspace-operation-original-delete-links';
import { readWorkspaceLinkSourceAuthorityOnConnection,
  type WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { reportWorkspaceOperationFailureDiagnostics } from './workspace-operation-failure-diagnostics';
import { lockIdentity } from '../collaboration/room-owner';
import { getCollaborationRoomConnectionCount } from '../collaboration/runtime-state';
import { reserveCollaborationAdmissionOnConnection } from '../collaboration/room-admission';
import { proveCollaborationAdmissionQuiescenceOnConnection } from '../collaboration/room-admission-quiescence';
import { executeCollaborationAdmissionHandoffOnConnection } from '../collaboration/room-admission-handoff';
import { readHistoricalCollaborationAdmissionOutcomeOnConnection } from '../collaboration/room-admission-outcome';
import { createWorkspaceOperationOriginalMoveAdmissionRequest } from './workspace-operation-original-move-admission';
import { decodeWorkspaceOperationNativeMoveBatchPlan, assertWorkspaceOperationNativeMoveBatchPlanCurrent,
  captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness, WorkspaceOperationNativeMovePlanError } from './workspace-operation-native-move-plan';
import { captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness,
  WorkspaceOperationNativeDeletePlanError } from './workspace-operation-native-delete-plan';
import { WorkspaceOperationNativeSourceEvidenceError } from './workspace-operation-native-source-evidence';
import { workspaceOperationSourceNativeEvidence, type WorkspaceOperationAnyMixedSourceEvidence } from './workspace-operation-mixed-source-evidence';
import { deriveWorkspacePathPhysicalParserVersion } from './workspace-operation-path-source-parser';
import { bindWorkspaceOperationOriginalMoveStorageOnConnection } from './workspace-operation-original-move-storage';
import { bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection } from './workspace-operation-original-move-handoff-storage';
import { notifyWorkspaceFileInvalidationOnConnection } from '../filesystem/workspace-file-invalidation';
import { captureWorkspaceOperationOriginalMoveContext, createWorkspaceOperationOriginalMoveIntent, parseWorkspaceOperationOriginalMoveIntent,
  decodeWorkspaceOperationOriginalMoveParentReceipt, decodeWorkspaceOperationOriginalMovePathReceipt,
  decodeWorkspaceOperationOriginalMoveCompletion, serializeWorkspaceOperationOriginalMoveData,
  readWorkspaceOperationOriginalMoveNativeBundle, WorkspaceOperationOriginalMoveCodecError, type WorkspaceOperationOriginalMoveContext,
  type WorkspaceOperationOriginalMoveIntentData, type WorkspaceOperationOriginalMoveNativeBundleData,
  type WorkspaceOperationOriginalMoveCompletionData } from './workspace-operation-original-move';
import { readWorkspaceOperationOriginalMoveIntentOnConnection, insertWorkspaceOperationOriginalMoveIntentOnConnection,
  listWorkspaceOperationOriginalMoveParentReceiptsOnConnection, listWorkspaceOperationOriginalMovePathReceiptsOnConnection,
  readWorkspaceOperationOriginalMoveReceiptOnConnection, insertWorkspaceOperationOriginalMoveReceiptOnConnection,
  insertWorkspaceOperationOriginalMoveParentReceiptOnConnection, insertWorkspaceOperationOriginalMovePathReceiptOnConnection,
  type WorkspaceOperationOriginalMoveIntent, type WorkspaceOperationOriginalMoveParentReceipt,
  type WorkspaceOperationOriginalMovePathReceipt, type WorkspaceOperationOriginalMoveReceipt } from './workspace-operation-original-move-repository';
import { readPreparedWorkspacePathMove, assertPreparedWorkspacePathMoveCurrent,
  assertPreparedWorkspacePathMoveReceiptCurrent, assertPreparedWorkspacePathMoveParentReceipt, preparedWorkspacePathMoveProof,
  type PreparedWorkspacePathMove, type PreparedWorkspacePathMoveReceipt,
  type PreparedWorkspacePathMoveParentReceipt } from '../filesystem/prepared-workspace-path-move';
import { stageNativeFileOperationBundleOnConnection, readStagedNativeFileOperationBindingOnConnection,
  applyNativeFileOperationMutationOnConnection, nativeFileOperationReceiptSetProofOnConnection, readHistoricalNativeFileOperationReceiptOnConnection }
  from '../markdown/native-file-operation-handoff';
import { prepareWorkspaceOperationOriginalMoveNativeBundleData } from './workspace-operation-original-move';
import { captureNativeFileOperationSideEffectsOnConnection, applyNativeFileOperationSideEffectsOnConnection,
  readHistoricalNativeFileOperationSideEffectsOnConnection } from '../markdown/native-file-operation-side-effects';


declare const ownerBrand: unique symbol;
export type WorkspaceOperationJobLifecycleOwner = Readonly<{ [ownerBrand]: true }>;
export type WorkspaceOperationJobLifecycleAccess = Readonly<WorkspaceOperationJobPolicyAccess & {
  database: SqlConnection;
  /** Fixed claimed journal operation; never accepts SQL, prepared bytes or callbacks. */
  applyOriginalNativeDeleteLinks: (expectedIntentDigest: string) => Promise<AnyOriginalDeleteNativeLinkReceipt[]>;
  /** Fixed E6/Plan4 journal target only; no caller-selected D1, workspace or raw B. */
  archiveOriginalNativeHtmlDeleteTarget: (expectedIntentDigest: string) => Promise<NativeFileArchiveTransition>;
  archiveOriginalNativeCohortDeleteTargets?: (expectedIntentDigest:string) => Promise<readonly Readonly<{path:string;transition:NativeFileArchiveTransition}>[]>;
  readOriginalNativeDeleteSources: () => Promise<WorkspaceLinkSourceAuthorityObservation>;
  readOriginalNativeDeleteAdmission: () => Promise<Readonly<{ requestId: string; requestDigest: string }>>;
}>;
type Identity = Readonly<{ backend: number; start: string; database: number; schema: number; searchPath: string }>;
type Directory = { named: string; real: string; handle: FileHandle; stat: Stats };
type MoveIntentReadFacts = Readonly<{ database: SqlConnection; context: WorkspaceOperationOriginalMoveContext;
  transaction: string; row: WorkspaceOperationOriginalMoveIntent; intent: WorkspaceOperationOriginalMoveIntentData }>;
type Phase = { active: boolean; accepting: boolean; transaction: string; pending: Set<Promise<unknown>>;
  moveIntentReadFacts?: MoveIntentReadFacts;
  index: number; startedAt: number | null; startedMonotonic: number; queriesBefore: number;
  stage: 'preparation' | 'begin' | 'identity' | 'policy' | 'storage' | 'path-locks' | 'operation'
    | 'before-operation-check' | 'sql' | 'after-operation-check' | 'link-authority' | 'final-check' | 'commit' | 'after-commit';
  operation: 'authority' | 'native-source-read' | 'native-link-write' | 'native-archive-write' | 'read' | 'write';
  relation: string | null };
type MovePrepared = Readonly<{ stepKey: string; cap: PreparedWorkspacePathMove; receipt?: PreparedWorkspacePathMoveReceipt }>;
type MoveCapture = { context: WorkspaceOperationOriginalMoveContext; preparedSteps: readonly MovePrepared[]; guards: readonly string[];
  nativePhase?: Phase; nativeReceipts?: readonly import('../markdown/native-file-operation-handoff').NativeFileOperationReceipt[];
  namespaceReceipt?: WorkspaceOperationOriginalMoveCompletionData['namespaceEffects'] };
type Capture = {
  move?: MoveCapture;
  nativePaths?: Readonly<{ guards: readonly string[]; documentIds: readonly string[] }>;
  mcp?: WorkspaceOperationMcpJobPrincipal;
  owner: WorkspaceOperationJobLifecycleOwner; claim: WorkspaceOperationBatchClaim; binding: WorkspaceOperationBatchClaimBinding;
  sourcePath: string; active: boolean; accepting: boolean; disposed: boolean; failure?: Error; disposalFailure?: Error;
  database?: SqlConnection; identity?: Identity; lease?: WorkspaceFileLifecycleLease;
  directories: Directory[]; phase?: Phase; pending: Set<Promise<unknown>>;
  phaseCount: number; forwardedQueries: number;
};
const owners = new WeakMap<WorkspaceOperationJobLifecycleOwner, Capture>();
const context = new AsyncLocalStorage<Capture>();
const phaseContext = new AsyncLocalStorage<Phase>();
const asError = (error: unknown) => error instanceof Error ? error : new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_INVALID');

export class WorkspaceOperationJobLifecycleError extends Error {
  readonly status: number;
  constructor(readonly code: 'JOB_LIFECYCLE_REQUIRED' | 'JOB_LIFECYCLE_INVALID' | 'JOB_LIFECYCLE_REENTRANT'
    | 'JOB_LIFECYCLE_CHANGED' | 'JOB_LIFECYCLE_DETACHED' | 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED'
    | 'JOB_LIFECYCLE_DISPOSAL_UNCONFIRMED', options?: ErrorOptions) {
    super(code, options); this.name = 'WorkspaceOperationJobLifecycleError';
    this.status = code.endsWith('UNCONFIRMED') ? 503 : 409;
  }
}
function fail(code: WorkspaceOperationJobLifecycleError['code']): never { throw new WorkspaceOperationJobLifecycleError(code); }
/** Capture only the actual live handle. This wrapper never enters stored intent data. */
function captureMcpJobPrincipal(binding: WorkspaceOperationBatchClaimBinding,
  input: WorkspaceOperationMcpJobPrincipal | undefined, move: boolean): WorkspaceOperationMcpJobPrincipal | undefined {
  if (binding.authorization.mode !== 'direct-mcp') {
    if (input !== undefined) fail('JOB_LIFECYCLE_INVALID');
    return undefined;
  }
  if (binding.actionMode !== 'apply' || (move ? binding.plan.version !== 3 : binding.plan.version !== 2 && binding.plan.version !== 5 && binding.plan.version !== 6)) fail('JOB_LIFECYCLE_INVALID');
  const captured = captureWorkspaceOperationMcpJobPrincipal(input);
  if (captured.kind !== (move ? 'move' : 'delete')) fail('JOB_LIFECYCLE_INVALID');
  assertWorkspaceOperationMcpJobPrincipalCaptured(captured, binding);
  return captured;
}
function poison(captured: Capture, error: unknown): never {
  const failure = asError(error); captured.failure ??= failure;
  const current = context.getStore(); if (current && current !== captured) current.failure ??= failure;
  throw failure;
}
function current(captured: Capture): SqlConnection {
  if (captured.failure) throw captured.failure;
  if (owners.get(captured.owner) !== captured || context.getStore() !== captured || !captured.active || captured.disposed
    || !captured.database || !captured.lease?.active
    || getWorkspaceFileLifecycleLeases()?.get(captured.binding.workspaceId) !== captured.lease
    || readWorkspaceOperationBatchClaimBinding(captured.claim) !== captured.binding) fail('JOB_LIFECYCLE_REQUIRED');
  return captured.database;
}
async function captureDirectory(named: string): Promise<Directory> {
  const stat = await fs.lstat(named);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('JOB_LIFECYCLE_CHANGED');
  const real = await fs.realpath(named), handle = await fs.open(named, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isDirectory() || held.dev !== stat.dev || held.ino !== stat.ino || held.uid !== stat.uid || held.mode !== stat.mode) fail('JOB_LIFECYCLE_CHANGED');
    return { named, real, handle, stat };
  } catch (error) { await handle.close(); throw error; }
}
async function checkDirectories(captured: Capture): Promise<void> {
  for (const directory of captured.directories) {
    const held = await directory.handle.stat(), named = await fs.lstat(directory.named);
    if (!named.isDirectory() || named.isSymbolicLink() || !held.isDirectory()
      || held.dev !== directory.stat.dev || held.ino !== directory.stat.ino || held.uid !== directory.stat.uid || held.mode !== directory.stat.mode
      || named.dev !== held.dev || named.ino !== held.ino || named.uid !== held.uid || named.mode !== held.mode
      || await fs.realpath(directory.named) !== directory.real) fail('JOB_LIFECYCLE_CHANGED');
  }
}
async function identity(database: SqlConnection, assign: boolean, fence?: Capture): Promise<{
  identity: Identity; transaction: string | null; workspaceHeld?: boolean; roomCount?: number;
}> {
  const key = fence ? BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(fence.binding.workspaceId))) : null;
  const guards = fence?.nativePaths?.guards.map(guard => BigInt.asUintN(64, BigInt(guard)).toString()) ?? [];
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema,
    pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication,
    ${assign ? 'pg_catalog.pg_current_xact_id()' : 'pg_catalog.pg_current_xact_id_if_assigned()'}::text AS transaction
    ${fence ? `, EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=a.pid
      AND l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=$1::oid
      AND l.classid::bigint=$2 AND l.objid::bigint=$3) AS workspace_held,
      (SELECT count(*)::integer FROM pg_catalog.pg_locks l WHERE l.pid=a.pid
        AND l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=$1::oid
        AND (l.classid::bigint::numeric*4294967296+l.objid::bigint::numeric)=ANY($4::numeric[])) AS room_count` : ''}
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`, fence
  ? [fence.binding.source.databaseOid, Number(key! >> BigInt(32)), Number(key! & BigInt('0xffffffff')), guards]
  : undefined) as Record<string, unknown> | undefined;
  if (!row || !Number.isSafeInteger(row.backend) || Number(row.backend) < 1 || typeof row.start !== 'string'
    || !/^[0-9]+\.[0-9]+$/u.test(row.start) || !Number.isSafeInteger(Number(row.database)) || Number(row.database) < 1
    || !Number.isSafeInteger(Number(row.schema)) || Number(row.schema) < 1 || typeof row.search_path !== 'string'
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin'
    || row.transaction !== null && (typeof row.transaction !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction))) fail('JOB_LIFECYCLE_CHANGED');
  if (fence && (typeof row.workspace_held !== 'boolean' || !Number.isSafeInteger(row.room_count) || Number(row.room_count) < 0)) fail('JOB_LIFECYCLE_CHANGED');
  return { identity: Object.freeze({ backend: Number(row.backend), start: row.start, database: Number(row.database),
    schema: Number(row.schema), searchPath: row.search_path }), transaction: row.transaction as string | null,
  ...(fence ? { workspaceHeld: row.workspace_held as boolean, roomCount: row.room_count as number } : {}) };
}
const sameIdentity = (left: Identity, right: Identity) => Object.keys(left).every(key => Reflect.get(left, key) === Reflect.get(right, key));
async function checkOwner(captured: Capture, transaction?: string): Promise<void> {
  const database = current(captured); await checkDirectories(captured); current(captured);
  const now = await identity(database, transaction !== undefined, captured), before = captured.identity!, source = captured.binding.source;
  current(captured);
  if (!sameIdentity(before, now.identity) || now.identity.database !== source.databaseOid || now.identity.schema !== source.schemaOid
    || now.identity.searchPath !== source.searchPath || (transaction === undefined ? now.transaction !== null : now.transaction !== transaction)) fail('JOB_LIFECYCLE_CHANGED');
  if (captured.nativePaths) {
    // This lease is created only by the private native guard on this same B.
    // The just-read identity includes all its actual session locks. Check the
    // live capability synchronously, without a second identical SQL snapshot
    // or any await between the observation and the remaining local checks.
    if (now.workspaceHeld !== true || !captured.lease?.active) {
      if (captured.lease) captured.lease.active = false;
      fail('JOB_LIFECYCLE_CHANGED');
    }
    checkMoveGuards(captured, now.roomCount);
  } else if (now.workspaceHeld !== true || !await captured.lease!.verify()) fail('JOB_LIFECYCLE_CHANGED');
  current(captured);
}
async function checkIdle(captured: Capture): Promise<void> {
  const database = current(captured), first = await identity(database, true), second = await identity(database, false);
  if (!sameIdentity(captured.identity!, first.identity) || !sameIdentity(first.identity, second.identity) || second.transaction !== null) fail('JOB_LIFECYCLE_CHANGED');
  await checkOwner(captured);
}
function checkPhase(captured: Capture, phase: Phase): void {
  current(captured);
  if (captured.phase !== phase || !phase.active || !phase.accepting || phaseContext.getStore() !== phase) fail('JOB_LIFECYCLE_REQUIRED');
}

/** Original direct Delete Apply/Undo. This exposes no raw owner connection. */
async function withLifecycleOwner<T>(claim: WorkspaceOperationBatchClaim,
  operation: (owner: WorkspaceOperationJobLifecycleOwner) => Promise<T>,
  openConnection: () => Promise<SqlConnection>, move = false, mcp?: WorkspaceOperationMcpJobPrincipal): Promise<T> {
  const inherited = context.getStore();
  if (inherited) poison(inherited, new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REENTRANT'));
  const binding = readWorkspaceOperationBatchClaimBinding(claim), authorization = binding.authorization;
  const plan = binding.plan, step = plan.pathSteps[0], jobScope = authorization.mode === 'direct' || authorization.mode === 'direct-mcp' ? authorization.jobScope : undefined;
  if (authorization.mode !== 'direct' && authorization.mode !== 'direct-mcp' || !(move ? binding.actionMode === 'apply' : ['apply','undo'].includes(binding.actionMode)) || !jobScope || jobScope.legacy
    || binding.workspaceId !== jobScope.workspaceId || plan.workspaceId !== binding.workspaceId || plan.planId !== binding.planId
    || plan.readiness !== 'ready' || (move ? plan.version !== 3 || !plan.pathSteps.length : (plan.version===6 ? !plan.pathSteps.length : plan.pathSteps.length !== 1) || step?.kind !== 'delete' || step.destinationPath != null)
    || !isCanonicalAdmissionPath(step?.sourcePath) || typeof operation !== 'function' || typeof jobScope.rootRelativePath !== 'string'
    || workspaceAbsoluteRoot(jobScope.rootRelativePath) !== jobScope.rootPath) fail('JOB_LIFECYCLE_INVALID');
  const mcpPrincipal = captureMcpJobPrincipal(binding, mcp, move);
  const rootRelativePath = jobScope.rootRelativePath;
  if (getWorkspaceFileLifecycleLeases()?.has(binding.workspaceId) || hasCollaborationHandoffExecutionContext()) fail('JOB_LIFECYCLE_REENTRANT');
  return withWorkspaceMutationLock(binding.workspaceId, async () => {
    const owner = Object.freeze(Object.create(null)) as WorkspaceOperationJobLifecycleOwner;
    const captured: Capture = { owner, claim, binding, mcp: mcpPrincipal, sourcePath: step.sourcePath, active: false, accepting: true,
      disposed: false, directories: [], pending: new Set(), phaseCount: 0, forwardedQueries: 0 };
    if (move) captured.move = captureMove(binding);
    const nativePlan = captured.move?.context.plan ?? (binding.actionMode === 'apply' && (plan.version === 2 || plan.version === 5 || plan.version === 6)
      ? decodeWorkspaceOperationDeleteBatchPlan(plan) : null);
    if (nativePlan) {
      const nativeBindings = workspaceOperationSourceNativeEvidence(nativePlan.sourceEvidence).nativeBindings;
      if (!equal(nativePlan.sourceEvidence.workspaceScope, jobScope) || nativeBindings.length > 1024) fail('JOB_LIFECYCLE_INVALID');
      const documentIds = nativeBindings.map(item => item.expected.documentId);
      const guards = captured.move?.guards ?? documentIds.map(documentId => lockIdentity(documentId).key)
        .sort((a,b) => BigInt(a)<BigInt(b)?-1:1);
      if (new Set(documentIds).size !== documentIds.length || new Set(guards).size !== guards.length
        || guards.includes(collaborationAdmissionLockKey(binding.workspaceId))) fail('JOB_LIFECYCLE_INVALID');
      captured.nativePaths = Object.freeze({ guards: Object.freeze(guards), documentIds: Object.freeze(documentIds) });
    }
    owners.set(owner, captured);
    let value: T | undefined, failure: Error | undefined;
    try {
      const data = await captureDirectory(resolveWorkspaceDataRoot()); captured.directories.push(data);
      const root = await captureDirectory(jobScope.rootPath); captured.directories.push(root);
      if (root.real !== path.join(data.real, rootRelativePath) || !root.real.startsWith(`${data.real}${path.sep}`)) fail('JOB_LIFECYCLE_CHANGED');
      // The first native plan binds the entire live link graph. Existing room
      // owners persist without reacquiring workspace admission on every update,
      // so all rooms/reservations must be idle before the exclusive lease is
      // retained through B1, FS and B2. New owners cannot enter beneath it.
      const guard = captured.nativePaths ? (input: { workspaceId: string; paths: readonly string[] }, callback: () => Promise<T>, open: () => Promise<SqlConnection>) => withMoveLifecycleGuard(captured, input, callback, open) : withWorkspaceFileLifecycleGuard;
      value = await guard({ workspaceId: binding.workspaceId,
        paths: plan.version >= 2 ? [''] : [step.sourcePath] }, async () => {
        captured.lease = getWorkspaceFileLifecycleLeases()?.get(binding.workspaceId);
        captured.active = true;
        return context.run(captured, async () => {
          await checkIdle(captured);
          // A real current job policy is required before the caller can do physical work.
          if (captured.nativePaths) {
            const proceed = await prepareWorkspaceOperationNativePathOwner(owner);
            if (!proceed) throw captured.move ? new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_CHANGED')
              : new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_CHANGED');
          }
          else await withWorkspaceOperationJobLifecycleTransaction(owner, async () => undefined);
          let result: T | undefined, operationFailure: Error | undefined;
          try { result = await operation(owner); } catch (error) {
            operationFailure = asError(error); captured.failure ??= operationFailure;
          }
          captured.accepting = false;
          if (captured.pending.size) {
            captured.failure ??= new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_DETACHED');
            await Promise.allSettled([...captured.pending]);
          }
          if (captured.failure) {
            if (operationFailure && operationFailure !== captured.failure) {
              const failures = new AggregateError([captured.failure, operationFailure], 'Job operation and its cleanup failed.');
              if (captured.failure instanceof WorkspaceOperationJobLifecycleError
                && captured.failure.code === 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED') {
                throw new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_COMMIT_UNCONFIRMED', { cause: failures });
              }
              // Keep a later cleanup error and its public status/code as well as
              // the already-poisoned SQL failure. Never hide uncertain disposal.
              throw Object.assign(failures, {
                code: Object.getOwnPropertyDescriptor(operationFailure, 'code')?.value
                  ?? Object.getOwnPropertyDescriptor(captured.failure, 'code')?.value,
                status: Object.getOwnPropertyDescriptor(operationFailure, 'status')?.value
                  ?? Object.getOwnPropertyDescriptor(captured.failure, 'status')?.value });
            }
            throw captured.failure;
          }
          await checkIdle(captured);
          if (captured.failure) throw captured.failure;
          return result as T;
        });
      }, async () => {
        const original = await openConnection();
        const originalGet = original.get.bind(original), originalAll = original.all.bind(original), originalRun = original.run.bind(original);
        const originalGetPrepared = original.getPrepared?.bind(original);
        const database: SqlConnection = Object.freeze({
          get: (sql: string, values?: unknown[]) => { captured.forwardedQueries++; return originalGet(sql, values); },
          ...(originalGetPrepared ? { getPrepared: (sql: string, values?: unknown[]) => {
            captured.forwardedQueries++; return originalGetPrepared(sql, values);
          } } : {}),
          all: (sql: string, values?: unknown[]) => { captured.forwardedQueries++; return originalAll(sql, values); },
          run: (sql: string, values?: unknown[]) => { captured.forwardedQueries++; return originalRun(sql, values); },
          close: async (reason?: Error) => {
            if (captured.disposed) return; captured.disposed = true;
            try { await original.close(reason); } catch (error) { captured.disposalFailure = asError(error); throw captured.disposalFailure; }
          } });
        captured.database = database;
        try {
          const first = await identity(database, true), second = await identity(database, false);
          if (!sameIdentity(first.identity, second.identity) || second.transaction !== null) fail('JOB_LIFECYCLE_CHANGED');
          captured.identity = second.identity; return database;
        } catch (error) { try { await database.close(asError(error)); } catch { /* Disposal failure is retained separately. */ } throw error; }
      });
    } catch (error) { failure = asError(error); }
    finally {
      captured.active = false; captured.accepting = false; owners.delete(owner);
      for (const directory of captured.directories.reverse()) {
        try { await directory.handle.close(); } catch (error) { captured.disposalFailure ??= asError(error); }
      }
    }
    if (captured.disposalFailure) throw new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_DISPOSAL_UNCONFIRMED',
      { cause: failure ? new AggregateError([failure, captured.disposalFailure]) : captured.disposalFailure });
    if (failure) throw failure;
    return value as T;
  });
}

/** Short serial phases on the actual outer B. Internal DAL only, not an arbitrary SQL sandbox. */
function runLifecycleTransaction<T>(owner: WorkspaceOperationJobLifecycleOwner,
  operation: ((access: WorkspaceOperationJobLifecycleAccess) => Promise<T>) | undefined,
  moveOperation?: (access: WorkspaceOperationJobLifecycleAccess, database: SqlConnection, check: () => Promise<void>) => Promise<T>): Promise<T> {
  const captured = owner && typeof owner === 'object' ? owners.get(owner) : undefined;
  if (!captured) {
    const error = new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REQUIRED'), active = context.getStore();
    if (active) active.failure ??= error; return Promise.reject(error);
  }
  try {
    current(captured);
    if (!captured.accepting || captured.phase || captured.pending.size
      || (captured.move ? typeof moveOperation !== 'function' || operation !== undefined
        : moveOperation !== undefined ? typeof moveOperation !== 'function' || operation !== undefined : typeof operation !== 'function')) fail('JOB_LIFECYCLE_REENTRANT');
  } catch (error) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
  const phase: Phase = { active: true, accepting: true, transaction: '', pending: new Set(), index: ++captured.phaseCount,
    startedAt: null, startedMonotonic: 0, queriesBefore: 0, stage: 'preparation', operation: 'authority', relation: null };
  const checkTimings = captured.binding.plan.version === 5 || captured.binding.plan.version === 6
    ? { started: 0, completed: 0, owner: 0, policy: 0, storage: 0, handoffStorage: 0 } : null;
  captured.phase = phase;
  const pending = withWorkspaceOperationJobClaimPhase(captured.claim, async () => {
    const database = captured.database!; let begun = false, commitAttempted = false;
    try {
      await checkIdle(captured);
      const mcp = captured.mcp;
      const policy = mcp ? undefined : await captureWorkspaceOperationJobPolicy(); current(captured);
      phase.startedAt = Date.now(); phase.startedMonotonic = performance.now(); phase.queriesBefore = captured.forwardedQueries;
      phase.stage = 'begin';
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
      phase.stage = 'identity';
      const started = await identity(database, true);
      if (!started.transaction) fail('JOB_LIFECYCLE_CHANGED'); phase.transaction = started.transaction;
      phase.stage = 'policy';
      const authorize = (operation: (access: WorkspaceOperationJobPolicyAccess) => Promise<T>): Promise<T> => mcp
        ? withWorkspaceOperationMcpJobPolicyOnConnection(database, { claim: captured.claim, principal: mcp }, operation)
        : withWorkspaceOperationJobPolicyOnConnection(database, { claim: captured.claim, policy: policy! }, operation);
      const result = await authorize(async access => {
        // Every owner is an original direct Delete. Bind its fixed storage on
        // the actual B before exposing the deliberately restricted SQL facade.
        const { schemaName, schemaOid, databaseOid } = captured.binding.source;
        phase.stage = 'storage';
        const storage = await (captured.move ? bindWorkspaceOperationOriginalMoveStorageOnConnection : bindWorkspaceOperationOriginalDeleteStorageOnConnection)(database, { schemaName, schemaOid, databaseOid });
        const handoffStorage = captured.nativePaths && !captured.move
          ? await bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection(database, { schemaName, schemaOid, databaseOid }) : null;
        // A fixed internal path set from the genuinely claimed native plan. Keep
        // advisory SQL on the actual owner B, outside the restricted facade.
        if (captured.binding.plan.version === 2 || captured.binding.plan.version === 5 || captured.binding.plan.version === 6) {
          phase.stage = 'path-locks';
          const sources = getWorkspaceOperationDeleteLinkRecipes(captured.binding.plan).map(recipe => recipe.source.path);
          if (captured.binding.plan.version===6) await lockFileCollaborationPaths(database,captured.binding.workspaceId,[...captured.binding.plan.pathSteps.map(step=>step.sourcePath),...sources]);
          else if (sources.length) await lockFileCollaborationPaths(database, captured.binding.workspaceId, [captured.sourcePath, ...sources]);
        }
        const check = async () => {
          let segment: 'owner' | 'policy' | 'storage' | 'handoffStorage' | null = null, since = 0;
          const recordCheckSegment = (next: typeof segment) => {
            if (!checkTimings) return;
            const now = performance.now();
            if (segment) checkTimings[segment] += now - since;
            segment = next; since = now;
          };
          if (checkTimings) checkTimings.started++;
          try {
            recordCheckSegment('owner'); await checkOwner(captured, phase.transaction);
            recordCheckSegment('policy'); await access.assertCurrent();
            recordCheckSegment('storage'); await storage.assertCurrent();
            recordCheckSegment('handoffStorage'); await handoffStorage?.assertCurrent();
            recordCheckSegment('owner'); await checkOwner(captured, phase.transaction);
            if (checkTimings) checkTimings.completed++;
          } finally { recordCheckSegment(null); }
        };
        // The human Delete principal holds its auth/ACL tables and Claim in
        // SHARE through this B. Internal reads may share those policy fences;
        // every write and fixed method boundary still gets a full current
        // check, as do entry/final/COMMIT. No result escapes before completion.
        const lockedHumanDeleteReads = !captured.move && !captured.mcp && captured.binding.actionMode === 'apply'
          && captured.binding.authorization.mode === 'direct' && captured.binding.authorization.actorType === 'user'
          && (captured.binding.plan.version === 5 || captured.binding.plan.version === 6 || captured.binding.plan.version === 2
            && captured.binding.plan.kind === 'native-original-delete' && captured.binding.plan.planIdentityVersion === 4);
        // One exact closed read-only writer scan; byte drift falls back to
        // full checks. Never classify arbitrary WITH or caller SQL as read-only.
        const humanReadPrefix = `"${schemaName.replaceAll('"', '""')}"`;
        const humanWriterReadSql = lockedHumanDeleteReads ? `WITH
    locks AS MATERIALIZED (SELECT id FROM ${humanReadPrefix}.file_locks WHERE workspace_id=$1 AND path=$2
      AND status='active' AND expires_at>$3 FOR SHARE NOWAIT),
    guests AS MATERIALIZED (SELECT id FROM ${humanReadPrefix}.file_guest_invitations WHERE workspace_id=$1 AND path=$2
      AND status='active' FOR SHARE NOWAIT)
    SELECT (SELECT count(*) FROM locks)>0 AS locks, (SELECT count(*) FROM guests)>0 AS guests` : null;
        const dispatch = <R>(sql: string | undefined, query: () => R | Promise<R>,
          diagnosticOperation: Phase['operation'] = 'authority'): Promise<R> => {
          try {
            checkPhase(captured, phase);
            if (phase.pending.size) fail('JOB_LIFECYCLE_REENTRANT');
            if (sql !== undefined && (typeof sql !== 'string' || sql.length > 32768 || /[;\u0000]/u.test(sql)
              || /\bpg_(?:try_)?advisory_/iu.test(sql) || !/^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu.test(sql))) fail('JOB_LIFECYCLE_INVALID');
          } catch (error) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
          phase.operation = sql === undefined ? diagnosticOperation : /^\s*SELECT\b/iu.test(sql) ? 'read' : 'write';
          // Log only a fixed relation name, never SQL text, values or paths.
          phase.relation = sql === undefined ? null : ['collaboration_documents', 'collaboration_yjs_states',
            'file_collaboration_lineages', 'collaboration_file_projections', 'workspace_trash_entries',
            'workspace_file_operation_delete_intents', 'workspace_file_operation_delete_receipts',
            'workspace_file_operation_delete_trash_receipts'].find(name => new RegExp(`\\b${name}\\b`, 'u').test(sql)) ?? null;
          const groupedRead = lockedHumanDeleteReads && (sql === undefined ? diagnosticOperation === 'native-source-read'
            : /^\s*SELECT\b/iu.test(sql) || sql === humanWriterReadSql);
          // Register pending ownership before a cheap read can invoke even a
          // synchronous adapter. Other WITH statements remain fully checked.
          const checked = Promise.resolve().then(async () => { try { phase.stage = 'before-operation-check';
            if (!groupedRead) await check(); checkPhase(captured, phase);
            phase.stage = 'sql'; const value = await query(); phase.stage = 'after-operation-check';
            if (!groupedRead) await check(); checkPhase(captured, phase); return value; }
            catch (error) { return poison(captured, error); } });
          phase.pending.add(checked); void checked.then(() => phase.pending.delete(checked), () => phase.pending.delete(checked)); return checked;
        };
        // An explicit current assertion has no operation between its fences.
        // Keep its own pending/phase/poison boundary and perform the complete
        // current check once. Ordinary SQL and fixed methods retain dispatch.
        const assertCurrentBoundary = (): Promise<void> => {
          try {
            checkPhase(captured, phase);
            if (phase.pending.size) fail('JOB_LIFECYCLE_REENTRANT');
          } catch (error) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
          phase.operation = 'authority'; phase.relation = null;
          const checked = Promise.resolve().then(async () => {
            try {
              phase.stage = 'before-operation-check'; await check();
              phase.stage = 'after-operation-check'; checkPhase(captured, phase);
            } catch (error) { return poison(captured, error); }
          });
          phase.pending.add(checked);
          void checked.then(() => phase.pending.delete(checked), () => phase.pending.delete(checked));
          return checked;
        };
        const facade: SqlConnection = Object.freeze({ get: (sql: string, values?: unknown[]) => dispatch(sql, () => database.get(sql, values)),
          all: (sql: string, values?: unknown[]) => dispatch(sql, () => database.all(sql, values)),
          run: (sql: string, values?: unknown[]) => dispatch(sql, () => database.run(sql, values)),
          close: () => dispatch('CLOSE', async () => undefined) });
        return phaseContext.run(phase, async () => {
          phase.stage = 'operation';
          await check();
          let result: T | undefined;
          try {
            const restrictedAccess: WorkspaceOperationJobLifecycleAccess = Object.freeze({ ...access, database: facade,
            readOriginalNativeDeleteAdmission: () => dispatch(undefined, async () => {
              if (captured.move || captured.binding.actionMode !== 'apply' || captured.binding.plan.version !== 2 && captured.binding.plan.version !== 5 && captured.binding.plan.version !== 6) fail('JOB_LIFECYCLE_INVALID');
              const admission = await readWorkspaceOperationNativePathAdmissionOnConnection(database, captured.claim);
              if (!admission || !['reserved', 'draining'].includes(admission.status) || admission.outcome) fail('JOB_LIFECYCLE_CHANGED');
              const original = captureCollaborationAdmissionRequest(admission.request);
              return Object.freeze({ requestId: original.request.requestId, requestDigest: original.requestDigest });
            }),
            readOriginalNativeDeleteSources: () => dispatch(undefined, async () => {
              if (captured.binding.actionMode !== 'apply' || captured.binding.plan.version !== 2 && captured.binding.plan.version !== 5 && captured.binding.plan.version !== 6) fail('JOB_LIFECYCLE_INVALID');
              // Fixed read of this claimed workspace only. The ordinary SQL
              // facade remains restricted and every method boundary is checked.
              return readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace,
                { physicalParserVersion: deriveWorkspacePathPhysicalParserVersion(captured.binding.plan.sourceEvidence) });
            }, 'native-source-read'),
            applyOriginalNativeDeleteLinks: (expectedIntentDigest: string) => dispatch(undefined, async () => {
              const { binding } = captured;
              if (binding.actionMode !== 'apply' || binding.plan.version !== 2 && binding.plan.version !== 5 && binding.plan.version !== 6
                || typeof expectedIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedIntentDigest)) fail('JOB_LIFECYCLE_INVALID');
              // Read the actual immutable journal on this owner B. The caller's
              // digest selects no actor, workspace, source, recipe or Yjs bytes.
              const row = await readWorkspaceOperationOriginalDeleteIntentOnConnection(database,
                { schema: schemaName, batchId: binding.batchId, forShare: true });
              if (!row || row.intentDigest !== expectedIntentDigest) fail('JOB_LIFECYCLE_CHANGED');
              if (binding.plan.version === 6) {
                const intent=parseCohortDeleteIntent(row,binding,access.workspace,resolveWorkspaceDataRoot());
                if(!intent.nativeLinks.length)fail('JOB_LIFECYCLE_INVALID');
                const validate=async()=>{phase.stage='link-authority';checkPhase(captured,phase);await check();checkPhase(captured,phase);phase.stage='sql';};
                return applyOriginalDeleteNativeHtmlLinksV4(database,access.workspace,intent.nativeLinks,validate,intent.currentWitness.nativeComponent);
              }
              const intent = parseIntent(row, { batchId: binding.batchId, planId: binding.planId,
                workspaceId: binding.workspaceId, authorization: binding.authorization, sourcePath: captured.sourcePath },
              access.workspace, resolveWorkspaceDataRoot());
              if (intent.version !== 2 && intent.version !== 3 && intent.version !== 4 && intent.version !== 5 && intent.version !== 6 && intent.version !== 7 || !intent.nativeLinks?.length) fail('JOB_LIFECYCLE_INVALID');
              assertOriginalDeleteIntentPlan(intent, binding.plan);
              if (binding.plan.version === 5) {
                if (intent.version !== 7) fail('JOB_LIFECYCLE_CHANGED');
                assertOriginalPhysicalDeleteLinkPlanV5(binding.plan,intent.nativeLinks);
              } else assertOriginalDeleteNativeLinkPlan(binding.plan,intent.nativeLinks);
              // Keep current authority before every source (including receipt
              // retries) and immediately before each CAS. This private check
              // does not recursively enter the public dispatch queue.
              const validate = async () => { phase.stage = 'link-authority'; checkPhase(captured, phase); await check();
                checkPhase(captured, phase); phase.stage = 'sql'; };
              if (intent.version === 6 || intent.version === 7) return applyOriginalDeleteNativeHtmlLinksV4(database, access.workspace, intent.nativeLinks, validate, intent.currentWitness.nativeComponent);
              return applyOriginalDeleteNativeLinks(database, access.workspace, intent.nativeLinks, validate,
                intent.version === 3 || intent.version === 4 || intent.version === 5
                  ? intent.version === 5 ? intent.currentWitness.nativeComponent : intent.currentWitness
                  : undefined);
            }, 'native-link-write'),
            archiveOriginalNativeCohortDeleteTargets: (expectedIntentDigest:string) => dispatch(undefined,async()=>{
              const {binding}=captured;
              if(captured.move||binding.actionMode!=='apply'||binding.plan.version!==6||typeof expectedIntentDigest!=='string'||!/^[a-f0-9]{64}$/u.test(expectedIntentDigest))fail('JOB_LIFECYCLE_INVALID');
              const row=await readWorkspaceOperationOriginalDeleteIntentOnConnection(database,{schema:schemaName,batchId:binding.batchId,forShare:true});
              if(!row||row.intentDigest!==expectedIntentDigest)fail('JOB_LIFECYCLE_CHANGED');
              const intent=parseCohortDeleteIntent(row,binding,access.workspace,resolveWorkspaceDataRoot());
              const validate=async()=>{phase.stage='before-operation-check';checkPhase(captured,phase);await check();checkPhase(captured,phase);phase.stage='sql';};
              const result:Array<{path:string;transition:NativeFileArchiveTransition}>=[];
              for(const target of intent.targets){if(!target.native)continue;
                const root=intent.roots.find(root=>root.stepKey===target.rootStep);if(!root)fail('JOB_LIFECYCLE_CHANGED');
                const transition=await archiveOriginalNativeDeleteTargetOnConnection(database,{schema:schemaName,workspace:access.workspace,
                  expected:target.native,trashEntryId:root.physical.trashEntryId,archivedAt:root.physical.deletedAtMs},validate);
                result.push({path:target.path,transition});}
              return Object.freeze(result);
            },'native-archive-write'),
            archiveOriginalNativeHtmlDeleteTarget: (expectedIntentDigest: string) => dispatch(undefined, async () => {
              const { binding } = captured;
              if (captured.move || binding.actionMode !== 'apply' || binding.plan.version !== 2
                || binding.plan.kind !== 'native-original-delete' || binding.plan.planIdentityVersion !== 4
                || typeof expectedIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedIntentDigest)) fail('JOB_LIFECYCLE_INVALID');
              // This fixed operation rereads the immutable journal on the genuine
              // owner B. The caller's digest chooses no target or authority facts.
              const row = await readWorkspaceOperationOriginalDeleteIntentOnConnection(database,
                { schema: schemaName, batchId: binding.batchId, forShare: true });
              if (!row || row.intentDigest !== expectedIntentDigest) fail('JOB_LIFECYCLE_CHANGED');
              const intent = parseIntent(row, { batchId: binding.batchId, planId: binding.planId,
                workspaceId: binding.workspaceId, authorization: binding.authorization, sourcePath: captured.sourcePath },
              access.workspace, resolveWorkspaceDataRoot());
              if (intent.version !== 6 || !intent.native) fail('JOB_LIFECYCLE_INVALID');
              assertOriginalDeleteIntentPlan(intent, binding.plan);
              // Coarser fixed operation boundaries, not per-SQL authority
              // equivalence: retain a full check at every archive/CAS boundary.
              const validate = async () => { phase.stage = 'before-operation-check'; checkPhase(captured, phase); await check();
                checkPhase(captured, phase); phase.stage = 'sql'; };
              return archiveOriginalNativeDeleteTargetOnConnection(database,
                { schema: schemaName, workspace: access.workspace, expected: intent.native,
                  trashEntryId: intent.physical.trashEntryId, archivedAt: intent.physical.deletedAtMs }, validate);
            }, 'native-archive-write'),
            assertCurrent: () => assertCurrentBoundary() });
            result = moveOperation ? await moveOperation(restrictedAccess, database, check) : await operation!(restrictedAccess);
          }
          catch (error) { captured.failure ??= asError(error); }
          phase.accepting = false;
          if (phase.pending.size) {
            captured.failure ??= new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_DETACHED');
            await Promise.allSettled([...phase.pending]);
          }
          if (captured.failure) throw captured.failure;
          phase.stage = 'final-check'; await check(); if (captured.failure) throw captured.failure; return result as T;
        });
      });
      if (captured.failure) throw captured.failure;
      phase.stage = 'final-check'; await checkOwner(captured, phase.transaction);
      phase.stage = 'commit';
      phase.accepting = false; commitAttempted = true; await database.run('COMMIT'); begun = false;
      phase.stage = 'after-commit';
      captured.phase = undefined; phase.active = false; await checkIdle(captured);
      if (captured.failure) throw captured.failure; return result;
    } catch (error) {
      // Observe the original failure before rollback, disposal or worker status
      // projection can wrap it. This has no SQL or transaction side effect.
      reportWorkspaceOperationFailureDiagnostics(error, diagnostics => {
        console.error('[File action owner] Transaction failed.', JSON.stringify({ version: 1, at: new Date().toISOString(),
          batchId: captured.binding.batchId, backendPid: captured.identity?.backend ?? null, phaseIndex: phase.index,
          phaseStartedAt: phase.startedAt === null ? null : new Date(phase.startedAt).toISOString(),
          elapsedMs: phase.startedAt === null ? null : Math.round(performance.now() - phase.startedMonotonic),
          forwardedQueries: phase.startedAt === null ? null : captured.forwardedQueries - phase.queriesBefore,
          stage: phase.stage, operation: phase.operation, relation: phase.relation, commitAttempted, diagnostics }));
      });
      let failure = asError(error);
      captured.failure ??= failure; phase.accepting = false;
      if (phase.pending.size) await Promise.allSettled([...phase.pending]);
      if (begun) { try { await database.run('ROLLBACK'); } catch (rollbackError) { failure = new AggregateError([failure, asError(rollbackError)]); } }
      if (commitAttempted) {
        failure = new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_COMMIT_UNCONFIRMED', { cause: failure });
        captured.failure = failure;
        // A caught uncertain result must not leave an inherited live lease.
        if (captured.lease) captured.lease.active = false;
        try { await database.close(failure); } catch { /* Disposal failure is retained separately. */ }
      }
      return poison(captured, failure);
    } finally {
      if (checkTimings && phase.startedAt !== null) console.info('[File action owner] Physical Delete current-check timings.', JSON.stringify({
        version: 1, planVersion: captured.binding.plan.version, phaseIndex: phase.index, phaseElapsedMs: Math.round(performance.now() - phase.startedMonotonic),
        forwardedQueries: captured.forwardedQueries - phase.queriesBefore, startedChecks: checkTimings.started,
        completedChecks: checkTimings.completed, ownerMs: Math.round(checkTimings.owner), policyMs: Math.round(checkTimings.policy),
        storageMs: Math.round(checkTimings.storage), handoffStorageMs: Math.round(checkTimings.handoffStorage) }));
      phase.accepting = false; phase.active = false; if (captured.phase === phase) captured.phase = undefined;
    }
  });
  captured.pending.add(pending); void pending.then(() => captured.pending.delete(pending), () => captured.pending.delete(pending)); return pending;
}

/** Original Delete API. Move capabilities cannot enter its restricted SQL facade. */
export function withWorkspaceOperationJobLifecycleOwner<T>(claim: WorkspaceOperationBatchClaim,
  operation: (owner: WorkspaceOperationJobLifecycleOwner) => Promise<T>,
  openConnection: () => Promise<SqlConnection> = openDb, mcp?: WorkspaceOperationMcpJobPrincipal): Promise<T> {
  return withLifecycleOwner(claim, operation, openConnection, false, mcp);
}
export function withWorkspaceOperationJobLifecycleTransaction<T>(owner: WorkspaceOperationJobLifecycleOwner,
  operation: (access: WorkspaceOperationJobLifecycleAccess) => Promise<T>): Promise<T> {
  const captured = owners.get(owner);
  if (captured?.move) { try { poison(captured, new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_INVALID')); }
    catch (error) { return Promise.reject(error); } }
  if (captured && captured.binding.actionMode === 'apply' && (captured.binding.plan.version === 5
    || captured.binding.plan.version === 6
    || captured.binding.plan.version === 2 && captured.binding.plan.planIdentityVersion === 4)) {
    // Preparation and preflight inspect the same fixed grammar as B2. Keep
    // its lifetime within this fully awaited transaction; current data and
    // every ordinary SQL/authority boundary are still freshly checked.
    return withNativeInspectionSchema(() => runLifecycleTransaction(owner, operation))
      .catch(error => poison(captured, error));
  }
  return runLifecycleTransaction(owner, operation);
}

/** Private SQL read group for the fixed original Delete algorithms below.
 * Current facts are always read on this B; every write and fixed access method
 * keeps its complete current check. No raw connection or callback API escapes. */
async function withOriginalDeleteDomainAccess<T>(captured: Capture, database: SqlConnection,
  access: WorkspaceOperationJobLifecycleAccess, check: () => Promise<void>,
  operation: (domainAccess: WorkspaceOperationJobLifecycleAccess) => Promise<T>): Promise<T> {
  const schema = captured.binding.source.schemaName;
  const domainPhase = captured.phase;
  if (!domainPhase) fail('JOB_LIFECYCLE_REQUIRED');
  let domainActive = true;
  const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
  const readOnlyWriterScanSQL = `WITH
    locks AS MATERIALIZED (SELECT id FROM ${quotedSchema}.file_locks WHERE workspace_id=$1 AND path=$2
      AND status='active' AND expires_at>$3 FOR SHARE NOWAIT),
    guests AS MATERIALIZED (SELECT id FROM ${quotedSchema}.file_guest_invitations WHERE workspace_id=$1 AND path=$2
      AND status='active' FOR SHARE NOWAIT)
    SELECT (SELECT count(*) FROM locks)>0 AS locks, (SELECT count(*) FROM guests)>0 AS guests`;
  // Private to these exact awaited original Delete algorithms. No raw B or grouped
  // read result escapes; all fixed access methods keep their dispatch.
  const assertDomainCurrent = () => {
    try {
      checkPhase(captured, domainPhase);
      if (!domainActive || current(captured) !== database) fail('JOB_LIFECYCLE_REQUIRED');
    } catch (error) { poison(captured, error); }
  };
  const dispatchDomainSql = <R>(sql: string, query: () => R | Promise<R>): Promise<R> => {
    try {
      assertDomainCurrent();
      if (domainPhase.pending.size) fail('JOB_LIFECYCLE_REENTRANT');
      if (typeof sql !== 'string' || sql.length > 32768 || /[;\u0000]/u.test(sql)
        || /\bpg_(?:try_)?advisory_/iu.test(sql) || !/^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu.test(sql)) fail('JOB_LIFECYCLE_INVALID');
    } catch (error) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
    const write = !/^\s*SELECT\b/iu.test(sql) && sql !== readOnlyWriterScanSQL;
    domainPhase.operation = write ? 'write' : 'read';
    domainPhase.relation = ['collaboration_documents', 'collaboration_yjs_states',
      'file_collaboration_lineages', 'collaboration_file_projections', 'workspace_trash_entries',
      'workspace_file_operation_delete_intents', 'workspace_file_operation_delete_receipts',
      'workspace_file_operation_delete_trash_receipts'].find(name => new RegExp(`\\b${name}\\b`, 'u').test(sql)) ?? null;
    // Install pending ownership before any actual SQL, including a
    // synchronously implemented connection or reentrant test adapter.
    const checked = Promise.resolve().then(async () => {
      try {
        assertDomainCurrent();
        if (write) { domainPhase.stage = 'before-operation-check'; await check(); assertDomainCurrent(); }
        domainPhase.stage = 'sql'; const value = await query();
        domainPhase.stage = 'after-operation-check'; assertDomainCurrent();
        if (write) { await check(); assertDomainCurrent(); }
        return value;
      } catch (error) { return poison(captured, error); }
    });
    domainPhase.pending.add(checked);
    void checked.then(() => domainPhase.pending.delete(checked), () => domainPhase.pending.delete(checked));
    return checked;
  };
  const domainDatabase: SqlConnection = Object.freeze({
    get: (sql: string, values?: unknown[]) => dispatchDomainSql(sql, () => database.get(sql, values)),
    all: (sql: string, values?: unknown[]) => dispatchDomainSql(sql, () => database.all(sql, values)),
    run: (sql: string, values?: unknown[]) => dispatchDomainSql(sql, () => database.run(sql, values)),
    close: () => dispatchDomainSql('CLOSE', async () => undefined),
  });

  const archiveCohort = access.archiveOriginalNativeCohortDeleteTargets;
  try {
    return await operation(Object.freeze({ ...access, database: domainDatabase,
      readOriginalNativeDeleteAdmission: () => { assertDomainCurrent(); return access.readOriginalNativeDeleteAdmission(); },
      readOriginalNativeDeleteSources: () => { assertDomainCurrent(); return access.readOriginalNativeDeleteSources(); },
      applyOriginalNativeDeleteLinks: (digest: string) => { assertDomainCurrent(); return access.applyOriginalNativeDeleteLinks(digest); },
      archiveOriginalNativeHtmlDeleteTarget: (digest: string) => { assertDomainCurrent(); return access.archiveOriginalNativeHtmlDeleteTarget(digest); },
      assertCurrent: () => { assertDomainCurrent(); return access.assertCurrent(); },
      ...(archiveCohort ? { archiveOriginalNativeCohortDeleteTargets: (digest: string) => {
        assertDomainCurrent(); return archiveCohort(digest);
      } } : {}),
    }));
  } catch (error) { return poison(captured, error); }
  finally {
    domainActive = false;
    if (domainPhase.pending.size) {
      captured.failure ??= new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_DETACHED');
      await Promise.allSettled([...domainPhase.pending]);
    }
  }
}

/** Fixed native Delete B2. Only the real Owner selects its immutable intent,
 * current authority, admission request and restricted domain operation. */
export function completeWorkspaceOperationOriginalDeleteJob(owner: WorkspaceOperationJobLifecycleOwner,
  input: Readonly<{ expectedIntentDigest: string; prepared: PreparedWorkspaceSingleFileTrash; physical: PreparedSingleFileTrashReceipt }>
): Promise<WorkspaceOperationOriginalDeleteResult> {
  const captured = owners.get(owner);
  try {
    if (!captured || captured.move || captured.binding.actionMode !== 'apply' || captured.binding.plan.version !== 2 && captured.binding.plan.version !== 5) fail('JOB_LIFECYCLE_REQUIRED');
    current(captured);
    const fields = moveFields(input, ['expectedIntentDigest', 'prepared', 'physical']);
    if (typeof fields.expectedIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(fields.expectedIntentDigest)) fail('JOB_LIFECYCLE_INVALID');
    const expectedIntentDigest = fields.expectedIntentDigest, prepared = fields.prepared as PreparedWorkspaceSingleFileTrash;
    const physical = fields.physical as PreparedSingleFileTrashReceipt;
    const original = readPreparedWorkspaceSingleFileTrash(prepared);
    if (!equal(physical?.original, original)) fail('JOB_LIFECYCLE_CHANGED');
    const complete = () => runLifecycleTransaction(owner, undefined, async (access, database, check) => {
      const { binding } = captured, schema = binding.source.schemaName;
      const evidenceContext = { batchId: binding.batchId, planId: binding.planId, workspaceId: binding.workspaceId,
        authorization: binding.authorization, sourcePath: captured.sourcePath };
      const durable = await readWorkspaceOperationOriginalDeleteIntentOnConnection(database, { schema, batchId: binding.batchId, forShare: true });
      if (!durable || durable.intentDigest !== expectedIntentDigest) fail('JOB_LIFECYCLE_CHANGED');
      const intent = parseIntent(durable, evidenceContext, access.workspace, resolveWorkspaceDataRoot());
      if (intent.version !== 4 && intent.version !== 5 && intent.version !== 6 && intent.version !== 7 || !equal(intent.physical,original)
        || binding.plan.version !== 2 && binding.plan.version !== 5 || (binding.plan.version === 5) !== (intent.version === 7)) fail('JOB_LIFECYCLE_CHANGED');
      assertOriginalDeleteIntentPlan(intent, binding.plan);
      const admission = await readWorkspaceOperationOriginalDeleteAdmissionOnConnection(database, { schema, intent });
      if (admission.outcome || !['reserved', 'draining'].includes(admission.status)) fail('JOB_LIFECYCLE_CHANGED');
      const claimed = await readWorkspaceOperationNativePathAdmissionOnConnection(database, captured.claim);
      if (!claimed || !equal(captureCollaborationAdmissionRequest(claimed.request), captureCollaborationAdmissionRequest(admission.request))) fail('JOB_LIFECYCLE_CHANGED');
      let result: WorkspaceOperationOriginalDeleteResult | undefined;
      const outcome = await executeCollaborationAdmissionHandoffOnConnection(database, admission.request, {
        kind: 'apply', authorize: async () => { await check(); },
        prepare: async connection => {
          if (connection !== database) fail('JOB_LIFECYCLE_CHANGED');
          await check(); await assertPreparedWorkspaceSingleFileTrashCurrent(prepared); await check();
        },
        mutate: async connection => {
          if (connection !== database) fail('JOB_LIFECYCLE_CHANGED');
          await check();
          {
            // Admission-backed original profiles only; the strict intent/plan
            // comparison above remains the authority for all original facts.
            if (intent.version === 7
              ? binding.plan.version !== 5 || binding.plan.kind !== 'physical-original-delete'
                || binding.plan.planIdentityVersion !== 5 || intent.native !== null
              : binding.plan.version !== 2 || binding.plan.kind !== 'native-original-delete'
                || binding.plan.planIdentityVersion !== intent.version - 2 || !intent.native) fail('JOB_LIFECYCLE_INVALID');
            result = await withOriginalDeleteDomainAccess(captured, database, access, check,
              domainAccess => completeWorkspaceOperationOriginalDeleteDomain(domainAccess,
                { binding, evidenceContext, originalDurable: durable, originalIntent: intent, prepared, physical }));
          }
          await check();
          return workspaceOperationOriginalDeleteAdmissionResult(result);
        },
      });
      if (!result || outcome.version !== 1 || !equal(outcome.result, workspaceOperationOriginalDeleteAdmissionResult(result))) fail('JOB_LIFECYCLE_CHANGED');
      await readWorkspaceOperationOriginalDeleteAdmissionOnConnection(database, { schema, intent, result });
      await check();
      await notifyWorkspaceFileInvalidationOnConnection(database, binding.workspaceId);
      return result;
    });
    const htmlInspection = captured.binding.plan.kind === 'physical-original-delete'
      || captured.binding.plan.kind === 'native-original-delete' && captured.binding.plan.planIdentityVersion === 4;
    if (!htmlInspection) return complete();
    // HTML-aware native and physical Delete share fixed grammar for this fully
    // awaited B2 attempt, including rollback/drain. No document facts or
    // current-authority results are cached.
    return withNativeInspectionSchema(complete).catch(error => poison(captured, error));
  } catch (error) {
    if (captured) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
    return Promise.reject(error);
  }
}

/** Validate the still-pristine source after real room quiescence. A concrete
 * plan conflict is data until its no-write abort has committed; SQL, authority,
 * lease and disposal failures still poison the ordinary owning phase. */
async function prepareWorkspaceOperationNativePathOwner(owner: WorkspaceOperationJobLifecycleOwner): Promise<boolean> {
  const captured = owners.get(owner);
  if (!captured?.nativePaths) fail('JOB_LIFECYCLE_REQUIRED');
  return runLifecycleTransaction(owner, undefined, async (access, database, check) => {
    const admission = await readWorkspaceOperationNativePathAdmissionOnConnection(database, captured.claim);
    if (!admission) return true; // Existing historical protocol, without a new P0.
    if (admission.outcome) return admission.outcome.version === 1;
    const { binding } = captured, plan = binding.plan;
    if (plan.version === 3) {
      const rows = await readMoveRows(captured, database);
      if (rows.intent) return true; // Descriptor recovery must use its existing overlay.
    } else if (plan.version === 2 || plan.version === 5 || plan.version === 6) {
      if (await readWorkspaceOperationOriginalDeleteIntentOnConnection(database,
        { schema: binding.source.schemaName, batchId: binding.batchId, forShare: true })) return true;
    } else fail('JOB_LIFECYCLE_INVALID');
    const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace,
      { physicalParserVersion: deriveWorkspacePathPhysicalParserVersion(plan.sourceEvidence) });
    await check();
    let conflict = false;
    try {
      if (plan.version === 3 && (plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4)) {
        const prepared = await readWorkspaceOperationOriginalMovePreparationOnConnection(database,
          { schema: binding.source.schemaName, context: captured.move!.context });
        if (!prepared) fail('JOB_LIFECYCLE_CHANGED');
        const witness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, observation, plan.sourceEvidence.workspaceScope);
        conflict = !equal(witness, prepared.preparation.currentWitness);
      } else if (plan.version === 6) {
        captureWorkspaceOperationCohortDeleteCurrent(plan,observation,plan.sourceEvidence.workspaceScope);
      } else if (plan.version === 5) {
        captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan,observation,plan.sourceEvidence.workspaceScope);
      } else if (plan.version === 2 && (plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4)) {
        captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan, observation, plan.sourceEvidence.workspaceScope);
      }
    } catch (error) {
      if (error instanceof WorkspaceOperationCohortDeleteError && error.code === 'COHORT_DELETE_CHANGED'
        || error instanceof WorkspaceOperationNativeMovePlanError && error.code === 'NATIVE_MOVE_PLAN_CHANGED'
        || error instanceof WorkspaceOperationNativeDeletePlanError && error.code === 'NATIVE_DELETE_PLAN_CHANGED'
        || error instanceof WorkspaceOperationPhysicalDeleteHtmlPlanError && error.code === 'PHYSICAL_DELETE_PLAN_CHANGED'
        || error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === 'NATIVE_SOURCE_EVIDENCE_CHANGED') conflict = true;
      else throw error;
    }
    if (!conflict) return true;
    await check();
    const outcome = await executeCollaborationAdmissionHandoffOnConnection(database, admission.request, {
      kind: 'abort', reasonCode: 'precondition_failed', authorize: async () => { await check(); },
      prepare: async connection => { if (connection !== database) fail('JOB_LIFECYCLE_CHANGED'); await check(); },
    });
    if (outcome.version !== 2 || outcome.disposition !== 'aborted' || outcome.reasonCode !== 'precondition_failed') fail('JOB_LIFECYCLE_CHANGED');
    await check();
    await notifyWorkspaceFileInvalidationOnConnection(database, binding.workspaceId);
    return false;
  });
}

declare const moveOwnerBrand: unique symbol;
export type WorkspaceOperationNativeMoveJobOwner = Readonly<{ [moveOwnerBrand]: true }>;
export type WorkspaceOperationOriginalMoveJobReceipts = Readonly<{
  context: WorkspaceOperationOriginalMoveContext;
  intentRow: WorkspaceOperationOriginalMoveIntent | null;
  intent: WorkspaceOperationOriginalMoveIntentData | null;
  parentRows: readonly WorkspaceOperationOriginalMoveParentReceipt[];
  pathRows: readonly WorkspaceOperationOriginalMovePathReceipt[];
  completionRow: WorkspaceOperationOriginalMoveReceipt | null;
  completion: WorkspaceOperationOriginalMoveCompletionData | null;
}>;
const moveHash = (text: string) => createHash('sha256').update(text).digest('hex');
const moveJson = serializeWorkspaceOperationOriginalMoveData;
function captureMove(binding: WorkspaceOperationBatchClaimBinding): MoveCapture {
  const auth = binding.authorization;
  if (auth.mode !== 'direct' && auth.mode !== 'direct-mcp' || !auth.jobScope || auth.jobScope.legacy || binding.actionMode !== 'apply'
    || binding.plan.version !== 3) fail('JOB_LIFECYCLE_INVALID');
  const plan = decodeWorkspaceOperationNativeMoveBatchPlan(binding.plan);
  const nativeBindings = workspaceOperationSourceNativeEvidence(plan.sourceEvidence).nativeBindings;
  if (!equal(plan.sourceEvidence.workspaceScope, auth.jobScope) || nativeBindings.length > 1024) fail('JOB_LIFECYCLE_INVALID');
  const selected = Object.freeze({ batchId: binding.batchId, requestHash: auth.requestHash,
    actor: Object.freeze({ userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType,
      actorSessionId: auth.actorSessionId ?? null }), plan });
  const guards = nativeBindings.map(item => lockIdentity(item.expected.documentId).key);
  if (new Set(guards).size !== guards.length || guards.includes(collaborationAdmissionLockKey(binding.workspaceId))) fail('JOB_LIFECYCLE_INVALID');
  return { context: captureWorkspaceOperationOriginalMoveContext(selected), preparedSteps: Object.freeze([]), guards: Object.freeze(guards.sort((a,b) => BigInt(a)<BigInt(b)?-1:1)) };
}
function moveOwner(owner: WorkspaceOperationNativeMoveJobOwner): Capture {
  const selected = owner && typeof owner === 'object' ? owners.get(owner as unknown as WorkspaceOperationJobLifecycleOwner) : undefined;
  if (!selected?.move) {
    const active = context.getStore(); if (active) return poison(active, new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REQUIRED'));
    return fail('JOB_LIFECYCLE_REQUIRED');
  }
  try { current(selected); return selected; } catch (error) { return poison(selected, error); }
}
function movePhase<T>(owner: WorkspaceOperationJobLifecycleOwner | WorkspaceOperationNativeMoveJobOwner,
  operation: (access: WorkspaceOperationJobPolicyAccess, database: SqlConnection, check: () => Promise<void>) => Promise<T>): Promise<T> {
  return runLifecycleTransaction(owner as WorkspaceOperationJobLifecycleOwner, undefined, operation);
}
function captureMovePrepared(input: readonly MovePrepared[], requireReceipts: boolean): readonly MovePrepared[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || !input.length || input.length > 1000
    || Reflect.ownKeys(input).length !== input.length + 1) fail('JOB_LIFECYCLE_INVALID');
  return Object.freeze(Array.from({length:input.length}, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('JOB_LIFECYCLE_INVALID');
    const item = descriptor.value;
    const keys = requireReceipts ? ['stepKey','cap','receipt'] : ['stepKey','cap'];
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(item).length !== keys.length) fail('JOB_LIFECYCLE_INVALID');
    const fields = keys.map(key => { const field = Object.getOwnPropertyDescriptor(item,key);
      if (!field?.enumerable || !Object.hasOwn(field,'value')) fail('JOB_LIFECYCLE_INVALID'); return field.value; });
    if (fields[0] !== `path:${String(index).padStart(4,'0')}` || !fields[1] || typeof fields[1] !== 'object') fail('JOB_LIFECYCLE_INVALID');
    readPreparedWorkspacePathMove(fields[1]);
    return Object.freeze({ stepKey: fields[0], cap: fields[1], ...(requireReceipts ? { receipt: fields[2] } : {}) });
  }));
}
function checkMoveGuards(captured: Capture, observedCount: number | undefined): void {
  current(captured);
  if (observedCount !== captured.nativePaths!.guards.length) {
    if (captured.lease) captured.lease.active = false;
    fail('JOB_LIFECYCLE_CHANGED');
  }
}
// Only pure decoding facts belong to this exact live B/transaction/ALS phase.
// History reads and foreign, detached or already closed phases stay fully strict.
function moveIntentReadPhase(captured: Pick<Capture,'binding'|'move'>, database: SqlConnection): Phase | undefined {
  const active = context.getStore(), phase = phaseContext.getStore();
  if (!active || active !== captured || owners.get(active.owner) !== active || !active.active || !active.accepting
    || active.disposed || active.failure || active.database !== database || active.move?.context !== captured.move?.context
    || !phase || active.phase !== phase || !phase.active || !phase.accepting || !phase.transaction) return undefined;
  return phase;
}
const moveIntentReadFields = ['batchId','planId','workspaceId','requestHash','intentText','intentDigest','createdAt'] as const;
/** A small detached primitive snapshot, never another serialization of the payload.
 * An unknown shape/inspection failure must reach the original strict parser. */
function captureMoveIntentReadRow(row: WorkspaceOperationOriginalMoveIntent): WorkspaceOperationOriginalMoveIntent | null {
  try {
    if (!row || typeof row !== 'object' || types.isProxy(row) || Object.getPrototypeOf(row) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(row);
    if (keys.length !== moveIntentReadFields.length || keys.some(key => typeof key !== 'string'
      || !moveIntentReadFields.some(field => field === key))) return null;
    const copied: Record<string, unknown> = {};
    for (const field of moveIntentReadFields) {
      const descriptor = Object.getOwnPropertyDescriptor(row, field);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== (field === 'createdAt' ? 'number' : 'string')) return null;
      copied[field] = descriptor.value;
    }
    return Object.freeze(copied) as WorkspaceOperationOriginalMoveIntent;
  } catch { return null; }
}
async function readMoveRows(captured: Pick<Capture,'binding'|'move'>, database: SqlConnection): Promise<WorkspaceOperationOriginalMoveJobReceipts> {
  const selected = captured.move!.context, schema = captured.binding.source.schemaName;
  const beforeReadPhase = moveIntentReadPhase(captured,database);
  const intentRow = await readWorkspaceOperationOriginalMoveIntentOnConnection(database,{schema,batchId:selected.batchId,forShare:true});
  if (!intentRow) return Object.freeze({context:selected,intentRow:null,intent:null,parentRows:[],pathRows:[],completionRow:null,completion:null});
  const phase = beforeReadPhase && moveIntentReadPhase(captured,database) === beforeReadPhase ? beforeReadPhase : undefined;
  const rowFacts = phase ? captureMoveIntentReadRow(intentRow) : null, previous = phase?.moveIntentReadFacts;
  const reusable = previous && rowFacts && previous.database === database && previous.context === selected
    && previous.transaction === phase!.transaction
    && moveIntentReadFields.every(field => Object.is(rowFacts[field],previous.row[field]));
  const intent = reusable ? previous.intent : parseWorkspaceOperationOriginalMoveIntent(intentRow,selected);
  if (!reusable && phase && rowFacts && moveIntentReadPhase(captured,database) === phase) {
    phase.moveIntentReadFacts = Object.freeze({database,context:selected,transaction:phase.transaction,row:rowFacts,intent});
  }
  const read = {schema,batchId:selected.batchId,intentDigest:intentRow.intentDigest,forShare:true as const};
  const parentRows = await listWorkspaceOperationOriginalMoveParentReceiptsOnConnection(database,{...read,maxRows:1000,maxTotalBytes:16*1024**2});
  const pathRows = await listWorkspaceOperationOriginalMovePathReceiptsOnConnection(database,{...read,maxRows:1000,maxTotalBytes:64*1024**2});
  if (!parentRows || !pathRows) fail('JOB_LIFECYCLE_CHANGED');
  for (const row of parentRows) decodeWorkspaceOperationOriginalMoveParentReceipt(row,intent);
  for (const row of pathRows) decodeWorkspaceOperationOriginalMovePathReceipt(row,intent,parentRows);
  const completionRow = await readWorkspaceOperationOriginalMoveReceiptOnConnection(database,read);
  const completion = completionRow ? decodeWorkspaceOperationOriginalMoveCompletion(completionRow,intent,parentRows,pathRows) : null;
  return Object.freeze({context:selected,intentRow,intent,parentRows:Object.freeze(parentRows),pathRows:Object.freeze(pathRows),completionRow,completion});
}
function moveRequest(captured: Pick<Capture,'binding'|'move'>, intent: WorkspaceOperationOriginalMoveIntentData | null): CollaborationAdmissionRequest {
  return createWorkspaceOperationOriginalMoveAdmissionRequest(captured.move!.context,intent);
}
async function withMoveLifecycleGuard<T>(captured: Capture, input: {workspaceId:string;paths:readonly string[]},
  callback: () => Promise<T>, open: () => Promise<SqlConnection>): Promise<T> {
  const database = await open(); let closed = false;
  const key = collaborationAdmissionLockKey(input.workspaceId);
  const lease: WorkspaceFileLifecycleLease = {active:true,verify:async () => {
    if (!lease.active || closed) return false;
    try {
      const now = await identity(database,false,captured);
      if (now.workspaceHeld === true && now.roomCount === captured.nativePaths!.guards.length
        && sameIdentity(captured.identity!,now.identity) && lease.active && !closed) return true;
    } catch { /* Lost B revokes the actual lease. */ }
    lease.active = false; return false;
  }};
  try {
    await database.run("SET statement_timeout='5s'"); await database.run("SET lock_timeout='4s'");
    let locked: {locked?:boolean}|undefined;
    try {
      // A short read fence can outlive Move admission. Wait only for the
      // workspace lease, within the fixed bounds, before any owner effects.
      locked = await database.get(captured.move
        ? 'SELECT pg_advisory_lock($1::bigint), true AS locked'
        : 'SELECT pg_try_advisory_lock($1::bigint) AS locked',[key]) as {locked?:boolean}|undefined;
    } catch (error) {
      if (captured.move && error instanceof Error && 'code' in error && error.code === '55P03') {
        throw new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_CHANGED', { cause: error });
      }
      throw error;
    }
    if (locked?.locked !== true) fail('JOB_LIFECYCLE_CHANGED');
    // The held workspace session lease permits only this genuine Claim's
    // exact durable P0, or its actual historical B1 without a new P0.
    const prefix = `"${captured.binding.source.schemaName.replaceAll('"','""')}"`;
    const row = captured.move ? await readWorkspaceOperationOriginalMoveIntentOnConnection(database,
      {schema:captured.binding.source.schemaName,batchId:captured.binding.batchId}) : null;
    const intent = row ? parseWorkspaceOperationOriginalMoveIntent(row,captured.move!.context) : null;
    const admission = await readWorkspaceOperationNativePathAdmissionOnConnection(database,captured.claim);
    if (admission?.outcome?.version === 2 || admission?.status === 'cancelled') throw captured.move
      ? new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_CHANGED') : new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_CHANGED');
    if (admission && !['reserved','draining'].includes(admission.status)
      && !(captured.move && intent && admission.status === 'committed' && admission.outcome?.version === 1)) fail('JOB_LIFECYCLE_CHANGED');
    if ((captured.binding.plan.version === 6 || captured.binding.plan.version === 5 || (captured.binding.plan.version === 2 || captured.binding.plan.version === 3)
      && (captured.binding.plan.planIdentityVersion === 2 || captured.binding.plan.planIdentityVersion === 3
        || captured.binding.plan.version === 3 && captured.binding.plan.planIdentityVersion === 4)) && !admission && !intent) {
      const historical = !captured.move && await database.get(`SELECT 1 AS present FROM ${prefix}.workspace_file_operation_delete_intents WHERE batch_id=$1`,[captured.binding.batchId]);
      if (!historical) fail('JOB_LIFECYCLE_CHANGED');
    }
    const own = admission ? captureCollaborationAdmissionRequest(admission.request)
      : intent ? captureCollaborationAdmissionRequest(moveRequest(captured,intent)) : null;
    const active = await database.all(`SELECT DISTINCT CASE WHEN octet_length(r.request_id)=36 THEN r.request_id END AS request_id,
      CASE WHEN octet_length(r.request_digest)=64 THEN r.request_digest END AS request_digest,
      CASE WHEN octet_length(r.intent_text)=$2 AND octet_length(r.intent_text)<=16777216 THEN r.intent_text END AS intent_text
      FROM ${prefix}.collaboration_admission_scopes s JOIN ${prefix}.collaboration_admission_requests r USING(request_id)
      WHERE s.workspace_id=$1 AND r.status NOT IN('committed','cancelled') LIMIT 3`,
    [input.workspaceId,own ? Buffer.byteLength(own.intentText) : 0]) as Array<{request_id:string|null;request_digest:string|null;intent_text:string|null}>;
    if (active.some(item => !own || item.request_id !== own.request.requestId || item.request_digest !== own.requestDigest || item.intent_text !== own.intentText)
      || active.length > 1) fail('JOB_LIFECYCLE_CHANGED');
    for (const room of captured.nativePaths!.guards) {
      const result = await database.get('SELECT pg_try_advisory_lock($1::bigint) AS locked',[room]) as {locked?:boolean}|undefined;
      if (result?.locked !== true) fail('JOB_LIFECYCLE_CHANGED');
    }
    const rows = await database.all(`SELECT document_id,room_owner_token,room_owner_backend_pid,room_owner_backend_start
      FROM ${prefix}.collaboration_yjs_states WHERE workspace_id=$1 AND status='active' ORDER BY document_id COLLATE "C" LIMIT 1025`,[input.workspaceId]) as Array<Record<string,unknown>>;
    const rowsById = new Map(rows.map(row => [row.document_id,row])), expectedIds = new Set(captured.nativePaths!.documentIds);
    if (rows.length !== expectedIds.size || rowsById.size !== rows.length || rows.some(row => !expectedIds.has(row.document_id as string) || row.room_owner_token !== null
      || row.room_owner_backend_pid !== null || row.room_owner_backend_start !== null
      || getCollaborationRoomConnectionCount(String(row.document_id)) > 0)) fail('JOB_LIFECYCLE_CHANGED');
    const leases = new Map(getWorkspaceFileLifecycleLeases() ?? []); leases.set(input.workspaceId,lease);
    return await withWorkspaceFileLifecycleLeases(leases,callback);
  } finally {
    lease.active = false; closed = true;
    await database.close(new Error('Discarding original Move dedicated session.'));
  }
}

/** Fixed Move owner; the private actual B never leaves this module. */
export function withWorkspaceOperationNativeMoveJobOwner<T>(claim: WorkspaceOperationBatchClaim,
  operation: (owner: WorkspaceOperationNativeMoveJobOwner) => Promise<T>,
  openConnection: () => Promise<SqlConnection> = openDb, mcp?: WorkspaceOperationMcpJobPrincipal): Promise<T> {
  if (typeof operation !== 'function') return Promise.reject(new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_INVALID'));
  return withLifecycleOwner(claim, owner => operation(owner as unknown as WorkspaceOperationNativeMoveJobOwner),openConnection,true,mcp);
}
export function readWorkspaceOperationOriginalMoveJobReceipts(owner: WorkspaceOperationNativeMoveJobOwner) {
  try {
  const captured = moveOwner(owner);
  return movePhase(owner,async (_access,database) => readMoveRows(captured,database));
  } catch (error) { return rejectMoveBoundary(owner,error); }
}

/** Fresh owner-bound namespace basis before the first descriptor preparation.
 * The durable intent will independently capture the actual B1 observation. */
export function readWorkspaceOperationOriginalMovePreparation(owner: WorkspaceOperationNativeMoveJobOwner) {
  try {
    const captured = moveOwner(owner);
    return movePhase(owner, async (access, database) => {
      const plan = captured.move!.context.plan;
      if (plan.planIdentityVersion !== 2 && plan.planIdentityVersion !== 3 && plan.planIdentityVersion !== 4) return plan.sourceEvidence;
      const rows = await readMoveRows(captured, database);
      if (rows.intent || rows.completion) fail('JOB_LIFECYCLE_CHANGED');
      const preparation = await readWorkspaceOperationOriginalMovePreparationOnConnection(database,
        {schema:captured.binding.source.schemaName,context:captured.move!.context,readOnly:true});
      const admission = await readWorkspaceOperationNativePathAdmissionOnConnection(database,captured.claim);
      if (!preparation || !admission || !['reserved','draining'].includes(admission.status)) fail('JOB_LIFECYCLE_CHANGED');
      const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace,
        { physicalParserVersion: deriveWorkspacePathPhysicalParserVersion(plan.sourceEvidence) });
      const currentWitness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, observation, plan.sourceEvidence.workspaceScope);
      if (!equal(currentWitness,preparation.preparation.currentWitness)) throw new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_CHANGED');
      return preparation.preparation.currentWitness;
    });
  } catch (error) { return rejectMoveBoundary(owner, error); }
}

/** Internal fixed collector seam. A different B, detached phase, missing cap,
 * stale receipt, replaced source leaf or journal mismatch cannot mint an overlay. */
export async function readWorkspaceOperationOriginalMoveSourcesContext(database: SqlConnection) {
  const captured = context.getStore(), phase = phaseContext.getStore();
  if (!captured?.move || !phase || current(captured) !== database) fail('JOB_LIFECYCLE_REQUIRED');
  checkPhase(captured,phase);
  const rows = await readMoveRows(captured,database); checkPhase(captured,phase);
  if (!rows.intent || rows.completion || captured.move.preparedSteps.length !== rows.intent.steps.length
    || rows.pathRows.length !== rows.intent.steps.length) fail('JOB_LIFECYCLE_CHANGED');
  const preparedSteps = captured.move.preparedSteps;
  const assertCurrent = async () => {
    checkPhase(captured,phase); await checkOwner(captured,phase.transaction); checkPhase(captured,phase);
    for (const step of rows.intent!.steps) {
      const prepared = preparedSteps.find(item => item.stepKey === step.stepKey), row = rows.pathRows.find(item => item.stepKey === step.stepKey);
      if (!prepared?.receipt || !row || preparedWorkspacePathMoveProof(readPreparedWorkspacePathMove(prepared.cap)) !== step.originalProof
        || !equal(decodeWorkspaceOperationOriginalMovePathReceipt(row,rows.intent!,rows.parentRows).physical,prepared.receipt)) fail('JOB_LIFECYCLE_CHANGED');
      await assertPreparedWorkspacePathMoveReceiptCurrent(prepared.cap,prepared.receipt); checkPhase(captured,phase);
    }
    await checkOwner(captured,phase.transaction); checkPhase(captured,phase);
  };
  await assertCurrent();
  return Object.freeze({context:rows.context,intent:rows.intent,parentRows:rows.parentRows,pathRows:rows.pathRows,
    preparedSteps:Object.freeze(preparedSteps.map(item => Object.freeze({stepKey:item.stepKey,cap:item.cap,receipt:item.receipt!}))),
    nativeReceipts:captured.move.nativePhase === phase ? captured.move.nativeReceipts ?? Object.freeze([]) : Object.freeze([]),
    namespaceReceipt:captured.move.nativePhase === phase ? captured.move.namespaceReceipt ?? null : null,assertCurrent});
}
export function readOriginalNativeMoveSources(owner: WorkspaceOperationNativeMoveJobOwner, mode:'original'|'final') {
  try {
  const captured = moveOwner(owner); if (mode !== 'original' && mode !== 'final') fail('JOB_LIFECYCLE_INVALID');
  return movePhase(owner,async (access,database) => {
    const { readWorkspaceOperationOriginalMoveSourcesOnConnection } = await import('./workspace-operation-original-move-sources');
    current(captured); return readWorkspaceOperationOriginalMoveSourcesOnConnection(database,access.workspace,mode);
  });
  } catch (error) { return rejectMoveBoundary(owner,error); }
}

export function stageWorkspaceOperationOriginalMoveJob(owner: WorkspaceOperationNativeMoveJobOwner,
  input: Readonly<{preparedSteps:readonly Readonly<{stepKey:string;cap:PreparedWorkspacePathMove}>[]}>) {
  try {
  const captured = moveOwner(owner), fields = moveFields(input,['preparedSteps']);
  const prepared = captureMovePrepared(fields.preparedSteps as readonly MovePrepared[],false);
  const physical = prepared.map(item => readPreparedWorkspacePathMove(item.cap));
  return movePhase(owner,async (access,database,check) => {
    const phase = captured.phase, startedAt = phase?.startedMonotonic ?? performance.now();
    const queriesBefore = phase?.queriesBefore ?? captured.forwardedQueries;
    const milestones: Array<Readonly<{ stage: string; elapsedMs: number; forwardedQueries: number }>> = [];
    const mark = (stage: string) => { milestones.push({ stage, elapsedMs: Math.round(performance.now() - startedAt),
      forwardedQueries: captured.forwardedQueries - queriesBefore }); };
    mark('stage-enter');
    try {
      const { captureWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection } = await import('./workspace-operation-original-move-namespace-effects');
      for (const item of prepared) { await assertPreparedWorkspacePathMoveCurrent(item.cap); await check(); }
      mark('file-capabilities-checked');
      const plan = captured.move!.context.plan;
      const existing = await readMoveRows(captured,database);
      mark('original-rows-read');
      const preparation = plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4 ? await readWorkspaceOperationOriginalMovePreparationOnConnection(database,
        {schema:captured.binding.source.schemaName,context:captured.move!.context,readOnly:true}) : null;
      mark('preparation-read');
      if ((plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4) && !preparation && !existing.intent) fail('JOB_LIFECYCLE_CHANGED');
      const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database,access.workspace,
        { physicalParserVersion: deriveWorkspacePathPhysicalParserVersion(plan.sourceEvidence) });
      mark('source-collected');
      const currentWitness = plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4
        ? captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan,observation,plan.sourceEvidence.workspaceScope) : null;
      if (!currentWitness) assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan,observation,plan.sourceEvidence.workspaceScope);
      if (preparation && !equal(currentWitness,preparation.preparation.currentWitness)) throw new WorkspaceOperationNativeMovePlanError('NATIVE_MOVE_PLAN_CHANGED');
      mark('witness-checked');
      const namespaceState = await captureWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection(database,{
        schema:captured.binding.source.schemaName,workspace:access.workspace,context:captured.move!.context,
        observation,...(currentWitness ? {currentWitness} : {})});
      mark('namespace-captured');
      // A legitimate null bundle is also final P0 data. Do not use ?? here:
      // it would silently prepare new deltas for that original null arm.
      const nativeBundle = preparation ? preparation.nativeBundleData
        : buildMoveNativeBundle(captured.move!.context,observation,currentWitness ?? plan.sourceEvidence);
      const intent = createWorkspaceOperationOriginalMoveIntent({physical,nativeBundle,namespaceState,
        ...(currentWitness ? {currentWitness:preparation ? preparation.preparation.currentWitness : currentWitness} : {})},captured.move!.context);
      const request = moveRequest(captured,intent);
      mark('intent-created');
      if (preparation) {
        const admission = await readWorkspaceOperationNativePathAdmissionOnConnection(database,captured.claim);
        if (!admission || !['reserved','draining'].includes(admission.status)
          || !equal(captureCollaborationAdmissionRequest(request),captureCollaborationAdmissionRequest(preparation.request))
          || !equal(captureCollaborationAdmissionRequest(request),captureCollaborationAdmissionRequest(admission.request))) fail('JOB_LIFECYCLE_CHANGED');
      }
      mark('admission-read');
      if (existing.intentRow) {
        if (existing.intentRow.intentText !== moveJson(intent)) fail('JOB_LIFECYCLE_CHANGED');
        return existing;
      }
      const inserted = await insertWorkspaceOperationOriginalMoveIntentOnConnection(database,{schema:captured.binding.source.schemaName,
        batchId:intent.batchId,planId:intent.planId,workspaceId:captured.binding.workspaceId,requestHash:intent.requestHash,intentText:moveJson(intent)});
      if (inserted.kind === 'conflict') fail('JOB_LIFECYCLE_CHANGED');
      mark('intent-inserted');
      const bundle = readWorkspaceOperationOriginalMoveNativeBundle(intent);
      if (bundle) {
        const staged = await stageNativeFileOperationBundleOnConnection(database,bundle);
        if (staged.changesBundleProof !== intent.nativeBundle!.changesBundleProof || staged.actionPayloadText !== intent.nativeBundle!.actionPayloadText) fail('JOB_LIFECYCLE_CHANGED');
      }
      mark('native-staged');
      const reserved = await reserveCollaborationAdmissionOnConnection(database,request);
      if (!['reserved','draining'].includes(reserved.status)) fail('JOB_LIFECYCLE_CHANGED');
      mark('admission-reserved');
      // DA03 proofs are retained protocol facts. The runner must complete its
      // fixed proof groups after this stage commits, before any physical move.
      const result = await readMoveRows(captured,database); mark('final-rows-read'); return result;
    } finally {
      // This callback has not committed; report only bounded phase timings/counts.
      try { console.info('[File action owner] Move stage timings.', JSON.stringify({ version: 1,
        phaseIndex: phase?.index ?? null, elapsedMs: Math.round(performance.now() - startedAt),
        forwardedQueries: captured.forwardedQueries - queriesBefore, milestones })); }
      catch { /* Preserve the original operation result. */ }
    }
  });
  } catch (error) { return rejectMoveBoundary(owner,error); }
}

function moveFields(input: unknown, keys: readonly string[]): Record<string,unknown> {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
    || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key))) fail('JOB_LIFECYCLE_INVALID');
  return Object.fromEntries(keys.map(key => {const descriptor = Object.getOwnPropertyDescriptor(input,key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) fail('JOB_LIFECYCLE_INVALID'); return [key,descriptor.value];}));
}
function moveStep(captured: Capture, input: unknown, keys: readonly string[]) {
  const fields = moveFields(input,keys), stepKey = fields.stepKey, cap = fields.cap as PreparedWorkspacePathMove;
  if (typeof stepKey !== 'string' || !/^path:[0-9]{4}$/u.test(stepKey)) fail('JOB_LIFECYCLE_INVALID');
  const original = readPreparedWorkspacePathMove(cap);
  if (original.workspace.workspaceId !== captured.binding.workspaceId) fail('JOB_LIFECYCLE_INVALID');
  return {fields,stepKey,cap,proof:preparedWorkspacePathMoveProof(original)};
}
/** One bounded DA03 group on the genuine continuous Owner B. The runner
 * always starts at zero for fresh and recovered intents before physical work.
 * This is one ordinary tracked movePhase, never a multi-phase owner promise. */
export function proveWorkspaceOperationOriginalMoveJobQuiescenceGroup(owner: WorkspaceOperationNativeMoveJobOwner,
  input: Readonly<{expectedIntentDigest:string;preparedSteps:readonly Readonly<{stepKey:string;cap:PreparedWorkspacePathMove}>[];documentOffset:number}>) {
  try {
  const captured = moveOwner(owner), fields = moveFields(input,['expectedIntentDigest','preparedSteps','documentOffset']);
  const prepared = captureMovePrepared(fields.preparedSteps as readonly MovePrepared[],false);
  const expectedIntentDigest = fields.expectedIntentDigest, documentOffset = fields.documentOffset;
  const groupSize = 8;
  if (typeof expectedIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedIntentDigest)
    || typeof documentOffset !== 'number' || !Number.isSafeInteger(documentOffset) || Object.is(documentOffset,-0)
    || documentOffset < 0 || documentOffset > 1024 || documentOffset % groupSize !== 0) fail('JOB_LIFECYCLE_INVALID');
  return movePhase(owner,async (_access,database,check) => {
    const phase = captured.phase, startedAt = phase?.startedMonotonic ?? performance.now();
    const queriesBefore = phase?.queriesBefore ?? captured.forwardedQueries;
    let count = 0, finishedCallback = false;
    try {
      const rows = await readMoveRows(captured,database), intent = rows.intent;
      if (!intent || !rows.intentRow || rows.completion || rows.intentRow.intentDigest !== expectedIntentDigest
        || intent.steps.length !== prepared.length || intent.steps.some((step,index) =>
          step.stepKey !== prepared[index].stepKey || !equal(step.physical,readPreparedWorkspacePathMove(prepared[index].cap)))) fail('JOB_LIFECYCLE_CHANGED');
      // Cap/original binding above remains exact. Payload verification stays
      // at the existing Stage/recovery and immediate pre-move FD boundaries;
      // a protocol-only proof group must not rehash every selected payload.
      const request = moveRequest(captured,intent), bound = captureCollaborationAdmissionRequest(request);
      if (documentOffset > request.expectedDocuments.length
        || request.expectedDocuments.length > 0 && documentOffset === request.expectedDocuments.length) fail('JOB_LIFECYCLE_INVALID');
      const end = Math.min(documentOffset + groupSize,request.expectedDocuments.length);
      count = end - documentOffset;
      for (const document of request.expectedDocuments.slice(documentOffset,end)) {
        await proveCollaborationAdmissionQuiescenceOnConnection(database,request,document.documentId); await check();
      }
      // Per-document proofs keep their original Header -> Target -> State path.
      // Check the full actual target set without interpreting DB collation as
      // JavaScript ordering. All mutation guards remain continuously held on B.
      const header = await database.get('SELECT * FROM collaboration_admission_requests WHERE request_id=$1 FOR SHARE',
        [request.requestId]) as Record<string,unknown>|undefined;
      const revision = Number(header?.revision);
      if (!header || header.request_digest !== bound.requestDigest || header.intent_text !== bound.intentText
        || !['reserved','draining'].includes(header.status as string) || header.outcome_text !== null || header.completed_at !== null
        || !Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER
        || request.expectedDocuments.length > 0 && header.status !== 'draining') fail('JOB_LIFECYCLE_CHANGED');
      const targets = await database.all(`SELECT document_id,active,status,quiescence_text IS NOT NULL AS has_proof
        FROM collaboration_admission_targets WHERE request_id=$1
        ORDER BY document_id COLLATE "C" LIMIT $2 FOR SHARE`,[request.requestId,request.expectedDocuments.length+1]) as Array<Record<string,unknown>>;
      const expectedIds = new Set(request.expectedDocuments.map(document => document.documentId));
      if (targets.length !== expectedIds.size || new Set(targets.map(row => row.document_id)).size !== targets.length
        || targets.some(row => !expectedIds.has(row.document_id as string) || row.active !== true
          || !['reserved','draining','released'].includes(row.status as string)
          || end === request.expectedDocuments.length && (row.status !== 'released' || row.has_proof !== true))) fail('JOB_LIFECYCLE_CHANGED');
      await check(); finishedCallback = true;
      return end < request.expectedDocuments.length ? end : null;
    } finally {
      // Callback timing only: the existing owner still confirms COMMIT later.
      try { console.info('[File action owner] Move quiescence group timings.', JSON.stringify({version:1,
        offset:documentOffset,count,phaseIndex:phase?.index ?? null,
        elapsedMs:Math.round(performance.now()-startedAt),forwardedQueries:captured.forwardedQueries-queriesBefore,finishedCallback})); }
      catch { /* Preserve the original operation result. */ }
    }
  });
  } catch (error) { return rejectMoveBoundary(owner,error); }
}

export function recordWorkspaceOperationOriginalMoveJobParentReceipt(owner: WorkspaceOperationNativeMoveJobOwner,
  input: Readonly<{stepKey:string;cap:PreparedWorkspacePathMove;birth:PreparedWorkspacePathMoveParentReceipt}>) {
  try {
  const captured = moveOwner(owner), fields = moveFields(input,['stepKey','cap','birth']);
  const cap = fields.cap as PreparedWorkspacePathMove, stepKey = fields.stepKey;
  if (typeof stepKey !== 'string' || !/^path:[0-9]{4}$/u.test(stepKey)) fail('JOB_LIFECYCLE_INVALID');
  const actualBirth = fields.birth as PreparedWorkspacePathMoveParentReceipt;
  assertPreparedWorkspacePathMoveParentReceipt(cap,actualBirth);
  const selected = {stepKey,cap,proof:actualBirth.originalProof};
  const birth = JSON.parse(moveJson(actualBirth)) as PreparedWorkspacePathMoveParentReceipt;
  return movePhase(owner,async (_access,database) => {
    const rows = await readMoveRows(captured,database), intent = rows.intent;
    if (!intent || !rows.intentRow || rows.completion || !intent.steps.some(step => step.stepKey === selected.stepKey && step.originalProof === selected.proof)) fail('JOB_LIFECYCLE_CHANGED');
    assertPreparedWorkspacePathMoveParentReceipt(selected.cap,actualBirth);
    const planned = intent.parents.find(parent => parent.parentPath === birth.relativePath && parent.producerStep === selected.stepKey);
    if (!planned) fail('JOB_LIFECYCLE_CHANGED');
    const receiptText = moveJson({version:1,batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,
      parentPath:planned.parentPath,producerStep:planned.producerStep,consumers:planned.consumers,birth});
    const candidate: WorkspaceOperationOriginalMoveParentReceipt = {batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,
      parentKey:moveHash(planned.parentPath),parentPath:planned.parentPath,producerStep:planned.producerStep,
      consumerBindingsText:moveJson(planned.consumers),consumerBindingsDigest:moveHash(moveJson(planned.consumers)),
      receiptText,receiptDigest:moveHash(receiptText),createdAt:0};
    decodeWorkspaceOperationOriginalMoveParentReceipt(candidate,intent);
    const inserted = await insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(database,{schema:captured.binding.source.schemaName,
      batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,parentPath:planned.parentPath,producerStep:planned.producerStep,
      consumerBindingsText:moveJson(planned.consumers),receiptText});
    if (inserted.kind === 'conflict') fail('JOB_LIFECYCLE_CHANGED');
    decodeWorkspaceOperationOriginalMoveParentReceipt(inserted.row,intent); return inserted.row;
  });
  } catch (error) { return rejectMoveBoundary(owner,error); }
}
export function recordWorkspaceOperationOriginalMoveJobPathReceipt(owner: WorkspaceOperationNativeMoveJobOwner,
  input: Readonly<{stepKey:string;cap:PreparedWorkspacePathMove;receipt:PreparedWorkspacePathMoveReceipt}>) {
  try {
  const captured = moveOwner(owner), selected = moveStep(captured,input,['stepKey','cap','receipt']);
  const receipt = selected.fields.receipt as PreparedWorkspacePathMoveReceipt;
  // Cost/capture caller data before the phase's first await. Actual capability
  // equality is still required below; a decoded DTO never grants publication.
  const physical = JSON.parse(moveJson(receipt)) as PreparedWorkspacePathMoveReceipt;
  return movePhase(owner,async (_access,database,check) => {
    await assertPreparedWorkspacePathMoveReceiptCurrent(selected.cap,receipt); await check();
    const rows = await readMoveRows(captured,database), intent = rows.intent;
    const step = intent?.steps.find(item => item.stepKey === selected.stepKey);
    if (!intent || !rows.intentRow || rows.completion || !step || step.originalProof !== selected.proof) fail('JOB_LIFECYCLE_CHANGED');
    const parentReceipts = step.physical.source.kind === 'projection_absent' ? [] : intent.parents.filter(parent => parent.consumers.some(item => item.stepKey === step.stepKey)).map(parent => {
      const row = rows.parentRows.find(item => item.parentPath === parent.parentPath); if (!row) fail('JOB_LIFECYCLE_CHANGED');
      return {parentPath:parent.parentPath,receiptDigest:row.receiptDigest};
    });
    const receiptText = moveJson({version:1,batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,
      stepKey:step.stepKey,originalProof:step.originalProof,physical,parentReceipts});
    const candidate = {batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,stepKey:step.stepKey,
      receiptText,receiptDigest:moveHash(receiptText),createdAt:0};
    decodeWorkspaceOperationOriginalMovePathReceipt(candidate,intent,rows.parentRows);
    const inserted = await insertWorkspaceOperationOriginalMovePathReceiptOnConnection(database,{schema:captured.binding.source.schemaName,
      batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,stepKey:step.stepKey,receiptText});
    if (inserted.kind === 'conflict') fail('JOB_LIFECYCLE_CHANGED');
    await assertPreparedWorkspacePathMoveReceiptCurrent(selected.cap,receipt); await check();
    decodeWorkspaceOperationOriginalMovePathReceipt(inserted.row,intent,rows.parentRows); return inserted.row;
  });
  } catch (error) { return rejectMoveBoundary(owner,error); }
}

/** These fixed native triggers use SET LOCAL search_path. Restore only their
 * exact canonical literal after checking the actual B, XID and schema OID.
 * Every ordinary Owner/Claim/Policy/Handoff comparison remains exact. */
async function fixedMoveSideEffect<T>(captured: Capture, database: SqlConnection, operation: () => Promise<T>): Promise<T> {
  const before = await identity(database,true), phase = captured.phase!;
  if (!sameIdentity(before.identity,captured.identity!) || before.transaction !== phase.transaction) fail('JOB_LIFECYCLE_CHANGED');
  const expected = await database.get(`SELECT pg_catalog.quote_ident(nspname)||', pg_catalog, pg_temp' AS literal
    FROM pg_catalog.pg_namespace WHERE oid=$1::oid`,[captured.binding.source.schemaOid]) as {literal?:string}|undefined;
  if (typeof expected?.literal !== 'string') fail('JOB_LIFECYCLE_CHANGED');
  const result = await operation();
  const after = await identity(database,false);
  if (after.transaction !== phase.transaction || !sameIdentity({...after.identity,searchPath:before.identity.searchPath},before.identity)
    || ![before.identity.searchPath,expected.literal].includes(after.identity.searchPath)) fail('JOB_LIFECYCLE_CHANGED');
  if (after.identity.searchPath !== before.identity.searchPath) {
    await database.get("SELECT pg_catalog.set_config('search_path',$1,true) AS restored",[before.identity.searchPath]);
    const restored = await identity(database,false);
    if (!sameIdentity(restored.identity,before.identity) || restored.transaction !== phase.transaction) fail('JOB_LIFECYCLE_CHANGED');
  }
  current(captured); return result;
}

export function completeWorkspaceOperationOriginalMoveJob(owner: WorkspaceOperationNativeMoveJobOwner,
  input: Readonly<{preparedSteps:readonly Readonly<{stepKey:string;cap:PreparedWorkspacePathMove;receipt:PreparedWorkspacePathMoveReceipt}>[]}>) {
  try {
  const captured = moveOwner(owner), fields = moveFields(input,['preparedSteps']);
  const prepared = captureMovePrepared(fields.preparedSteps as readonly MovePrepared[],true);
  captured.move!.preparedSteps = prepared;
  return movePhase(owner,async (access,database,check) => {
    const timingPhase = captured.phase;
    const timingClock = () => { try { return performance.now(); } catch { return 0; } };
    const timingStartedAt = timingPhase?.startedMonotonic ?? timingClock();
    const timingQueriesBefore = timingPhase?.queriesBefore ?? captured.forwardedQueries;
    const timingMilestones: Array<Readonly<{ stage: string; elapsedMs: number; forwardedQueries: number }>> = [];
    let timingStage = 'initial-rows', timingFinishedCallback = false;
    let timingMutationsCount = 0, timingMutationsCompleted = 0;
    let timingMutationStartedAt: number | null = null, timingMutationElapsedMs = 0, timingMutationMaxMs = 0;
    let timingNativeSideEffectsMs: number | null = null, timingReceiptProofMs: number | null = null;
    let timingNamespaceMs: number | null = null, timingFinalSourceMs: number | null = null;
    const timingMark = (stage: string) => {
      try {
        if (timingMilestones.length < 12) timingMilestones.push({ stage,
          elapsedMs: Math.max(0, Math.round(timingClock() - timingStartedAt)),
          forwardedQueries: captured.forwardedQueries - timingQueriesBefore });
      } catch { /* Diagnostics cannot replace the original operation result/error. */ }
    };
    timingMark('b2-enter');
    try {
    const rows = await readMoveRows(captured,database), intent = rows.intent;
    if (!intent || !rows.intentRow || rows.completion || rows.pathRows.length !== intent.steps.length) fail('JOB_LIFECYCLE_CHANGED');
    timingMark('original-rows-read'); timingStage = 'original-context';
    const source = await readWorkspaceOperationOriginalMoveSourcesContext(database); await source.assertCurrent(); await check();
    timingStage = 'original-bundle';
    const request = moveRequest(captured,intent), bundle = readWorkspaceOperationOriginalMoveNativeBundle(intent);
    timingMutationsCount = bundle?.mutations.length ?? 0; timingMark('original-context-ready');
    captured.move!.nativePhase = captured.phase; captured.move!.nativeReceipts = Object.freeze([]); captured.move!.namespaceReceipt = null;
    let native: WorkspaceOperationOriginalMoveCompletionData['native'] = null;
    let namespaceEffects: WorkspaceOperationOriginalMoveCompletionData['namespaceEffects'] = null;
    const { readWorkspaceOperationOriginalMoveSourcesOnConnection } = await import('./workspace-operation-original-move-sources');
    const { applyWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection } = await import('./workspace-operation-original-move-namespace-effects');
    await executeCollaborationAdmissionHandoffOnConnection(database,request,{kind:'apply',
      authorize:async () => { await check(); },
      prepare:async connection => {
        timingStage = 'prepare-authority'; timingMark('prepare-enter');
        if (connection !== database) fail('JOB_LIFECYCLE_CHANGED');
        await check(); await source.assertCurrent();
        timingStage = 'original-source';
        await readWorkspaceOperationOriginalMoveSourcesOnConnection(database,access.workspace,'original');
        timingMark('original-source-read');
        if (bundle) {
          timingStage = 'staged-binding';
          const staged = await readStagedNativeFileOperationBindingOnConnection(database,{request,operationId:bundle.operationId});
          if (staged.changesBundleProof !== intent.nativeBundle!.changesBundleProof) fail('JOB_LIFECYCLE_CHANGED');
          timingMark('staged-binding-read');
          if (bundle.mutations.some(mutation => mutation.kind !== 'link')) {
            timingStage = 'side-effect-capture';
            await fixedMoveSideEffect(captured,database,() => captureNativeFileOperationSideEffectsOnConnection(database,{workspace:access.workspace,request,operationId:bundle.operationId}));
            timingMark('side-effects-captured');
          }
        }
        timingStage = 'prepare-exit';
        await check();
      },
      mutate:async connection => {
        timingStage = 'mutate-authority'; timingMark('mutate-enter');
        if (connection !== database) fail('JOB_LIFECYCLE_CHANGED');
        await check(); await source.assertCurrent();
        const result: Record<string,string> = {};
        if (bundle) {
          const receipts = [];
          for (const mutation of bundle.mutations) {
            timingStage = 'native-mutation'; timingMutationStartedAt = timingClock();
            await check();
            const applied = await applyNativeFileOperationMutationOnConnection(database,{workspace:access.workspace,action:bundle.action,
              operationId:bundle.operationId,mutationId:mutation.mutationId});
            receipts.push({mutationId:mutation.mutationId,receiptDigest:applied.receiptDigest});
            captured.move!.nativeReceipts = Object.freeze([...captured.move!.nativeReceipts!,applied.receipt]); await check();
            const timingMutationMs = Math.max(0, timingClock() - timingMutationStartedAt);
            timingMutationElapsedMs += timingMutationMs; timingMutationMaxMs = Math.max(timingMutationMaxMs, timingMutationMs);
            timingMutationsCompleted++; timingMutationStartedAt = null;
          }
          timingMark('mutations-applied');
          let sideEffectReceiptDigest: string|null = null;
          if (bundle.mutations.some(mutation => mutation.kind !== 'link')) {
            timingStage = 'native-side-effects'; const timingSectionStartedAt = timingClock();
            const effects = await fixedMoveSideEffect(captured,database,() => applyNativeFileOperationSideEffectsOnConnection(database,{workspace:access.workspace,operationId:bundle.operationId}));
            result.nativeFileSideEffectSetProof = effects.nativeFileSideEffectSetProof;
            const row = await database.get('SELECT receipt_digest FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=$1 FOR SHARE',[bundle.operationId]) as {receipt_digest?:unknown}|undefined;
            if (typeof row?.receipt_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.receipt_digest)) fail('JOB_LIFECYCLE_CHANGED');
            sideEffectReceiptDigest = row.receipt_digest;
            timingNativeSideEffectsMs = Math.max(0, Math.round(timingClock() - timingSectionStartedAt));
          }
          timingStage = 'receipt-proof'; const timingProofStartedAt = timingClock();
          result.nativeFileReceiptSetProof = await nativeFileOperationReceiptSetProofOnConnection(database,bundle.action,bundle.operationId);
          timingReceiptProofMs = Math.max(0, Math.round(timingClock() - timingProofStartedAt));
          native = {operationId:bundle.operationId,requestId:bundle.requestId,changesBundleProof:intent.nativeBundle!.changesBundleProof,
            receipts,sideEffectReceiptDigest};
        }
        timingStage = 'namespace'; const timingNamespaceStartedAt = timingClock();
        namespaceEffects = await applyWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection(database,{workspace:access.workspace,context:captured.move!.context,intent});
        timingNamespaceMs = Math.max(0, Math.round(timingClock() - timingNamespaceStartedAt));
        captured.move!.namespaceReceipt = namespaceEffects;
        await source.assertCurrent(); await check();
        timingStage = 'final-source'; const timingFinalSourceStartedAt = timingClock();
        await readWorkspaceOperationOriginalMoveSourcesOnConnection(database,access.workspace,'final');
        timingFinalSourceMs = Math.max(0, Math.round(timingClock() - timingFinalSourceStartedAt));
        await check();
        timingStage = 'handoff-outcome';
        return result;
      }}).finally(() => { captured.move!.namespaceReceipt = null; });
    timingMark('da04-done'); timingStage = 'completion-authority';
    await check(); await source.assertCurrent();
    timingStage = 'completion-body';
    const completion: WorkspaceOperationOriginalMoveCompletionData = {version:1,batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,
      planId:intent.planId,compilerPlanProof:intent.compilerPlanProof,finalGraphProof:intent.finalGraphProof,
      parentReceipts:intent.parents.map(parent => ({parentPath:parent.parentPath,receiptDigest:rows.parentRows.find(row => row.parentPath === parent.parentPath)!.receiptDigest})),
      pathReceipts:intent.steps.map(step => ({stepKey:step.stepKey,receiptDigest:rows.pathRows.find(row => row.stepKey === step.stepKey)!.receiptDigest})),native,namespaceEffects};
    const receiptText = moveJson(completion), candidate = {batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,
      receiptText,receiptDigest:moveHash(receiptText),createdAt:0};
    decodeWorkspaceOperationOriginalMoveCompletion(candidate,intent,rows.parentRows,rows.pathRows);
    timingStage = 'completion-insert';
    const inserted = await insertWorkspaceOperationOriginalMoveReceiptOnConnection(database,{schema:captured.binding.source.schemaName,
      batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,receiptText});
    if (inserted.kind === 'conflict') fail('JOB_LIFECYCLE_CHANGED');
    timingMark('completion-ack'); timingStage = 'completion-validate';
    const completed = decodeWorkspaceOperationOriginalMoveCompletion(inserted.row,intent,rows.parentRows,rows.pathRows);
    timingStage = 'notify';
    await notifyWorkspaceFileInvalidationOnConnection(database, captured.binding.workspaceId);
    timingStage = 'callback-return'; timingFinishedCallback = true;
    return completed;
    } finally {
      // Callback/SQL-ACK diagnostics only: the owning transaction commits later.
      try {
        const activeMutationMs = timingMutationStartedAt === null ? null : Math.max(0, timingClock() - timingMutationStartedAt);
        console.info('[File action owner] Move B2 timings.', JSON.stringify({ version: 1,
          phaseIndex: timingPhase?.index ?? null, elapsedMs: Math.max(0, Math.round(timingClock() - timingStartedAt)),
          forwardedQueries: captured.forwardedQueries - timingQueriesBefore, currentStage: timingStage,
          finishedCallback: timingFinishedCallback, mutationsCount: timingMutationsCount,
          mutationsCompleted: timingMutationsCompleted, mutationElapsedMs: Math.round(timingMutationElapsedMs),
          mutationMaxMs: Math.round(timingMutationMaxMs), activeMutationMs: activeMutationMs === null ? null : Math.round(activeMutationMs),
          nativeSideEffectsMs: timingNativeSideEffectsMs, receiptProofMs: timingReceiptProofMs,
          namespaceMs: timingNamespaceMs, finalSourceMs: timingFinalSourceMs, milestones: timingMilestones }));
      } catch { /* Logger/serialization failures cannot replace the original result/error. */ }
    }
  });
  } catch (error) { return rejectMoveBoundary(owner,error); }
}

/** Authorized historical proof only. This opens no FS handle, acquires no room
 * or workspace guard and never replays physical/native/metadata operations. */
export function readWorkspaceOperationOriginalDeleteJobHistory(claim: WorkspaceOperationBatchClaim,
  openConnection: () => Promise<SqlConnection> = openDb, mcp?: WorkspaceOperationMcpJobPrincipal
): Promise<WorkspaceOperationOriginalDeleteResult | null> {
  if (context.getStore() || hasCollaborationHandoffExecutionContext()) return Promise.reject(new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REENTRANT'));
  const binding = readWorkspaceOperationBatchClaimBinding(claim), auth = binding.authorization, plan = binding.plan;
  if (binding.actionMode !== 'apply' || auth.mode !== 'direct' && auth.mode !== 'direct-mcp' || !auth.jobScope || auth.jobScope.legacy
    || plan.version === 3 || plan.version === 6 || plan.pathSteps.length !== 1 || plan.pathSteps[0].kind !== 'delete'
    || plan.workspaceId !== binding.workspaceId || plan.planId !== binding.planId) return Promise.reject(new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_INVALID'));
  const mcpPrincipal = captureMcpJobPrincipal(binding, mcp, false);
  return withWorkspaceOperationJobClaimPhase(claim, async () => {
    const policy = mcpPrincipal ? undefined : await captureWorkspaceOperationJobPolicy(), database = await openConnection();
    let begun = false, commitAttempted = false, failure: Error | undefined;
    try {
      await database.run("SET statement_timeout='5s'"); await database.run("SET lock_timeout='50ms'");
      const first = await identity(database, true), second = await identity(database, false);
      if (!sameIdentity(first.identity, second.identity) || second.transaction !== null
        || second.identity.database !== binding.source.databaseOid || second.identity.schema !== binding.source.schemaOid
        || second.identity.searchPath !== binding.source.searchPath) fail('JOB_LIFECYCLE_CHANGED');
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
      const started = await identity(database, true);
      if (!sameIdentity(started.identity, second.identity) || !started.transaction) fail('JOB_LIFECYCLE_CHANGED');
      const check = async () => {
        const now = await identity(database, false);
        if (!sameIdentity(now.identity, second.identity) || now.transaction !== started.transaction
          || readWorkspaceOperationBatchClaimBinding(claim) !== binding) fail('JOB_LIFECYCLE_CHANGED');
      };
      const authorize = (operation: (access: WorkspaceOperationJobPolicyAccess) => Promise<WorkspaceOperationOriginalDeleteResult | null>) => mcpPrincipal
        ? withWorkspaceOperationMcpJobPolicyOnConnection(database, { claim, principal: mcpPrincipal }, operation)
        : withWorkspaceOperationJobPolicyOnConnection(database, { claim, policy: policy! }, operation);
      const result = await authorize(async access => {
        const { schemaName, schemaOid, databaseOid } = binding.source;
        const storage = await bindWorkspaceOperationOriginalDeleteStorageOnConnection(database, { schemaName, schemaOid, databaseOid });
        await access.assertCurrent(); await check();
        const result = await readOriginalDeleteJobRows(database, binding, access);
        await access.assertCurrent(); await storage.assertCurrent(); await check(); return result;
      });
      await check(); commitAttempted = true; await database.run('COMMIT'); begun = false; return result;
    } catch (error) {
      failure = asError(error);
      if (begun) try { await database.run('ROLLBACK'); } catch (rollback) { failure = new AggregateError([failure, asError(rollback)]); }
      if (commitAttempted) failure = new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_COMMIT_UNCONFIRMED', { cause: failure });
      throw failure;
    } finally {
      try { await database.close(failure ?? new Error('Discarding original Delete historical proof session.')); }
      catch (close) { throw new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_DISPOSAL_UNCONFIRMED', {
        cause: failure ? new AggregateError([failure, asError(close)]) : close }); }
    }
  });
}

async function readOriginalDeleteJobRows(database: SqlConnection, binding: WorkspaceOperationBatchClaimBinding,
  access: WorkspaceOperationJobPolicyAccess): Promise<WorkspaceOperationOriginalDeleteResult | null> {
  const observed = await readWorkspaceOperationOriginalDeleteObservationOnConnection(database, { schema: binding.source.schemaName,
    context: { batchId: binding.batchId, planId: binding.planId, workspaceId: binding.workspaceId,
      authorization: binding.authorization, sourcePath: binding.plan.pathSteps[0].sourcePath },
    workspace: access.workspace, dataRoot: resolveWorkspaceDataRoot() });
  if (observed.original && (binding.plan.version === 2 || binding.plan.version === 5)) assertOriginalDeleteIntentPlan(observed.original, binding.plan);
  return observed.deleted;
}

/** Authorized historical Move proof, without current-path or room lookup. */
export function readWorkspaceOperationOriginalMoveJobHistory(claim: WorkspaceOperationBatchClaim,
  openConnection: () => Promise<SqlConnection> = openDb, mcp?: WorkspaceOperationMcpJobPrincipal): Promise<WorkspaceOperationOriginalMoveJobReceipts|null> {
  if (context.getStore() || hasCollaborationHandoffExecutionContext()) return Promise.reject(new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REENTRANT'));
  const binding = readWorkspaceOperationBatchClaimBinding(claim), captured = {binding,move:captureMove(binding)};
  const mcpPrincipal = captureMcpJobPrincipal(binding, mcp, true);
  return withWorkspaceOperationJobClaimPhase(claim,async () => {
    const policy = mcpPrincipal ? undefined : await captureWorkspaceOperationJobPolicy(), database = await openConnection();
    let begun = false, commitAttempted = false, failure: Error|undefined;
    try {
      const first = await identity(database,true), second = await identity(database,false);
      if (!sameIdentity(first.identity,second.identity) || second.transaction !== null
        || second.identity.database !== binding.source.databaseOid || second.identity.schema !== binding.source.schemaOid
        || second.identity.searchPath !== binding.source.searchPath) fail('JOB_LIFECYCLE_CHANGED');
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
      const started = await identity(database,true);
      if (!sameIdentity(started.identity,second.identity) || !started.transaction) fail('JOB_LIFECYCLE_CHANGED');
      const check = async () => {
        const now = await identity(database,false);
        if (!sameIdentity(now.identity,second.identity) || now.transaction !== started.transaction
          || readWorkspaceOperationBatchClaimBinding(claim) !== binding) fail('JOB_LIFECYCLE_CHANGED');
      };
      const authorize = (operation: (access: WorkspaceOperationJobPolicyAccess) => Promise<WorkspaceOperationOriginalMoveJobReceipts|null>) => mcpPrincipal
        ? withWorkspaceOperationMcpJobPolicyOnConnection(database,{claim,principal:mcpPrincipal},operation)
        : withWorkspaceOperationJobPolicyOnConnection(database,{claim,policy:policy!},operation);
      const result = await authorize(async access => {
        const {schemaName,schemaOid,databaseOid} = binding.source;
        const storage = await bindWorkspaceOperationOriginalMoveStorageOnConnection(database,{schemaName,schemaOid,databaseOid});
        await access.assertCurrent(); await check();
        const rows = await readMoveRows(captured,database);
        if (!rows.completion || !rows.intent) return null;
        const request = moveRequest(captured,rows.intent), outcome = await readHistoricalCollaborationAdmissionOutcomeOnConnection(database,captureCollaborationAdmissionRequest(request));
        if (!outcome || outcome.version !== 1) fail('JOB_LIFECYCLE_CHANGED');
        const bundle = readWorkspaceOperationOriginalMoveNativeBundle(rows.intent);
        if (bundle) {
          for (const reference of rows.completion.native!.receipts) {
            const native = await readHistoricalNativeFileOperationReceiptOnConnection(database,{request,operationId:bundle.operationId,mutationId:reference.mutationId});
            if (!native || native.receiptDigest !== reference.receiptDigest) fail('JOB_LIFECYCLE_CHANGED');
          }
          if (rows.completion.native!.sideEffectReceiptDigest !== null) {
            const effects = await readHistoricalNativeFileOperationSideEffectsOnConnection(database,{request,operationId:bundle.operationId,actor:bundle.actor});
            if (!effects) fail('JOB_LIFECYCLE_CHANGED');
            const side = await database.get('SELECT receipt_digest FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=$1',[bundle.operationId]) as {receipt_digest?:unknown}|undefined;
            if (side?.receipt_digest !== rows.completion.native!.sideEffectReceiptDigest) fail('JOB_LIFECYCLE_CHANGED');
          }
        }
        await access.assertCurrent(); await storage.assertCurrent(); await check(); return rows;
      });
      await check(); commitAttempted = true; await database.run('COMMIT'); begun = false; return result;
    } catch (error) {
      failure = asError(error);
      if (begun) try { await database.run('ROLLBACK'); } catch (rollback) { failure = new AggregateError([failure,asError(rollback)]); }
      if (commitAttempted) failure = new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_COMMIT_UNCONFIRMED',{cause:failure});
      throw failure;
    } finally {
      try { await database.close(failure ?? new Error('Discarding original Move historical proof session.')); }
      catch (close) { throw new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_DISPOSAL_UNCONFIRMED',{
        cause:failure ? new AggregateError([failure,asError(close)]) : close}); }
    }
  });
}

function rejectMoveBoundary(owner: WorkspaceOperationNativeMoveJobOwner, error: unknown): Promise<never> {
  const captured = owner && typeof owner === 'object' ? owners.get(owner as unknown as WorkspaceOperationJobLifecycleOwner) : undefined;
  const active = context.getStore(), failure = asError(error);
  if (captured) captured.failure ??= failure;
  if (active) active.failure ??= failure;
  return Promise.reject(failure);
}

function buildMoveNativeBundle(selected: WorkspaceOperationOriginalMoveContext, observation: WorkspaceLinkSourceAuthorityObservation,
  sourceEvidence: WorkspaceOperationAnyMixedSourceEvidence = selected.plan.sourceEvidence): WorkspaceOperationOriginalMoveNativeBundleData|null {
  try { return prepareWorkspaceOperationOriginalMoveNativeBundleData(selected, observation, sourceEvidence); }
  catch (error) {
    // Preserve this existing owner's failure contract after extracting its
    // preparation algorithm into the shared data codec.
    if (error instanceof WorkspaceOperationOriginalMoveCodecError && error.code === 'ORIGINAL_MOVE_CHANGED') fail('JOB_LIFECYCLE_CHANGED');
    throw error;
  }
}


/** Fixed current Cohort observation, including pending recovery. No caller can
 * select journal SQL, a workspace, a binding or historical/current authority. */
export function readWorkspaceOperationCohortDeleteObservationJob(owner: WorkspaceOperationJobLifecycleOwner): Promise<CohortDeleteObservation> {
  const captured = owners.get(owner);
  try {
    if (!captured || captured.move || captured.binding.plan.version !== 6 || captured.binding.actionMode !== 'apply') fail('JOB_LIFECYCLE_REQUIRED');
    current(captured);
    return withNativeInspectionSchema(() => runLifecycleTransaction(owner, undefined, (access, database, check) =>
      withOriginalDeleteDomainAccess(captured, database, access, check, domainAccess => {
        const binding = captured.binding;
        return readCohortDeleteObservationOnConnection(domainAccess.database,
          { schema: binding.source.schemaName, binding, workspace: domainAccess.workspace, dataRoot: resolveWorkspaceDataRoot() });
      }))).catch(error => poison(captured, error));
  } catch (error) {
    if (captured) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
    return Promise.reject(error);
  }
}

/** Fixed Cohort B1. The real Owner supplies the claimed binding, workspace and
 * actual transaction; callers supply only the genuine prepared descriptors. */
export function prepareWorkspaceOperationCohortDeleteJob(owner: WorkspaceOperationJobLifecycleOwner,
  input: Readonly<{ prepared: readonly CohortDeletePrepared[] }>):
Promise<Readonly<{ intent: CohortDeleteIntent; durable: WorkspaceOperationOriginalDeleteIntent }>> {
  const captured = owners.get(owner);
  try {
    if (!captured || captured.move || captured.binding.plan.version !== 6 || captured.binding.actionMode !== 'apply') fail('JOB_LIFECYCLE_REQUIRED');
    current(captured);
    const fields = moveFields(input, ['prepared']), prepared = fields.prepared as readonly CohortDeletePrepared[];
    const plan = captured.binding.plan;
    if (!Array.isArray(prepared) || prepared.length !== plan.pathSteps.length) fail('JOB_LIFECYCLE_INVALID');
    for (const [index, item] of prepared.entries()) {
      if (item.stepKey !== `path:${String(index).padStart(4, '0')}`
        || readPreparedWorkspacePathTrash(item.cap).canonicalPath !== plan.pathSteps[index].sourcePath) fail('JOB_LIFECYCLE_CHANGED');
    }
    return withNativeInspectionSchema(() => runLifecycleTransaction(owner, undefined, (access, database, check) =>
      withOriginalDeleteDomainAccess(captured, database, access, check, async domainAccess => {
        const binding = captured.binding, schema = binding.source.schemaName;
        const intent = await prepareCohortDeleteIntent(domainAccess, binding, prepared);
        const inserted = await insertWorkspaceOperationOriginalDeleteIntentOnConnection(domainAccess.database,
          { schema, batchId: binding.batchId, planId: binding.planId, workspaceId: binding.workspaceId,
            requestHash: intent.requestHash, intentText: JSON.stringify(intent) });
        if (inserted.kind !== 'created') return failCohortDelete('COHORT_DELETE_UNPROVEN');
        return { intent, durable: inserted.row };
      }))).catch(error => poison(captured, error));
  } catch (error) {
    if (captured) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
    return Promise.reject(error);
  }
}

/** Fixed pending proof before every remaining Cohort filesystem effect. The
 * original row and digest are expectations; the actual immutable journal selects
 * all intent facts afresh on the Owner transaction. */
export function assertWorkspaceOperationCohortDeletePendingJob(owner: WorkspaceOperationJobLifecycleOwner,
  input: Readonly<{ expectedIntentDigest: string; originalDurable: WorkspaceOperationOriginalDeleteIntent; prepared: readonly CohortDeletePrepared[];
    physical: readonly CohortDeletePhysical[] }>): Promise<void> {
  const captured = owners.get(owner);
  try {
    if (!captured || captured.move || captured.binding.plan.version !== 6 || captured.binding.actionMode !== 'apply') fail('JOB_LIFECYCLE_REQUIRED');
    current(captured);
    const fields = moveFields(input, ['expectedIntentDigest', 'originalDurable', 'prepared', 'physical']);
    const expectedIntentDigest = fields.expectedIntentDigest, originalDurable = fields.originalDurable as WorkspaceOperationOriginalDeleteIntent;
    const prepared = fields.prepared as readonly CohortDeletePrepared[];
    const physical = fields.physical as readonly CohortDeletePhysical[], plan = captured.binding.plan;
    if (typeof expectedIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedIntentDigest)
      || !Array.isArray(prepared) || prepared.length !== plan.pathSteps.length || !Array.isArray(physical)
      || physical.length > prepared.length || new Set(physical.map(item => item.stepKey)).size !== physical.length) fail('JOB_LIFECYCLE_INVALID');
    for (const [index, item] of prepared.entries()) {
      if (item.stepKey !== `path:${String(index).padStart(4, '0')}`
        || readPreparedWorkspacePathTrash(item.cap).canonicalPath !== plan.pathSteps[index].sourcePath) fail('JOB_LIFECYCLE_CHANGED');
    }
    for (const item of physical) {
      if (!prepared.some(original => original.stepKey === item.stepKey && original.cap === item.cap)
        || !equal(readPreparedWorkspacePathTrash(item.cap), item.receipt.original)) fail('JOB_LIFECYCLE_CHANGED');
    }
    return withNativeInspectionSchema(() => runLifecycleTransaction(owner, undefined, (access, database, check) =>
      withOriginalDeleteDomainAccess(captured, database, access, check, async domainAccess => {
        const binding = captured.binding;
        const observed = await readCohortDeleteObservationOnConnection(domainAccess.database,
          { schema: binding.source.schemaName, binding, workspace: domainAccess.workspace, dataRoot: resolveWorkspaceDataRoot() });
        if (!observed.durable || observed.durable.intentDigest !== expectedIntentDigest || !equal(observed.durable, originalDurable) || observed.result) return failCohortDelete('COHORT_DELETE_CHANGED');
        const intent = parseCohortDeleteIntent(observed.durable, binding, domainAccess.workspace, resolveWorkspaceDataRoot());
        await assertCohortDeletePending(domainAccess, binding, intent, prepared, physical);
      }))).catch(error => poison(captured, error));
  } catch (error) {
    if (captured) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
    return Promise.reject(error);
  }
}

/** The real shared lifecycle owner supplies B2, current policy, the complete
 * immutable cohort and actual prepared descriptors. No raw B escapes this API. */
export function completeWorkspaceOperationCohortDeleteJob(owner:WorkspaceOperationJobLifecycleOwner,
  input:Readonly<{expectedIntentDigest:string;prepared:readonly CohortDeletePhysical[]}>):Promise<CohortDeleteResult>{
  const captured=owners.get(owner);
  try{
    if(!captured||captured.move||captured.binding.plan.version!==6||captured.binding.actionMode!=='apply')fail('JOB_LIFECYCLE_REQUIRED');
    current(captured);
    if(typeof input.expectedIntentDigest!=='string'||!/^[a-f0-9]{64}$/u.test(input.expectedIntentDigest)
      ||!Array.isArray(input.prepared)||input.prepared.length!==captured.binding.plan.pathSteps.length)fail('JOB_LIFECYCLE_INVALID');
    for(const[index,item]of input.prepared.entries()){
      if(item.stepKey!==`path:${String(index).padStart(4,'0')}`||!equal(readPreparedWorkspacePathTrash(item.cap),item.receipt.original))fail('JOB_LIFECYCLE_CHANGED');}
    return withNativeInspectionSchema(() => runLifecycleTransaction(owner,undefined,async(access,database,check)=>{
      const binding=captured.binding,schema=binding.source.schemaName;
      const durable=await readWorkspaceOperationOriginalDeleteIntentOnConnection(database,{schema,batchId:binding.batchId,forShare:true});
      if(!durable||durable.intentDigest!==input.expectedIntentDigest)fail('JOB_LIFECYCLE_CHANGED');
      const intent=parseCohortDeleteIntent(durable,binding,access.workspace,resolveWorkspaceDataRoot());
      const admission=await readCohortDeleteAdmissionOnConnection(database,{schema,binding,intent}),claimed=await readWorkspaceOperationNativePathAdmissionOnConnection(database,captured.claim);
      if(admission.outcome||!['reserved','draining'].includes(admission.status)||!claimed
        ||!equal(captureCollaborationAdmissionRequest(claimed.request),captureCollaborationAdmissionRequest(admission.request)))fail('JOB_LIFECYCLE_CHANGED');
      let result:CohortDeleteResult|undefined;
      const outcome=await executeCollaborationAdmissionHandoffOnConnection(database,admission.request,{
        kind:'apply',authorize:async()=>{await check();},prepare:async connection=>{
          if(connection!==database)fail('JOB_LIFECYCLE_CHANGED');await check();
          for(const item of input.prepared){await assertPreparedWorkspacePathTrashCurrent(item.cap);await assertPreparedWorkspacePathTrashSourceVacant(item.cap);
            if(!equal(await readPreparedWorkspacePathTrashReceipt(item.cap),item.receipt))fail('JOB_LIFECYCLE_CHANGED');}await check();},
        mutate:async connection=>{if(connection!==database)fail('JOB_LIFECYCLE_CHANGED');await check();
          result=await withOriginalDeleteDomainAccess(captured,database,access,check,
            domainAccess=>completeCohortDeleteDomain(domainAccess,{binding,durable,intent,prepared:input.prepared}));
          await check();return cohortDeleteAdmissionResult(result);},
      });
      if(!result||outcome.version!==1||!equal(outcome.result,cohortDeleteAdmissionResult(result)))fail('JOB_LIFECYCLE_CHANGED');
      await readCohortDeleteAdmissionOnConnection(database,{schema,binding,intent,result});await check();
      await notifyWorkspaceFileInvalidationOnConnection(database,binding.workspaceId);return result;
    })).catch(error=>poison(captured,error));
  }catch(error){if(captured){try{poison(captured,error);}catch(failure){return Promise.reject(failure);}}return Promise.reject(error);}
}

/** Current authorized original cohort history. Confirmed completion performs no
 * FS inspection, workspace reservation or lookup/adoption of a later D2. */
export function readWorkspaceOperationCohortDeleteJobHistory(claim:WorkspaceOperationBatchClaim,
  openConnection:()=>Promise<SqlConnection>=openDb,mcp?:WorkspaceOperationMcpJobPrincipal):Promise<CohortDeleteResult|null>{
  if(context.getStore()||hasCollaborationHandoffExecutionContext())return Promise.reject(new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REENTRANT'));
  const binding=readWorkspaceOperationBatchClaimBinding(claim),auth=binding.authorization,plan=binding.plan;
  if(binding.actionMode!=='apply'||auth.mode!=='direct'&&auth.mode!=='direct-mcp'||!auth.jobScope||auth.jobScope.legacy
    ||plan.version!==6||plan.workspaceId!==binding.workspaceId||plan.planId!==binding.planId)return Promise.reject(new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_INVALID'));
  decodeWorkspaceOperationCohortDeletePlan(plan);const principal=captureMcpJobPrincipal(binding,mcp,false);
  return withWorkspaceOperationJobClaimPhase(claim,async()=>{
    const policy=principal?undefined:await captureWorkspaceOperationJobPolicy(),database=await openConnection();
    let begun=false,commitAttempted=false,failure:Error|undefined;
    try{
      await database.run("SET statement_timeout='5s'");await database.run("SET lock_timeout='50ms'");
      const first=await identity(database,true),second=await identity(database,false);
      if(!sameIdentity(first.identity,second.identity)||second.transaction!==null||second.identity.database!==binding.source.databaseOid
        ||second.identity.schema!==binding.source.schemaOid||second.identity.searchPath!==binding.source.searchPath)fail('JOB_LIFECYCLE_CHANGED');
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');begun=true;const started=await identity(database,true);
      if(!sameIdentity(started.identity,second.identity)||!started.transaction)fail('JOB_LIFECYCLE_CHANGED');
      const check=async()=>{const now=await identity(database,false);if(!sameIdentity(now.identity,second.identity)||now.transaction!==started.transaction
        ||readWorkspaceOperationBatchClaimBinding(claim)!==binding)fail('JOB_LIFECYCLE_CHANGED');};
      const authorize=(operation:(access:WorkspaceOperationJobPolicyAccess)=>Promise<CohortDeleteResult|null>)=>principal
        ?withWorkspaceOperationMcpJobPolicyOnConnection(database,{claim,principal},operation):withWorkspaceOperationJobPolicyOnConnection(database,{claim,policy:policy!},operation);
      const result=await authorize(async access=>{const{schemaName,schemaOid,databaseOid}=binding.source;
        const storage=await bindWorkspaceOperationOriginalDeleteStorageOnConnection(database,{schemaName,schemaOid,databaseOid});await access.assertCurrent();await check();
        const observed=await readCohortDeleteObservationOnConnection(database,{schema:schemaName,binding,workspace:access.workspace,dataRoot:resolveWorkspaceDataRoot()});
        await access.assertCurrent();await storage.assertCurrent();await check();return observed.result;});
      await check();commitAttempted=true;await database.run('COMMIT');begun=false;return result;
    }catch(error){failure=asError(error);if(begun)try{await database.run('ROLLBACK');}catch(rollback){failure=new AggregateError([failure,asError(rollback)]);}
      if(commitAttempted)failure=new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_COMMIT_UNCONFIRMED',{cause:failure});throw failure;
    }finally{try{await database.close(failure??new Error('Discarding original cohort Delete history session.'));}catch(close){throw new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_DISPOSAL_UNCONFIRMED',{
      cause:failure?new AggregateError([failure,asError(close)]):close});}}
  });
}
