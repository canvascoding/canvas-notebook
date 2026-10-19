import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
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
import { getWorkspaceOperationNativeDeleteLinkRecipes } from './workspace-operation-native-delete-plan';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection } from './workspace-operation-original-delete-repository';
import { parseIntent, assertOriginalDeleteIntentPlan } from './workspace-operation-original-delete-evidence';
import { applyOriginalDeleteNativeLinks, assertOriginalDeleteNativeLinkPlan,
  type OriginalDeleteNativeLinkReceipt } from './workspace-operation-original-delete-links';
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
  captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness } from './workspace-operation-native-move-plan';
import type { WorkspaceOperationNativeSourceEvidence } from './workspace-operation-native-source-evidence';
import { bindWorkspaceOperationOriginalMoveStorageOnConnection } from './workspace-operation-original-move-storage';
import { createWorkspaceOperationOriginalMoveIntent, parseWorkspaceOperationOriginalMoveIntent, getWorkspaceOperationOriginalMoveNativeIds,
  decodeWorkspaceOperationOriginalMoveParentReceipt, decodeWorkspaceOperationOriginalMovePathReceipt,
  decodeWorkspaceOperationOriginalMoveCompletion, serializeWorkspaceOperationOriginalMoveData,
  readWorkspaceOperationOriginalMoveNativeBundle, type WorkspaceOperationOriginalMoveContext,
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
import { captureNativeFileOperationBundle, stageNativeFileOperationBundleOnConnection, readStagedNativeFileOperationBindingOnConnection,
  applyNativeFileOperationMutationOnConnection, nativeFileOperationReceiptSetProofOnConnection, readHistoricalNativeFileOperationReceiptOnConnection }
  from '../markdown/native-file-operation-handoff';
import { prepareNativeLinkMutations } from '../markdown/workspace-native-link-mutations';
import { captureNativeFileOperationSideEffectsOnConnection, applyNativeFileOperationSideEffectsOnConnection,
  readHistoricalNativeFileOperationSideEffectsOnConnection } from '../markdown/native-file-operation-side-effects';


declare const ownerBrand: unique symbol;
export type WorkspaceOperationJobLifecycleOwner = Readonly<{ [ownerBrand]: true }>;
export type WorkspaceOperationJobLifecycleAccess = Readonly<WorkspaceOperationJobPolicyAccess & {
  database: SqlConnection;
  /** Fixed claimed journal operation; never accepts SQL, prepared bytes or callbacks. */
  applyOriginalNativeDeleteLinks: (expectedIntentDigest: string) => Promise<OriginalDeleteNativeLinkReceipt[]>;
  readOriginalNativeDeleteSources: () => Promise<WorkspaceLinkSourceAuthorityObservation>;
}>;
type Identity = Readonly<{ backend: number; start: string; database: number; schema: number; searchPath: string }>;
type Directory = { named: string; real: string; handle: FileHandle; stat: Stats };
type Phase = { active: boolean; accepting: boolean; transaction: string; pending: Set<Promise<unknown>>;
  index: number; startedAt: number | null; startedMonotonic: number; queriesBefore: number;
  stage: 'preparation' | 'begin' | 'identity' | 'policy' | 'storage' | 'path-locks' | 'operation'
    | 'before-operation-check' | 'sql' | 'after-operation-check' | 'link-authority' | 'final-check' | 'commit' | 'after-commit';
  operation: 'authority' | 'native-source-read' | 'native-link-write' | 'read' | 'write';
  relation: string | null };
type MovePrepared = Readonly<{ stepKey: string; cap: PreparedWorkspacePathMove; receipt?: PreparedWorkspacePathMoveReceipt }>;
type MoveCapture = { context: WorkspaceOperationOriginalMoveContext; preparedSteps: readonly MovePrepared[]; guards: readonly string[];
  nativePhase?: Phase; nativeReceipts?: readonly import('../markdown/native-file-operation-handoff').NativeFileOperationReceipt[] };
type Capture = {
  move?: MoveCapture;
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
  if (binding.actionMode !== 'apply' || binding.plan.version !== (move ? 3 : 2)) fail('JOB_LIFECYCLE_INVALID');
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
async function identity(database: SqlConnection, assign: boolean): Promise<{ identity: Identity; transaction: string | null }> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema,
    pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication,
    ${assign ? 'pg_catalog.pg_current_xact_id()' : 'pg_catalog.pg_current_xact_id_if_assigned()'}::text AS transaction
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Record<string, unknown> | undefined;
  if (!row || !Number.isSafeInteger(row.backend) || Number(row.backend) < 1 || typeof row.start !== 'string'
    || !/^[0-9]+\.[0-9]+$/u.test(row.start) || !Number.isSafeInteger(Number(row.database)) || Number(row.database) < 1
    || !Number.isSafeInteger(Number(row.schema)) || Number(row.schema) < 1 || typeof row.search_path !== 'string'
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin'
    || row.transaction !== null && (typeof row.transaction !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction))) fail('JOB_LIFECYCLE_CHANGED');
  return { identity: Object.freeze({ backend: Number(row.backend), start: row.start, database: Number(row.database),
    schema: Number(row.schema), searchPath: row.search_path }), transaction: row.transaction as string | null };
}
const sameIdentity = (left: Identity, right: Identity) => Object.keys(left).every(key => Reflect.get(left, key) === Reflect.get(right, key));
async function checkOwner(captured: Capture, transaction?: string): Promise<void> {
  const database = current(captured); await checkDirectories(captured); current(captured);
  const now = await identity(database, transaction !== undefined), before = captured.identity!, source = captured.binding.source;
  if (!sameIdentity(before, now.identity) || now.identity.database !== source.databaseOid || now.identity.schema !== source.schemaOid
    || now.identity.searchPath !== source.searchPath || (transaction === undefined ? now.transaction !== null : now.transaction !== transaction)) fail('JOB_LIFECYCLE_CHANGED');
  const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(captured.binding.workspaceId)));
  const held = await database.get(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=$1::oid
      AND l.classid::bigint=$2 AND l.objid::bigint=$3 AND l.pid=$4 AND extract(epoch FROM a.backend_start)::text=$5) AS held`,
  [source.databaseOid, Number(key >> BigInt(32)), Number(key & BigInt('0xffffffff')), before.backend, before.start]) as { held?: boolean } | undefined;
  if (held?.held !== true || !await captured.lease!.verify()) fail('JOB_LIFECYCLE_CHANGED');
  if (captured.move) await checkMoveGuards(captured);
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
    || plan.readiness !== 'ready' || (move ? plan.version !== 3 || !plan.pathSteps.length : plan.pathSteps.length !== 1 || step?.kind !== 'delete' || step.destinationPath != null)
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
      const guard = move ? (input: { workspaceId: string; paths: readonly string[] }, callback: () => Promise<T>, open: () => Promise<SqlConnection>) => withMoveLifecycleGuard(captured, input, callback, open) : withWorkspaceFileLifecycleGuard;
      value = await guard({ workspaceId: binding.workspaceId,
        paths: plan.version >= 2 ? [''] : [step.sourcePath] }, async () => {
        captured.lease = getWorkspaceFileLifecycleLeases()?.get(binding.workspaceId);
        captured.active = true;
        return context.run(captured, async () => {
          await checkIdle(captured);
          // A real current job policy is required before the caller can do physical work.
          if (captured.move) await movePhase(owner, async () => undefined);
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
        const database: SqlConnection = Object.freeze({
          get: (sql: string, values?: unknown[]) => { captured.forwardedQueries++; return originalGet(sql, values); },
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
  moveOperation?: (access: WorkspaceOperationJobPolicyAccess, database: SqlConnection, check: () => Promise<void>) => Promise<T>): Promise<T> {
  const captured = owner && typeof owner === 'object' ? owners.get(owner) : undefined;
  if (!captured) {
    const error = new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REQUIRED'), active = context.getStore();
    if (active) active.failure ??= error; return Promise.reject(error);
  }
  try {
    current(captured);
    if (!captured.accepting || captured.phase || captured.pending.size || (captured.move ? typeof moveOperation !== 'function' || operation !== undefined : typeof operation !== 'function' || moveOperation !== undefined)) fail('JOB_LIFECYCLE_REENTRANT');
  } catch (error) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
  const phase: Phase = { active: true, accepting: true, transaction: '', pending: new Set(), index: ++captured.phaseCount,
    startedAt: null, startedMonotonic: 0, queriesBefore: 0, stage: 'preparation', operation: 'authority', relation: null };
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
        // A fixed internal path set from the genuinely claimed native plan. Keep
        // advisory SQL on the actual owner B, outside the restricted facade.
        if (captured.binding.plan.version === 2) {
          phase.stage = 'path-locks';
          const sources = getWorkspaceOperationNativeDeleteLinkRecipes(captured.binding.plan).map(recipe => recipe.source.path);
          if (sources.length) await lockFileCollaborationPaths(database, captured.binding.workspaceId, [captured.sourcePath, ...sources]);
        }
        const check = async () => { current(captured); await checkOwner(captured, phase.transaction);
          await access.assertCurrent(); await storage.assertCurrent(); current(captured); await checkOwner(captured, phase.transaction); };
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
          const checked = (async () => { try { phase.stage = 'before-operation-check'; await check(); checkPhase(captured, phase);
            phase.stage = 'sql'; const value = await query(); phase.stage = 'after-operation-check';
            await check(); checkPhase(captured, phase); return value; }
            catch (error) { return poison(captured, error); } })();
          phase.pending.add(checked); void checked.then(() => phase.pending.delete(checked), () => phase.pending.delete(checked)); return checked;
        };
        const facade: SqlConnection = Object.freeze({ get: (sql: string, values?: unknown[]) => dispatch(sql, () => database.get(sql, values)),
          all: (sql: string, values?: unknown[]) => dispatch(sql, () => database.all(sql, values)),
          run: (sql: string, values?: unknown[]) => dispatch(sql, () => database.run(sql, values)),
          close: () => dispatch('CLOSE', async () => undefined) });
        return phaseContext.run(phase, async () => {
          phase.stage = 'operation';
          await check();
          let result: T | undefined;
          try { result = captured.move ? await moveOperation!(access, database, check) : await operation!(Object.freeze({ ...access, database: facade,
            readOriginalNativeDeleteSources: () => dispatch(undefined, async () => {
              if (captured.binding.actionMode !== 'apply' || captured.binding.plan.version !== 2) fail('JOB_LIFECYCLE_INVALID');
              // Fixed read of this claimed workspace only. The ordinary SQL
              // facade remains restricted and every method boundary is checked.
              return readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace);
            }, 'native-source-read'),
            applyOriginalNativeDeleteLinks: (expectedIntentDigest: string) => dispatch(undefined, async () => {
              const { binding } = captured;
              if (binding.actionMode !== 'apply' || binding.plan.version !== 2
                || typeof expectedIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedIntentDigest)) fail('JOB_LIFECYCLE_INVALID');
              // Read the actual immutable journal on this owner B. The caller's
              // digest selects no actor, workspace, source, recipe or Yjs bytes.
              const row = await readWorkspaceOperationOriginalDeleteIntentOnConnection(database,
                { schema: schemaName, batchId: binding.batchId, forShare: true });
              if (!row || row.intentDigest !== expectedIntentDigest) fail('JOB_LIFECYCLE_CHANGED');
              const intent = parseIntent(row, { batchId: binding.batchId, planId: binding.planId,
                workspaceId: binding.workspaceId, authorization: binding.authorization, sourcePath: captured.sourcePath },
              access.workspace, resolveWorkspaceDataRoot());
              if (intent.version !== 2 && intent.version !== 3 || !intent.nativeLinks?.length) fail('JOB_LIFECYCLE_INVALID');
              assertOriginalDeleteIntentPlan(intent, binding.plan);
              assertOriginalDeleteNativeLinkPlan(binding.plan, intent.nativeLinks);
              // Keep current authority before every source (including receipt
              // retries) and immediately before each CAS. This private check
              // does not recursively enter the public dispatch queue.
              const validate = async () => { phase.stage = 'link-authority'; checkPhase(captured, phase); await check();
                checkPhase(captured, phase); phase.stage = 'sql'; };
              return applyOriginalDeleteNativeLinks(database, access.workspace, intent.nativeLinks, validate,
                intent.version === 3 ? intent.currentWitness : undefined);
            }, 'native-link-write'),
            assertCurrent: () => dispatch(undefined, async () => undefined) })); }
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
    } finally { phase.accepting = false; phase.active = false; if (captured.phase === phase) captured.phase = undefined; }
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
  return runLifecycleTransaction(owner, operation);
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
  if (!equal(plan.sourceEvidence.workspaceScope, auth.jobScope) || plan.sourceEvidence.nativeBindings.length > 1024) fail('JOB_LIFECYCLE_INVALID');
  const selected = Object.freeze({ batchId: binding.batchId, requestHash: auth.requestHash,
    actor: Object.freeze({ userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType,
      actorSessionId: auth.actorSessionId ?? null }), plan });
  const guards = plan.sourceEvidence.nativeBindings.map(item => lockIdentity(item.expected.documentId).key);
  if (new Set(guards).size !== guards.length || guards.includes(collaborationAdmissionLockKey(binding.workspaceId))) fail('JOB_LIFECYCLE_INVALID');
  return { context: selected, preparedSteps: Object.freeze([]), guards: Object.freeze(guards.sort((a,b) => BigInt(a)<BigInt(b)?-1:1)) };
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
async function checkMoveGuards(captured: Capture): Promise<void> {
  const database = current(captured), guards = captured.move!.guards.map(key => BigInt.asUintN(64,BigInt(key)).toString());
  if (!guards.length) return;
  const row = await database.get(`SELECT count(*)::integer AS count FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
    AND locktype='advisory' AND granted AND mode='ExclusiveLock' AND objsubid=1 AND database=$1::oid
    AND (classid::bigint::numeric*4294967296+objid::bigint::numeric)=ANY($2::numeric[])`,
  [captured.binding.source.databaseOid,guards]) as {count?:number}|undefined;
  if (row?.count !== guards.length) fail('JOB_LIFECYCLE_CHANGED'); current(captured);
}
async function readMoveRows(captured: Pick<Capture,'binding'|'move'>, database: SqlConnection): Promise<WorkspaceOperationOriginalMoveJobReceipts> {
  const selected = captured.move!.context, schema = captured.binding.source.schemaName;
  const intentRow = await readWorkspaceOperationOriginalMoveIntentOnConnection(database,{schema,batchId:selected.batchId,forShare:true});
  if (!intentRow) return Object.freeze({context:selected,intentRow:null,intent:null,parentRows:[],pathRows:[],completionRow:null,completion:null});
  const intent = parseWorkspaceOperationOriginalMoveIntent(intentRow,selected);
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
  const key = collaborationAdmissionLockKey(input.workspaceId), unsigned = BigInt.asUintN(64,BigInt(key));
  const lease: WorkspaceFileLifecycleLease = {active:true,verify:async () => {
    if (!lease.active || closed) return false;
    try {
      const now = await identity(database,false);
      const held = await database.get(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
        AND locktype='advisory' AND granted AND mode='ExclusiveLock' AND objsubid=1 AND database=$1::oid
        AND classid::bigint=$2 AND objid::bigint=$3) AS held`,
      [captured.binding.source.databaseOid,Number(unsigned>>BigInt(32)),Number(unsigned&BigInt('0xffffffff'))]) as {held?:boolean}|undefined;
      if (held?.held === true && sameIdentity(captured.identity!,now.identity) && lease.active && !closed) return true;
    } catch { /* Lost B revokes the actual lease. */ }
    lease.active = false; return false;
  }};
  try {
    await database.run("SET statement_timeout='5s'"); await database.run("SET lock_timeout='4s'");
    const locked = await database.get('SELECT pg_try_advisory_lock($1::bigint) AS locked',[key]) as {locked?:boolean}|undefined;
    if (locked?.locked !== true) fail('JOB_LIFECYCLE_CHANGED');
    // Read the immutable original before allowing only its exact reservation.
    const row = await readWorkspaceOperationOriginalMoveIntentOnConnection(database,{schema:captured.binding.source.schemaName,batchId:captured.binding.batchId});
    const intent = row ? parseWorkspaceOperationOriginalMoveIntent(row,captured.move!.context) : null;
    const own = intent ? captureCollaborationAdmissionRequest(moveRequest(captured,intent)) : null;
    const active = await database.all(`SELECT DISTINCT r.request_id,r.request_digest,r.intent_text FROM collaboration_admission_scopes s
      JOIN collaboration_admission_requests r USING(request_id) WHERE s.workspace_id=$1 AND r.status NOT IN('committed','cancelled') LIMIT 3`,[input.workspaceId]) as Array<{request_id:string;request_digest:string;intent_text:string}>;
    if (active.some(item => !own || item.request_id !== own.request.requestId || item.request_digest !== own.requestDigest || item.intent_text !== own.intentText)
      || active.length > 1) fail('JOB_LIFECYCLE_CHANGED');
    for (const room of captured.move!.guards) {
      const result = await database.get('SELECT pg_try_advisory_lock($1::bigint) AS locked',[room]) as {locked?:boolean}|undefined;
      if (result?.locked !== true) fail('JOB_LIFECYCLE_CHANGED');
    }
    const rows = await database.all(`SELECT document_id,room_owner_token,room_owner_backend_pid,room_owner_backend_start
      FROM collaboration_yjs_states WHERE workspace_id=$1 AND status='active' ORDER BY document_id LIMIT 1025`,[input.workspaceId]) as Array<Record<string,unknown>>;
    const ids = captured.move!.context.plan.sourceEvidence.nativeBindings.map(item => item.expected.documentId).sort();
    if (rows.length !== ids.length || rows.some((row,index) => row.document_id !== ids[index] || row.room_owner_token !== null
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
      if (plan.planIdentityVersion !== 2) return plan.sourceEvidence;
      const rows = await readMoveRows(captured, database);
      if (rows.intent || rows.completion) fail('JOB_LIFECYCLE_CHANGED');
      const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace);
      return captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, observation, plan.sourceEvidence.workspaceScope);
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
    nativeReceipts:captured.move.nativePhase === phase ? captured.move.nativeReceipts ?? Object.freeze([]) : Object.freeze([]),assertCurrent});
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
    const { captureWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection } = await import('./workspace-operation-original-move-namespace-effects');
    for (const item of prepared) { await assertPreparedWorkspacePathMoveCurrent(item.cap); await check(); }
    const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database,access.workspace);
    const plan = captured.move!.context.plan;
    const currentWitness = plan.planIdentityVersion === 2
      ? captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan,observation,plan.sourceEvidence.workspaceScope) : null;
    if (!currentWitness) assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan,observation,plan.sourceEvidence.workspaceScope);
    const namespaceState = await captureWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection(database,{schema:captured.binding.source.schemaName,workspace:access.workspace,context:captured.move!.context});
    const nativeBundle = buildMoveNativeBundle(captured.move!.context,observation,currentWitness ?? plan.sourceEvidence);
    const intent = createWorkspaceOperationOriginalMoveIntent({physical,nativeBundle,namespaceState,
      ...(currentWitness ? {currentWitness} : {})},captured.move!.context);
    const existing = await readMoveRows(captured,database);
    if (existing.intentRow) {
      if (existing.intentRow.intentText !== moveJson(intent)) fail('JOB_LIFECYCLE_CHANGED');
      return existing;
    }
    const inserted = await insertWorkspaceOperationOriginalMoveIntentOnConnection(database,{schema:captured.binding.source.schemaName,
      batchId:intent.batchId,planId:intent.planId,workspaceId:captured.binding.workspaceId,requestHash:intent.requestHash,intentText:moveJson(intent)});
    if (inserted.kind === 'conflict') fail('JOB_LIFECYCLE_CHANGED');
    const bundle = readWorkspaceOperationOriginalMoveNativeBundle(intent);
    if (bundle) {
      const staged = await stageNativeFileOperationBundleOnConnection(database,bundle);
      if (staged.changesBundleProof !== intent.nativeBundle!.changesBundleProof || staged.actionPayloadText !== intent.nativeBundle!.actionPayloadText) fail('JOB_LIFECYCLE_CHANGED');
    }
    const request = moveRequest(captured,intent);
    const reserved = await reserveCollaborationAdmissionOnConnection(database,request);
    if (!['reserved','draining'].includes(reserved.status)) fail('JOB_LIFECYCLE_CHANGED');
    for (const document of request.expectedDocuments) { await proveCollaborationAdmissionQuiescenceOnConnection(database,request,document.documentId); await check(); }
    return readMoveRows(captured,database);
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
    const rows = await readMoveRows(captured,database), intent = rows.intent;
    if (!intent || !rows.intentRow || rows.completion || rows.pathRows.length !== intent.steps.length) fail('JOB_LIFECYCLE_CHANGED');
    const source = await readWorkspaceOperationOriginalMoveSourcesContext(database); await source.assertCurrent(); await check();
    const request = moveRequest(captured,intent), bundle = readWorkspaceOperationOriginalMoveNativeBundle(intent);
    captured.move!.nativePhase = captured.phase; captured.move!.nativeReceipts = Object.freeze([]);
    let native: WorkspaceOperationOriginalMoveCompletionData['native'] = null;
    let namespaceEffects: WorkspaceOperationOriginalMoveCompletionData['namespaceEffects'] = null;
    const { readWorkspaceOperationOriginalMoveSourcesOnConnection } = await import('./workspace-operation-original-move-sources');
    const { applyWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection } = await import('./workspace-operation-original-move-namespace-effects');
    await executeCollaborationAdmissionHandoffOnConnection(database,request,{kind:'apply',
      authorize:async () => { await check(); },
      prepare:async connection => {
        if (connection !== database) fail('JOB_LIFECYCLE_CHANGED');
        await check(); await source.assertCurrent();
        const observation = await readWorkspaceOperationOriginalMoveSourcesOnConnection(database,access.workspace,'original');
        assertWorkspaceOperationNativeMoveBatchPlanCurrent(captured.move!.context.plan,observation,intent.jobScope);
        if (bundle) {
          const staged = await readStagedNativeFileOperationBindingOnConnection(database,{request,operationId:bundle.operationId});
          if (staged.changesBundleProof !== intent.nativeBundle!.changesBundleProof) fail('JOB_LIFECYCLE_CHANGED');
          if (bundle.mutations.some(mutation => mutation.kind !== 'link')) {
            await fixedMoveSideEffect(captured,database,() => captureNativeFileOperationSideEffectsOnConnection(database,{workspace:access.workspace,request,operationId:bundle.operationId}));
          }
        }
        await check();
      },
      mutate:async connection => {
        if (connection !== database) fail('JOB_LIFECYCLE_CHANGED');
        await check(); await source.assertCurrent();
        const result: Record<string,string> = {};
        if (bundle) {
          const receipts = [];
          for (const mutation of bundle.mutations) {
            await check();
            const applied = await applyNativeFileOperationMutationOnConnection(database,{workspace:access.workspace,action:bundle.action,
              operationId:bundle.operationId,mutationId:mutation.mutationId});
            receipts.push({mutationId:mutation.mutationId,receiptDigest:applied.receiptDigest});
            captured.move!.nativeReceipts = Object.freeze([...captured.move!.nativeReceipts!,applied.receipt]); await check();
          }
          let sideEffectReceiptDigest: string|null = null;
          if (bundle.mutations.some(mutation => mutation.kind !== 'link')) {
            const effects = await fixedMoveSideEffect(captured,database,() => applyNativeFileOperationSideEffectsOnConnection(database,{workspace:access.workspace,operationId:bundle.operationId}));
            result.nativeFileSideEffectSetProof = effects.nativeFileSideEffectSetProof;
            const row = await database.get('SELECT receipt_digest FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=$1 FOR SHARE',[bundle.operationId]) as {receipt_digest?:unknown}|undefined;
            if (typeof row?.receipt_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.receipt_digest)) fail('JOB_LIFECYCLE_CHANGED');
            sideEffectReceiptDigest = row.receipt_digest;
          }
          result.nativeFileReceiptSetProof = await nativeFileOperationReceiptSetProofOnConnection(database,bundle.action,bundle.operationId);
          native = {operationId:bundle.operationId,requestId:bundle.requestId,changesBundleProof:intent.nativeBundle!.changesBundleProof,
            receipts,sideEffectReceiptDigest};
        }
        namespaceEffects = await applyWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection(database,{workspace:access.workspace,context:captured.move!.context,intent});
        await source.assertCurrent(); await check();
        await readWorkspaceOperationOriginalMoveSourcesOnConnection(database,access.workspace,'final');
        await check();
        return result;
      }});
    await check(); await source.assertCurrent();
    const completion: WorkspaceOperationOriginalMoveCompletionData = {version:1,batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,
      planId:intent.planId,compilerPlanProof:intent.compilerPlanProof,finalGraphProof:intent.finalGraphProof,
      parentReceipts:intent.parents.map(parent => ({parentPath:parent.parentPath,receiptDigest:rows.parentRows.find(row => row.parentPath === parent.parentPath)!.receiptDigest})),
      pathReceipts:intent.steps.map(step => ({stepKey:step.stepKey,receiptDigest:rows.pathRows.find(row => row.stepKey === step.stepKey)!.receiptDigest})),native,namespaceEffects};
    const receiptText = moveJson(completion), candidate = {batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,
      receiptText,receiptDigest:moveHash(receiptText),createdAt:0};
    decodeWorkspaceOperationOriginalMoveCompletion(candidate,intent,rows.parentRows,rows.pathRows);
    const inserted = await insertWorkspaceOperationOriginalMoveReceiptOnConnection(database,{schema:captured.binding.source.schemaName,
      batchId:intent.batchId,intentDigest:rows.intentRow.intentDigest,receiptText});
    if (inserted.kind === 'conflict') fail('JOB_LIFECYCLE_CHANGED');
    return decodeWorkspaceOperationOriginalMoveCompletion(inserted.row,intent,rows.parentRows,rows.pathRows);
  });
  } catch (error) { return rejectMoveBoundary(owner,error); }
}

/** Authorized historical proof only. This opens no FS handle, acquires no room
 * or workspace guard and never replays physical/native/metadata operations. */
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
        if (!outcome) fail('JOB_LIFECYCLE_CHANGED');
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

function buildMoveNativeBundle(selected: WorkspaceOperationOriginalMoveContext,
  observation: WorkspaceLinkSourceAuthorityObservation,
  sourceEvidence: WorkspaceOperationNativeSourceEvidence = selected.plan.sourceEvidence): WorkspaceOperationOriginalMoveNativeBundleData|null {
  const plan = selected.plan, mappings = plan.nativePathPlan.pathMappings.filter(mapping => mapping.source.documentId !== null);
  const ids = [...new Set([...mappings.map(mapping => mapping.source.documentId!),...plan.nativePathPlan.mutations.map(recipe => recipe.source.documentId)])].sort();
  if (!ids.length) return null;
  const identity = getWorkspaceOperationOriginalMoveNativeIds(selected);
  const mutations = ids.map(documentId => {
    const original = sourceEvidence.nativeBindings.find(binding => binding.expected.documentId === documentId)?.expected;
    const state = observation.privateNativeStates.find(item => item.documentId === documentId);
    const version = sourceEvidence.stage.sources.find(source => source.inventory.document.documentId === documentId)?.inventory.version;
    if (!original || !state || !version) fail('JOB_LIFECYCLE_CHANGED');
    const mutationId = getWorkspaceOperationOriginalMoveNativeIds(selected,documentId).mutationId!;
    const mapping = mappings.find(mapping => mapping.source.documentId === documentId);
    const source = {documentId,workspaceId:original.workspaceId,organizationId:original.organizationId,path:original.path,
      representation:original.representation,lifecycleGeneration:original.lifecycleGeneration,schemaVersion:original.schemaVersion};
    const recipes = plan.nativePathPlan.mutations.filter(recipe => recipe.source.documentId === documentId);
    return {mutationId,kind:mapping?'move' as const:'link' as const,source,lineageId:original.lineageId,
      registryStateVersion:original.registryStateVersion,before:{documentSequence:original.documentSequence,persistedAt:original.persistedAt,
        stateProof:original.stateProof,stateVector:version.stateVector,binaryHash:original.binaryHash},
      destinationPath:mapping?.destinationPath ?? null,trashEntryId:null,
      prepared:recipes.length ? prepareNativeLinkMutations({state,recipes,operationId:mutationId}) : null};
  });
  const bundle = captureNativeFileOperationBundle({version:1,operationId:identity.operationId,requestId:identity.requestId,
    action:plan.actions[0].kind,actor:{actorUserId:selected.actor.userId,actorId:selected.actor.actorId,actorType:selected.actor.actorType,
      actorSessionId:selected.actor.actorSessionId},reviewDigest:plan.planId,mutations});
  return Object.freeze({privateText:bundle.privateText,changesBundleProof:bundle.changesBundleProof,actionPayloadText:bundle.actionPayloadText});
}
