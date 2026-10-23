import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { openDb, type SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { getWorkspaceFileLifecycleLeases, type WorkspaceFileLifecycleLease } from '../collaboration/file-lifecycle-admission-context';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { withWorkspaceFileLifecycleGuard } from './workspace-file-lifecycle-guard';
import { lockFileCollaborationPaths } from './collaboration-repository/transaction';
import { hasCollaborationHandoffExecutionContext } from '../collaboration/handoff-execution-context';

type NativeIdentity = Readonly<{ documentId: string; lifecycleGeneration: number;
  representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks'; schemaVersion: number }>;
/** An existing lock/lineage, never a file creation claim or a synthetic native ID. */
export type OwnedLifecycleFileLockTarget = Readonly<{
  kind: 'existing_file_lock'; lockId: string; lineageId: string; workspaceId: string; organizationId: string | null;
  path: string; lockedByUserId: string; lockedBySessionId: string | null;
  status: 'active' | 'released' | 'expired' | 'force_released'; native: NativeIdentity | null;
}>;
type Row = Record<string, unknown>;
type Identity = Readonly<{ schema: string; backend: number; backendStart: string; database: number }>;
type Phase = { transaction: string; accepting: boolean; active: boolean; pending: Set<Promise<unknown>>;
  target: OwnedLifecycleFileLockTarget; operationId: string };
type Capture = {
  workspaceId: string; workspaceType: string; organizationId: string | null;
  userId: string; sessionId: string | null; targets: readonly OwnedLifecycleFileLockTarget[];
  key: string; high: number; low: number; identity?: Identity; lease?: WorkspaceFileLifecycleLease;
  database?: SqlConnection; state: 'preparing' | 'active' | 'closed'; accepting: boolean; disposed: boolean;
  failure: unknown; phase?: Phase; pending: Set<Promise<unknown>>;
};
const owners = new WeakMap<SqlConnection, Capture>();
const ownerContext = new AsyncLocalStorage<Capture>();
const phaseContext = new AsyncLocalStorage<Phase>();
const internalContext = new AsyncLocalStorage<Capture | undefined>();
const requiredTables = ['file_locks', 'file_collaboration_lineages', 'collaboration_documents', 'collaboration_yjs_states',
  'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets'];
const targetKeys = ['kind', 'lockId', 'lineageId', 'workspaceId', 'organizationId', 'path', 'lockedByUserId', 'lockedBySessionId', 'status', 'native'];
const nativeKeys = ['documentId', 'lifecycleGeneration', 'representation', 'schemaVersion'];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);

export class OwnedLifecycleSubwriteError extends Error {
  readonly status = 409;
  constructor(readonly code: 'OWNED_SUBWRITE_INVALID' | 'OWNED_SUBWRITE_REQUIRED' | 'OWNED_SUBWRITE_REENTRANT'
    | 'OWNED_SUBWRITE_BUSY' | 'OWNED_SUBWRITE_SCOPE_CHANGED' | 'OWNED_SUBWRITE_DETACHED' | 'OWNED_SUBWRITE_COMMIT_UNCONFIRMED') {
    super(code); this.name = 'OwnedLifecycleSubwriteError';
  }
}
function fail(code: OwnedLifecycleSubwriteError['code']): never { throw new OwnedLifecycleSubwriteError(code); }
function poison(captured: Capture, error: unknown): void {
  captured.failure ??= error ?? new OwnedLifecycleSubwriteError('OWNED_SUBWRITE_REQUIRED');
}
function record(value: unknown, keys: readonly string[]): value is Row {
  return !!value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value'); });
}
function captureTarget(input: OwnedLifecycleFileLockTarget): OwnedLifecycleFileLockTarget {
  if (!record(input, targetKeys) || input.kind !== 'existing_file_lock' || !validId(input.lockId) || !validId(input.lineageId)
    || !validId(input.workspaceId) || input.organizationId !== null && !validId(input.organizationId)
    || !isCanonicalAdmissionPath(input.path) || !validId(input.lockedByUserId)
    || input.lockedBySessionId !== null && !validId(input.lockedBySessionId)
    || !['active', 'released', 'expired', 'force_released'].includes(input.status)) fail('OWNED_SUBWRITE_INVALID');
  const native = input.native;
  if (native !== null && (!record(native, nativeKeys) || !validId(native.documentId)
    || !Number.isSafeInteger(native.lifecycleGeneration) || native.lifecycleGeneration < 1
    || !Number.isSafeInteger(native.schemaVersion) || native.schemaVersion < 1
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(native.representation))) fail('OWNED_SUBWRITE_INVALID');
  return Object.freeze({ ...input, native: native === null ? null : Object.freeze({ ...native }) });
}
function capture(input: { workspace: WorkspaceContext; actor: { userId: string; sessionId: string | null };
  targets: readonly OwnedLifecycleFileLockTarget[] }): Capture {
  const { workspace, actor, targets: inputs } = input;
  if (!workspace || workspace.legacy !== false || workspace.status !== 'active' || !validId(workspace.workspaceId)
    || !['personal', 'organization', 'team', 'project'].includes(workspace.workspaceType)
    || workspace.organizationId != null && !validId(workspace.organizationId)
    || !record(actor, ['userId', 'sessionId']) || !validId(actor.userId) || actor.sessionId !== null && !validId(actor.sessionId)
    || workspace.actor && workspace.actor.userId !== actor.userId || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 16) fail('OWNED_SUBWRITE_INVALID');
  const targets = inputs.map(captureTarget), organizationId = workspace.organizationId ?? null;
  if (targets.some((target, index) => target.workspaceId !== workspace.workspaceId || target.organizationId !== organizationId
    || target.lockedByUserId !== actor.userId || target.lockedBySessionId !== actor.sessionId
    || targets.slice(0, index).some(previous => previous.path === target.path || previous.lockId === target.lockId
      || previous.lineageId === target.lineageId || previous.native && previous.native.documentId === target.native?.documentId
      || previous.path.startsWith(`${target.path}/`) || target.path.startsWith(`${previous.path}/`)))) fail('OWNED_SUBWRITE_INVALID');
  const key = collaborationAdmissionLockKey(workspace.workspaceId), unsigned = BigInt.asUintN(64, BigInt(key));
  return { workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType, organizationId,
    userId: actor.userId, sessionId: actor.sessionId, targets: Object.freeze(targets), key,
    high: Number(unsigned >> BigInt(32)), low: Number(unsigned & BigInt(0xffffffff)),
    state: 'preparing', accepting: true, disposed: false, failure: undefined, pending: new Set() };
}
function assertOwner(captured: Capture): SqlConnection {
  const database = captured.database;
  if (!database || owners.get(database) !== captured || captured.state !== 'active' || captured.disposed
    || captured.failure !== undefined || ownerContext.getStore() !== captured
    || !captured.lease?.active || getWorkspaceFileLifecycleLeases()?.get(captured.workspaceId) !== captured.lease) fail('OWNED_SUBWRITE_REQUIRED');
  return database;
}
async function identity(database: SqlConnection, assign: boolean): Promise<{ identity: Identity; transaction: string | null }> {
  const row = await database.get(`SELECT current_schema() AS schema_name,pg_backend_pid() AS backend_pid,
    extract(epoch FROM a.backend_start)::text AS backend_start,
    ${assign ? 'pg_current_xact_id()' : 'pg_current_xact_id_if_assigned()'}::text AS transaction_id,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only
    FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as Row | undefined;
  const databaseId = Number(row?.database_oid);
  if (!row || typeof row.schema_name !== 'string' || !row.schema_name || row.schema_name.length > 63
    || /[\u0000-\u001f\u007f]/u.test(row.schema_name) || !Number.isSafeInteger(row.backend_pid) || Number(row.backend_pid) < 1
    || typeof row.backend_start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.backend_start)
    || !Number.isSafeInteger(databaseId) || databaseId < 1 || row.isolation !== 'read committed' || row.read_only !== 'off'
    || row.transaction_id !== null && (typeof row.transaction_id !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction_id))) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
  return { identity: Object.freeze({ schema: row.schema_name, backend: Number(row.backend_pid), backendStart: row.backend_start, database: databaseId }),
    transaction: row.transaction_id as string | null };
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return Object.keys(left).every(key => left[key as keyof Identity] === right[key as keyof Identity]);
}
async function checkRelations(database: SqlConnection, schema: string): Promise<void> {
  const rows = await database.all(`SELECT name,to_regclass(name)::oid=to_regclass($1||'.'||quote_ident(name))::oid AS same_relation
    FROM unnest($2::text[]) names(name)`, [quote(schema), requiredTables]) as Row[];
  if (rows.length !== requiredTables.length || rows.some(row => row.same_relation !== true || !requiredTables.includes(String(row.name)))) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
}
async function checkConnection(captured: Capture, phase?: Phase): Promise<void> {
  const database = assertOwner(captured), current = await identity(database, !!phase);
  assertOwner(captured);
  if (!captured.identity || !sameIdentity(captured.identity, current.identity)
    || phase && (captured.phase !== phase || !phase.active || current.transaction !== phase.transaction)
    || !phase && current.transaction !== null) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
  await checkRelations(database, current.identity.schema);
  const rows = await database.all(`SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.granted AND l.database=$1::oid AND l.classid::bigint=$2 AND l.objid::bigint=$3
      AND l.objsubid=1 AND l.pid=$4 AND extract(epoch FROM a.backend_start)::text=$5`,
  [current.identity.database, captured.high, captured.low, current.identity.backend, current.identity.backendStart]) as Row[];
  if (!rows.some(row => row.mode === 'ExclusiveLock') || rows.some(row => row.mode !== 'ExclusiveLock')
    || !await captured.lease!.verify()) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
  assertOwner(captured);
}
async function checkIdle(captured: Capture): Promise<void> {
  const database = assertOwner(captured), first = await identity(database, true), second = await identity(database, false);
  // Autocommit ends the assigned probe XID; even an initially unassigned BEGIN retains it.
  if (!captured.identity || !sameIdentity(captured.identity, first.identity) || !sameIdentity(first.identity, second.identity)
    || second.transaction !== null) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
  await checkConnection(captured);
}
async function checkNamespace(database: SqlConnection, schemaName: string, targets: readonly OwnedLifecycleFileLockTarget[]): Promise<void> {
  const schema = quote(schemaName);
  for (const target of targets) {
    // Exact existing file scopes only. Do not feed an arbitrary subtree into the legacy guard's unbounded room preflight.
    const descendants = await database.get(`SELECT 1 FROM (
      SELECT path FROM ${schema}.file_collaboration_lineages WHERE workspace_id=$1 AND left(path,length($2)+1)=$2||'/'
      UNION ALL SELECT path FROM ${schema}.collaboration_documents WHERE workspace_id=$1 AND left(path,length($2)+1)=$2||'/'
      UNION ALL SELECT path FROM ${schema}.collaboration_yjs_states WHERE workspace_id=$1 AND left(path,length($2)+1)=$2||'/'
    ) children LIMIT 1`, [target.workspaceId, target.path]);
    if (descendants) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
  }
}
async function checkTarget(captured: Capture, target: OwnedLifecycleFileLockTarget, phase?: Phase): Promise<void> {
  await checkConnection(captured, phase);
  const database = captured.database!, schema = quote(captured.identity!.schema);
  const reserved = await database.get(`SELECT s.request_id FROM ${schema}.collaboration_admission_scopes s
    JOIN ${schema}.collaboration_admission_requests r ON r.request_id=s.request_id
    WHERE s.workspace_id=$1 AND r.status NOT IN ('committed','cancelled') AND
      (s.path=$2 OR left(s.path,length($2)+1)=$2||'/' OR s.kind='subtree' AND (s.path='' OR left($2,length(s.path)+1)=s.path||'/')) LIMIT 1`,
  [captured.workspaceId, target.path]);
  if (reserved) fail('OWNED_SUBWRITE_BUSY');
  const row = await database.get(`SELECT f.id,f.lineage_id,f.workspace_id,f.workspace_type,f.organization_id,f.path,
    f.locked_by_user_id,f.locked_by_session_id,f.status,l.workspace_id AS lineage_workspace_id,l.workspace_type AS lineage_workspace_type,
    l.organization_id AS lineage_organization_id,l.path AS lineage_path,l.status AS lineage_status
    FROM ${schema}.file_locks f JOIN ${schema}.file_collaboration_lineages l ON l.id=f.lineage_id WHERE f.id=$1
    ${phase ? 'FOR UPDATE OF f FOR SHARE OF l' : ''}`, [target.lockId]) as Row | undefined;
  if (!row || row.id !== target.lockId || row.lineage_id !== target.lineageId || row.workspace_id !== captured.workspaceId
    || row.workspace_type !== captured.workspaceType || row.organization_id !== captured.organizationId || row.path !== target.path
    || row.locked_by_user_id !== captured.userId || row.locked_by_session_id !== captured.sessionId || row.status !== target.status
    || row.lineage_workspace_id !== captured.workspaceId || row.lineage_workspace_type !== captured.workspaceType
    || row.lineage_organization_id !== captured.organizationId || row.lineage_path !== target.path || row.lineage_status !== 'active') fail('OWNED_SUBWRITE_SCOPE_CHANGED');
  const docs = await database.all(`SELECT d.id,d.lineage_id,d.workspace_type,d.organization_id,d.provider,d.status,d.yjs_state_lifecycle,
    s.document_id,s.workspace_id AS state_workspace_id,s.organization_id AS state_organization_id,s.path AS state_path,s.status AS state_status,
    s.representation,s.lifecycle_generation,s.schema_version FROM ${schema}.collaboration_documents d
    LEFT JOIN ${schema}.collaboration_yjs_states s ON s.document_id=d.id
    WHERE d.workspace_id=$1 AND d.path=$2 LIMIT 2`, [captured.workspaceId, target.path]) as Row[];
  const states = await database.all(`SELECT document_id FROM ${schema}.collaboration_yjs_states WHERE workspace_id=$1 AND path=$2 LIMIT 2`,
    [captured.workspaceId, target.path]) as Row[];
  if (!target.native) {
    if (docs.length || states.length) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
  } else {
    const native = target.native, doc = docs[0];
    if (docs.length !== 1 || states.length !== 1 || states[0].document_id !== native.documentId || !doc || doc.id !== native.documentId
      || doc.lineage_id !== target.lineageId || doc.workspace_type !== captured.workspaceType || doc.organization_id !== captured.organizationId
      || doc.provider !== 'yjs' || doc.status !== 'active' || doc.yjs_state_lifecycle !== 'initialized'
      || doc.state_workspace_id !== captured.workspaceId || doc.state_organization_id !== captured.organizationId || doc.state_path !== target.path
      || doc.state_status !== 'active' || doc.representation !== native.representation || Number(doc.lifecycle_generation) !== native.lifecycleGeneration
      || Number(doc.schema_version) !== native.schemaVersion) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
    if (await database.get(`SELECT 1 FROM ${schema}.collaboration_admission_targets WHERE document_id=$1 AND active LIMIT 1`, [native.documentId])) fail('OWNED_SUBWRITE_BUSY');
  }
  await checkNamespace(database, captured.identity!.schema, [target]);
  await checkConnection(captured, phase);
}

/**
 * Inactive outer Legacyentry foundation. Opens the unchanged legacy guard's owner
 * checkout via its existing factory. Only the narrow subwrite API may query this
 * connection from the callback. No ACL, FS/create, DA04, terminal-lock or recovery
 * grant. Real current principal rights and narrow SQL/row CAS remain writer duties.
 * Each phase commits independently; a later fatal error cannot undo an earlier
 * confirmed phase. Writers must not issue their own transaction/control commands.
 * Actual handoff contexts reject entry across all workspaces, including retained
 * continuations. That marker grants no authority. Never install this inside a
 * DA04 handoff; production writer/legacy wrapper activation remains separate.
 */
export async function withOwnedWorkspaceFileLifecycleSubwrites<T>(input: {
  workspace: WorkspaceContext; actor: { userId: string; sessionId: string | null }; targets: readonly OwnedLifecycleFileLockTarget[];
}, operation: (database: SqlConnection) => Promise<T>, openConnection: () => Promise<SqlConnection> = openDb): Promise<T> {
  const previous = ownerContext.getStore();
  if (previous || getWorkspaceFileLifecycleLeases()?.size || hasCollaborationHandoffExecutionContext()) {
    const error = new OwnedLifecycleSubwriteError('OWNED_SUBWRITE_REENTRANT');
    if (previous) poison(previous, error);
    throw error;
  }
  const captured = capture(input);
  return withWorkspaceFileLifecycleGuard({ workspaceId: captured.workspaceId, paths: captured.targets.map(target => target.path) }, async () => {
    const database = captured.database!;
    captured.lease = getWorkspaceFileLifecycleLeases()?.get(captured.workspaceId);
    captured.state = 'active'; owners.set(database, captured);
    return ownerContext.run(captured, async () => {
      let result: T | undefined;
      try {
        await internalContext.run(captured, async () => {
          await checkIdle(captured);
          for (const target of captured.targets) await checkTarget(captured, target);
        });
        try { result = await operation(database); } catch (error) { poison(captured, error); }
        captured.accepting = false;
        if (captured.pending.size) {
          poison(captured, new OwnedLifecycleSubwriteError('OWNED_SUBWRITE_DETACHED'));
          await Promise.allSettled([...captured.pending]);
        }
        if (captured.failure !== undefined) throw captured.failure;
        await internalContext.run(captured, () => checkIdle(captured));
        return result as T;
      } finally {
        captured.accepting = false; captured.state = 'closed';
        if (captured.phase) captured.phase.active = false;
        owners.delete(database);
      }
    });
  }, async () => {
    const original = await openConnection();
    // Close(error) is one-shot even when an unconfirmed COMMIT already destroyed
    // the backend and the legacy guard's finally subsequently calls close again.
    const dispose = async (error?: Error) => {
      if (captured.disposed) return;
      captured.disposed = true; captured.accepting = false;
      if (captured.lease) captured.lease.active = false;
      await original.close(error ?? new Error('Discarding owned lifecycle subwrite session.'));
    };
    const dispatch = <TResult>(sql: string, query: () => TResult | Promise<TResult>): Promise<TResult> => {
      if (captured.disposed) return Promise.reject(new OwnedLifecycleSubwriteError('OWNED_SUBWRITE_REQUIRED'));
      if (captured.state === 'preparing' || internalContext.getStore() === captured) return Promise.resolve().then(query);
      const phase = captured.phase;
      try {
        assertOwner(captured);
        if (!phase || !phase.active || !phase.accepting || phaseContext.getStore() !== phase) fail('OWNED_SUBWRITE_REQUIRED');
        // Deliberately narrow single-statement writers. Transaction/control/DDL
        // belongs exclusively to the owner; this is not an arbitrary-SQL sandbox.
        if (typeof sql !== 'string' || sql.length > 32768 || /[;\u0000]/u.test(sql) || /\bpg_(?:try_)?advisory_/iu.test(sql)
          || !/^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu.test(sql)) fail('OWNED_SUBWRITE_INVALID');
      } catch (error) { poison(captured, error); return Promise.reject(error); }
      const pending = (async () => {
        try {
          await internalContext.run(captured, () => checkTarget(captured, phase.target, phase));
          const result = await query();
          await internalContext.run(captured, () => checkTarget(captured, phase.target, phase));
          return result;
        } catch (error) { poison(captured, error); throw error; }
      })();
      phase.pending.add(pending);
      void pending.then(() => phase.pending.delete(pending), () => phase.pending.delete(pending));
      return pending;
    };
    const database: SqlConnection = Object.freeze({
      get: (sql: string, values?: unknown[]) => dispatch(sql, () => original.get(sql, values)),
      all: (sql: string, values?: unknown[]) => dispatch(sql, () => original.all(sql, values)),
      run: (sql: string, values?: unknown[]) => dispatch(sql, () => original.run(sql, values)),
      close: dispose,
    });
    captured.database = database;
    try {
      const first = await identity(database, true), second = await identity(database, false);
      if (!sameIdentity(first.identity, second.identity) || second.transaction !== null) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
      captured.identity = second.identity;
      await checkRelations(database, second.identity.schema);
      await checkNamespace(database, second.identity.schema, captured.targets);
      return database;
    } catch (error) {
      await dispose(new Error('Discarding invalid owned lifecycle checkout.')).catch(() => undefined);
      throw error;
    }
  });
}

/** All SQL and assertCurrent promises must be awaited; any caught error poisons the owner. */
export function withOwnedLifecycleSubwriteTransactionOnConnection<T>(database: SqlConnection, input: {
  target: OwnedLifecycleFileLockTarget; operationId: string;
}, operation: (assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> {
  const captured = owners.get(database);
  if (!captured) {
    const error = new OwnedLifecycleSubwriteError('OWNED_SUBWRITE_REQUIRED'), previous = ownerContext.getStore();
    if (previous) poison(previous, error);
    return Promise.reject(error);
  }
  let target: OwnedLifecycleFileLockTarget, operationId: string;
  try {
    assertOwner(captured);
    if (!captured.accepting || captured.pending.size || captured.phase) fail('OWNED_SUBWRITE_REENTRANT');
    if (!record(input, ['target', 'operationId']) || !validId(input.operationId)) fail('OWNED_SUBWRITE_INVALID');
    target = captureTarget(input.target); operationId = input.operationId;
    if (!captured.targets.some(bound => targetKeys.every(key => key === 'native'
      ? bound.native === null ? target.native === null : target.native !== null
        && nativeKeys.every(field => bound.native![field as keyof NativeIdentity] === target.native![field as keyof NativeIdentity])
      : bound[key as keyof typeof bound] === target[key as keyof typeof target]))) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
  } catch (error) { poison(captured, error); return Promise.reject(error); }
  const pending = internalContext.run(captured, async () => {
    let begun = false, phase: Phase | undefined;
    try {
      await checkIdle(captured);
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
      const current = await identity(database, true);
      if (!captured.identity || !sameIdentity(captured.identity, current.identity) || !current.transaction) fail('OWNED_SUBWRITE_SCOPE_CHANGED');
      phase = { transaction: current.transaction, accepting: true, active: true, pending: new Set(), target, operationId };
      captured.phase = phase;
      // Existing two-int path lock, on this owner and TX; distinct from its
      // unchanged session-held admission bigint. Preserve the exact path bytes.
      await lockFileCollaborationPaths(database, captured.workspaceId, [target.path]);
      await checkTarget(captured, target, phase);
      const assertCurrent = () => {
        const guarded = (async () => {
          try {
            if (!phase?.active || !phase.accepting || phaseContext.getStore() !== phase) fail('OWNED_SUBWRITE_REQUIRED');
            await internalContext.run(captured, () => checkTarget(captured, target, phase));
          } catch (error) { poison(captured, error); throw error; }
        })();
        phase!.pending.add(guarded);
        void guarded.then(() => phase!.pending.delete(guarded), () => phase!.pending.delete(guarded));
        return guarded;
      };
      let result: T | undefined;
      // Internal query authority is explicitly removed from the trusted writer.
      try { result = await internalContext.run(undefined,
        () => phaseContext.run(phase!, () => operation(assertCurrent))); } catch (error) { poison(captured, error); }
      phase.accepting = false;
      if (phase.pending.size) {
        poison(captured, new OwnedLifecycleSubwriteError('OWNED_SUBWRITE_DETACHED'));
        await Promise.allSettled([...phase.pending]);
      }
      if (captured.failure !== undefined) throw captured.failure;
      await checkTarget(captured, target, phase);
      try { await database.run('COMMIT'); begun = false; }
      catch {
        const error = new OwnedLifecycleSubwriteError('OWNED_SUBWRITE_COMMIT_UNCONFIRMED'); poison(captured, error);
        await Promise.resolve(database.close(new Error('Discarding unconfirmed owned lifecycle commit.'))).catch(() => undefined);
        throw error;
      }
      phase.active = false; captured.phase = undefined;
      await checkIdle(captured);
      return result as T;
    } catch (error) {
      poison(captured, error);
      if (begun && !captured.disposed) {
        try { await database.run('ROLLBACK'); }
        catch { await Promise.resolve(database.close(new Error('Discarding unresolved owned lifecycle rollback.'))).catch(() => undefined); }
      }
      throw error;
    } finally {
      if (phase) phase.active = false;
      if (captured.phase === phase) captured.phase = undefined;
    }
  });
  captured.pending.add(pending);
  void pending.then(() => captured.pending.delete(pending), () => captured.pending.delete(pending));
  return pending;
}
