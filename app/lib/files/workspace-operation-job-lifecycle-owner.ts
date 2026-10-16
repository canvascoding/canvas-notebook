import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { openDb, type SqlConnection } from '../db';
import { getWorkspaceFileLifecycleLeases, type WorkspaceFileLifecycleLease } from '../collaboration/file-lifecycle-admission-context';
import { hasCollaborationHandoffExecutionContext } from '../collaboration/handoff-execution-context';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import { workspaceAbsoluteRoot } from '../workspaces/contracts';
import { captureWorkspaceOperationJobPolicy, withWorkspaceOperationJobPolicyOnConnection,
  type WorkspaceOperationJobPolicyAccess } from '../workspaces/workspace-operation-job-principal';
import { readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim,
  type WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import { withWorkspaceFileLifecycleGuard } from './workspace-file-lifecycle-guard';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { bindWorkspaceOperationOriginalDeleteStorageOnConnection } from './workspace-operation-original-delete-storage';
import { withWorkspaceOperationJobClaimPhase } from './workspace-operation-job-phase-scheduling';
import { lockFileCollaborationPaths } from './collaboration-repository';
import { getWorkspaceOperationNativeDeleteLinkRecipes } from './workspace-operation-native-delete-plan';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection } from './workspace-operation-original-delete-repository';
import { parseIntent } from './workspace-operation-original-delete-evidence';
import { applyOriginalDeleteNativeLinks, assertOriginalDeleteNativeLinkPlan,
  type OriginalDeleteNativeLinkReceipt } from './workspace-operation-original-delete-links';
import { readWorkspaceLinkSourceAuthorityOnConnection,
  type WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { reportWorkspaceOperationFailureDiagnostics } from './workspace-operation-failure-diagnostics';

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
type Capture = {
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
export async function withWorkspaceOperationJobLifecycleOwner<T>(claim: WorkspaceOperationBatchClaim,
  operation: (owner: WorkspaceOperationJobLifecycleOwner) => Promise<T>,
  openConnection: () => Promise<SqlConnection> = openDb): Promise<T> {
  const inherited = context.getStore();
  if (inherited) poison(inherited, new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REENTRANT'));
  const binding = readWorkspaceOperationBatchClaimBinding(claim), authorization = binding.authorization;
  const plan = binding.plan, step = plan.pathSteps[0], jobScope = authorization.mode === 'direct' ? authorization.jobScope : undefined;
  if (authorization.mode !== 'direct' || !['apply','undo'].includes(binding.actionMode) || !jobScope || jobScope.legacy
    || binding.workspaceId !== jobScope.workspaceId || plan.workspaceId !== binding.workspaceId || plan.planId !== binding.planId
    || plan.readiness !== 'ready' || plan.pathSteps.length !== 1 || step?.kind !== 'delete' || step.destinationPath != null
    || !isCanonicalAdmissionPath(step.sourcePath) || typeof operation !== 'function' || typeof jobScope.rootRelativePath !== 'string'
    || workspaceAbsoluteRoot(jobScope.rootRelativePath) !== jobScope.rootPath) fail('JOB_LIFECYCLE_INVALID');
  const rootRelativePath = jobScope.rootRelativePath;
  if (getWorkspaceFileLifecycleLeases()?.has(binding.workspaceId) || hasCollaborationHandoffExecutionContext()) fail('JOB_LIFECYCLE_REENTRANT');
  return withWorkspaceMutationLock(binding.workspaceId, async () => {
    const owner = Object.freeze(Object.create(null)) as WorkspaceOperationJobLifecycleOwner;
    const captured: Capture = { owner, claim, binding, sourcePath: step.sourcePath, active: false, accepting: true,
      disposed: false, directories: [], pending: new Set(), phaseCount: 0, forwardedQueries: 0 };
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
      value = await withWorkspaceFileLifecycleGuard({ workspaceId: binding.workspaceId,
        paths: plan.version === 2 ? [''] : [step.sourcePath] }, async () => {
        captured.lease = getWorkspaceFileLifecycleLeases()?.get(binding.workspaceId);
        captured.active = true;
        return context.run(captured, async () => {
          await checkIdle(captured);
          // A real current job policy is required before the caller can do physical work.
          await withWorkspaceOperationJobLifecycleTransaction(owner, async () => undefined);
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
export function withWorkspaceOperationJobLifecycleTransaction<T>(owner: WorkspaceOperationJobLifecycleOwner,
  operation: (access: WorkspaceOperationJobLifecycleAccess) => Promise<T>): Promise<T> {
  const captured = owner && typeof owner === 'object' ? owners.get(owner) : undefined;
  if (!captured) {
    const error = new WorkspaceOperationJobLifecycleError('JOB_LIFECYCLE_REQUIRED'), active = context.getStore();
    if (active) active.failure ??= error; return Promise.reject(error);
  }
  try {
    current(captured);
    if (!captured.accepting || captured.phase || captured.pending.size || typeof operation !== 'function') fail('JOB_LIFECYCLE_REENTRANT');
  } catch (error) { try { poison(captured, error); } catch (failure) { return Promise.reject(failure); } }
  const phase: Phase = { active: true, accepting: true, transaction: '', pending: new Set(), index: ++captured.phaseCount,
    startedAt: null, startedMonotonic: 0, queriesBefore: 0, stage: 'preparation', operation: 'authority', relation: null };
  captured.phase = phase;
  const pending = withWorkspaceOperationJobClaimPhase(captured.claim, async () => {
    const database = captured.database!; let begun = false, commitAttempted = false;
    try {
      await checkIdle(captured);
      const policy = await captureWorkspaceOperationJobPolicy(); current(captured);
      phase.startedAt = Date.now(); phase.startedMonotonic = performance.now(); phase.queriesBefore = captured.forwardedQueries;
      phase.stage = 'begin';
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
      phase.stage = 'identity';
      const started = await identity(database, true);
      if (!started.transaction) fail('JOB_LIFECYCLE_CHANGED'); phase.transaction = started.transaction;
      phase.stage = 'policy';
      const result = await withWorkspaceOperationJobPolicyOnConnection(database, { claim: captured.claim, policy }, async access => {
        // Every owner is an original direct Delete. Bind its fixed storage on
        // the actual B before exposing the deliberately restricted SQL facade.
        const { schemaName, schemaOid, databaseOid } = captured.binding.source;
        phase.stage = 'storage';
        const storage = await bindWorkspaceOperationOriginalDeleteStorageOnConnection(database, { schemaName, schemaOid, databaseOid });
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
          try { result = await operation(Object.freeze({ ...access, database: facade,
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
              if (intent.version !== 2 || !intent.nativeLinks?.length) fail('JOB_LIFECYCLE_INVALID');
              assertOriginalDeleteNativeLinkPlan(binding.plan, intent.nativeLinks);
              // Keep current authority before every source (including receipt
              // retries) and immediately before each CAS. This private check
              // does not recursively enter the public dispatch queue.
              const validate = async () => { phase.stage = 'link-authority'; checkPhase(captured, phase); await check();
                checkPhase(captured, phase); phase.stage = 'sql'; };
              return applyOriginalDeleteNativeLinks(database, access.workspace, intent.nativeLinks, validate);
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
