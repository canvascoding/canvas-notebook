import 'server-only';

import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { getWorkspaceFileLifecycleLeases } from '../collaboration/file-lifecycle-admission-context';
import { assertCollaborationAdmissionOpen } from '../collaboration/room-admission';
import { CollaborationAdmissionError, collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';

/** Stable native identity, deliberately independent of content sequence/room ownership. */
export type WorkspaceSideEffectWriterTarget = Readonly<{
  kind: 'native_file'; documentId: string; lineageId: string; workspaceId: string; organizationId: string | null;
  path: string; lifecycleGeneration: number; representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks'; schemaVersion: number;
}>;
type Row = Record<string, unknown>;
type Identity = Readonly<{ schema: string; backend: number; backendStart: string; transaction: string; database: number }>;
type Capture = {
  phase: 'preparing' | 'active' | 'closed'; accepting: boolean; failure: unknown;
  identity?: Identity; workspaceId: string; workspaceType: string; organizationId: string | null;
  targets: readonly WorkspaceSideEffectWriterTarget[]; key: string; high: number; low: number;
  pending: Set<Promise<unknown>>;
};
const captures = new WeakMap<SqlConnection, Capture>();
const MAX_TARGETS = 16;
const requiredTables = ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states',
  'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets'];
const targetKeys = ['kind', 'documentId', 'lineageId', 'workspaceId', 'organizationId', 'path', 'lifecycleGeneration', 'representation', 'schemaVersion'];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);

export class WorkspaceSideEffectWriterFenceError extends Error {
  readonly status = 409;
  constructor(readonly code: 'SIDE_EFFECT_WRITER_INVALID' | 'SIDE_EFFECT_WRITER_BUSY' | 'SIDE_EFFECT_WRITER_SCOPE_CHANGED'
    | 'SIDE_EFFECT_WRITER_REQUIRED' | 'SIDE_EFFECT_WRITER_REENTRANT' | 'SIDE_EFFECT_WRITER_DETACHED') {
    super(code); this.name = 'WorkspaceSideEffectWriterFenceError';
  }
}
function fail(code: WorkspaceSideEffectWriterFenceError['code']): never { throw new WorkspaceSideEffectWriterFenceError(code); }
function poison(captured: Capture, error: unknown): void {
  captured.failure ??= error ?? new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_REQUIRED');
}

function captureTarget(input: WorkspaceSideEffectWriterTarget): WorkspaceSideEffectWriterTarget {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== targetKeys.length
    || targetKeys.some(key => !Object.prototype.hasOwnProperty.call(input, key) || !Object.getOwnPropertyDescriptor(input, key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(input, key), 'value'))
    || input.kind !== 'native_file' || !validId(input.documentId) || !validId(input.lineageId) || !validId(input.workspaceId)
    || input.organizationId !== null && !validId(input.organizationId) || !isCanonicalAdmissionPath(input.path)
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(input.representation)
    || !Number.isSafeInteger(input.lifecycleGeneration) || input.lifecycleGeneration < 1
    || !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) fail('SIDE_EFFECT_WRITER_INVALID');
  return Object.freeze({ ...input });
}

function captureScope(workspace: WorkspaceContext, inputs: readonly WorkspaceSideEffectWriterTarget[]): Capture {
  if (!workspace || !validId(workspace.workspaceId) || workspace.legacy || workspace.status !== 'active'
    || !workspace.permissions?.canRead || !['personal', 'organization', 'team', 'project'].includes(workspace.workspaceType)
    || workspace.organizationId != null && !validId(workspace.organizationId)
    || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_TARGETS) fail('SIDE_EFFECT_WRITER_INVALID');
  const organizationId = workspace.organizationId ?? null;
  const targets = inputs.map(captureTarget);
  if (targets.some((target, index) => target.workspaceId !== workspace.workspaceId || target.organizationId !== organizationId
    || targets.slice(0, index).some(previous => previous.documentId === target.documentId || previous.lineageId === target.lineageId
      || previous.path === target.path || previous.path.startsWith(`${target.path}/`) || target.path.startsWith(`${previous.path}/`)))) fail('SIDE_EFFECT_WRITER_INVALID');
  const key = collaborationAdmissionLockKey(workspace.workspaceId), unsigned = BigInt.asUintN(64, BigInt(key));
  return { phase: 'preparing', accepting: true, failure: undefined, workspaceId: workspace.workspaceId, organizationId,
    workspaceType: workspace.workspaceType, targets: Object.freeze(targets), key,
    high: Number(unsigned >> BigInt(32)), low: Number(unsigned & BigInt(0xffffffff)), pending: new Set() };
}

async function connectionIdentity(database: SqlConnection): Promise<Identity> {
  const row = await database.get(`SELECT current_schema() AS schema_name,pg_backend_pid() AS backend_pid,
    extract(epoch FROM a.backend_start)::text AS backend_start,
    CASE WHEN current_setting('transaction_read_only')='off' THEN pg_current_xact_id()::text END AS transaction_id,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only
    FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as Row | undefined;
  const databaseId = Number(row?.database_oid);
  if (!row || typeof row.schema_name !== 'string' || !row.schema_name || row.schema_name.length > 63
    || /[\u0000-\u001f\u007f]/u.test(row.schema_name) || !Number.isSafeInteger(row.backend_pid) || Number(row.backend_pid) < 1
    || typeof row.backend_start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.backend_start)
    || typeof row.transaction_id !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction_id)
    || !Number.isSafeInteger(databaseId) || databaseId < 1 || row.isolation !== 'read committed' || row.read_only !== 'off') fail('SIDE_EFFECT_WRITER_SCOPE_CHANGED');
  return Object.freeze({ schema: row.schema_name, backend: Number(row.backend_pid), backendStart: row.backend_start,
    transaction: row.transaction_id, database: databaseId });
}

function assertActive(database: SqlConnection, captured: Capture): void {
  if (captures.get(database) !== captured || captured.phase === 'closed' || captured.failure !== undefined) fail('SIDE_EFFECT_WRITER_REQUIRED');
}

async function checkConnection(database: SqlConnection, captured: Capture): Promise<void> {
  assertActive(database, captured);
  const current = await connectionIdentity(database), expected = captured.identity;
  assertActive(database, captured);
  if (!expected || Object.keys(expected).some(key => current[key as keyof Identity] !== expected[key as keyof Identity])) fail('SIDE_EFFECT_WRITER_SCOPE_CHANGED');
  const rows = await database.all(`SELECT name,to_regclass(name)::oid=to_regclass($1||'.'||quote_ident(name))::oid AS same_relation
    FROM unnest($2::text[]) names(name)`, [quote(expected.schema), requiredTables]) as Row[];
  assertActive(database, captured);
  if (rows.length !== requiredTables.length || rows.some(row => row.same_relation !== true || !requiredTables.includes(String(row.name)))) fail('SIDE_EFFECT_WRITER_SCOPE_CHANGED');
}

async function ownLockModes(database: SqlConnection, captured: Capture): Promise<string[]> {
  const identity = captured.identity!;
  const rows = await database.all(`SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.granted AND l.database=$1::oid AND l.classid::bigint=$2 AND l.objid::bigint=$3
      AND l.objsubid=1 AND l.pid=$4 AND extract(epoch FROM a.backend_start)::text=$5`,
  [identity.database, captured.high, captured.low, identity.backend, identity.backendStart]) as Row[];
  assertActive(database, captured);
  return rows.map(row => String(row.mode));
}

async function checkTargets(database: SqlConnection, captured: Capture, targets = captured.targets): Promise<void> {
  await checkConnection(database, captured);
  const modes = await ownLockModes(database, captured);
  if (!modes.includes('ShareLock') || modes.includes('ExclusiveLock')) fail('SIDE_EFFECT_WRITER_SCOPE_CHANGED');
  for (const target of targets) {
    try { await assertCollaborationAdmissionOpen((sql, values) => database.all(sql, values) as Promise<Row[]>, target); }
    catch (error) {
      if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT') fail('SIDE_EFFECT_WRITER_BUSY');
      throw error;
    }
    assertActive(database, captured);
    const schema = quote(captured.identity!.schema);
    const row = await database.get(`SELECT d.id,d.lineage_id,d.workspace_id,d.workspace_type,d.organization_id,d.path,d.provider,
      d.status,d.yjs_state_lifecycle,l.workspace_id AS lineage_workspace_id,l.workspace_type AS lineage_workspace_type,
      l.organization_id AS lineage_organization_id,l.path AS lineage_path,l.status AS lineage_status,
      s.workspace_id AS state_workspace_id,s.organization_id AS state_organization_id,s.path AS state_path,s.status AS state_status,
      s.representation,s.lifecycle_generation,s.schema_version
      FROM ${schema}.collaboration_documents d JOIN ${schema}.file_collaboration_lineages l ON l.id=d.lineage_id
        JOIN ${schema}.collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1`, [target.documentId]) as Row | undefined;
    assertActive(database, captured);
    if (!row || row.id !== target.documentId || row.lineage_id !== target.lineageId || row.workspace_id !== captured.workspaceId
      || row.workspace_type !== captured.workspaceType || row.organization_id !== captured.organizationId || row.path !== target.path
      || row.provider !== 'yjs' || row.status !== 'active' || row.yjs_state_lifecycle !== 'initialized'
      || row.lineage_workspace_id !== captured.workspaceId || row.lineage_workspace_type !== captured.workspaceType
      || row.lineage_organization_id !== captured.organizationId || row.lineage_path !== target.path || row.lineage_status !== 'active'
      || row.state_workspace_id !== captured.workspaceId || row.state_organization_id !== captured.organizationId
      || row.state_path !== target.path || row.state_status !== 'active' || row.representation !== target.representation
      || Number(row.lifecycle_generation) !== target.lifecycleGeneration || Number(row.schema_version) !== target.schemaVersion) fail('SIDE_EFFECT_WRITER_SCOPE_CHANGED');
  }
  await checkConnection(database, captured);
}

/**
 * Inactive foundation: no production writer uses this yet. Caller owns one BEGIN
 * READ COMMITTED READ WRITE transaction, its narrow ACL/row locks, and COMMIT.
 * On ANY failure caller MUST ROLLBACK; never catch and COMMIT partial mutations.
 * The shared existing admission key remains held until that caller's TX ends.
 * This is no DA04/native mutation, room ownership, ACL, filesystem or recovery grant.
 * Exact native targets only; no folder/physical/pristine adapters or reentrancy.
 */
export async function withWorkspaceSideEffectWriterFenceOnConnection<T>(database: SqlConnection,
  input: { workspace: WorkspaceContext; targets: readonly WorkspaceSideEffectWriterTarget[] }, operation: () => Promise<T>): Promise<T> {
  if (captures.has(database)) { const previous = captures.get(database)!;
    previous.failure ??= new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_REENTRANT'); throw previous.failure; }
  const captured = captureScope(input.workspace, input.targets);
  captures.set(database, captured);
  try {
    if (getWorkspaceFileLifecycleLeases()?.has(captured.workspaceId)) fail('SIDE_EFFECT_WRITER_REENTRANT');
    captured.identity = await connectionIdentity(database);
    await checkConnection(database, captured); // Separate statement proves an existing caller-owned TX, not autocommit.
    if ((await ownLockModes(database, captured)).length) fail('SIDE_EFFECT_WRITER_REENTRANT');
    const row = await database.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked', [captured.key]) as Row | undefined;
    assertActive(database, captured);
    if (row?.locked !== true) fail('SIDE_EFFECT_WRITER_BUSY');
    await checkTargets(database, captured);
    captured.phase = 'active';
    let result: T | undefined;
    try { result = await operation(); } catch (error) { poison(captured, error); }
    captured.accepting = false;
    if (captured.pending.size) {
      captured.failure ??= new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_DETACHED');
      await Promise.allSettled([...captured.pending]);
    }
    if (captured.failure !== undefined) throw captured.failure;
    await checkTargets(database, captured);
    return result as T;
  } finally {
    captured.accepting = false; captured.phase = 'closed';
    if (captures.get(database) === captured) captures.delete(database);
  }
}

/** Narrow trusted OnConnection writers must await this boundary around their SQL. */
export function withWorkspaceSideEffectWriterMutationOnConnection<T>(database: SqlConnection,
  input: WorkspaceSideEffectWriterTarget, operation: (assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> {
  const captured = captures.get(database);
  if (!captured || captured.phase !== 'active') return Promise.reject(new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_REQUIRED'));
  let target: WorkspaceSideEffectWriterTarget;
  try {
    assertActive(database, captured);
    if (!captured.accepting || captured.pending.size) fail('SIDE_EFFECT_WRITER_REENTRANT');
    target = captureTarget(input);
    if (!captured.targets.some(bound => targetKeys.every(key => bound[key as keyof typeof bound] === target[key as keyof typeof target]))) fail('SIDE_EFFECT_WRITER_SCOPE_CHANGED');
  } catch (error) { poison(captured, error); return Promise.reject(error); }
  let active = true;
  const assertCurrent = async () => {
    try {
      if (!active) fail('SIDE_EFFECT_WRITER_REQUIRED');
      await checkTargets(database, captured, [target]);
      if (!active) fail('SIDE_EFFECT_WRITER_REQUIRED');
    } catch (error) { poison(captured, error); throw error; }
  };
  const pending = (async () => {
    try {
      await assertCurrent();
      const result = await operation(assertCurrent);
      await assertCurrent();
      return result;
    } catch (error) { poison(captured, error); throw error; }
    finally { active = false; }
  })();
  captured.pending.add(pending);
  void pending.then(() => captured.pending.delete(pending), () => captured.pending.delete(pending));
  return pending;
}
