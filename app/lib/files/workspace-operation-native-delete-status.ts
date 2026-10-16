import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { resolveWorkspaceActor, resolveWorkspaceDataRoot } from '../workspaces/context';
import { readPostgresWorkspaceForActorOnConnection } from '../workspaces/postgres-runtime';
import type { WorkspaceContext } from '../workspaces/types';
import { WorkspaceOperationBatchStore, type WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-native-delete-plan';
import { captureWorkspaceOperationJobScope, workspaceOperationJobScopeMatches } from './workspace-operation-job-scope';
import { readWorkspaceOperationOriginalDeleteObservationOnConnection,
  type WorkspaceOperationOriginalDeleteObservation } from './workspace-operation-original-delete-observation';

export type WorkspaceOperationNativeDeleteBatchStatus = Readonly<{
  batch: WorkspaceOperationBatchRecord; plan: WorkspaceOperationNativeDeleteBatchPlan;
  observation: WorkspaceOperationOriginalDeleteObservation;
}>;
export class WorkspaceOperationNativeDeleteStatusError extends Error {
  constructor(readonly code: 'BATCH_ACCESS_DENIED' | 'BATCH_SCOPE_CHANGED' | 'BATCH_JOURNAL_UNAVAILABLE', readonly status = 409,
    options?: ErrorOptions) { super(code, options); this.name = 'WorkspaceOperationNativeDeleteStatusError'; }
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function changed(): never { throw new WorkspaceOperationNativeDeleteStatusError('BATCH_SCOPE_CHANGED'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
type Input = { batchId: string; scope: WorkspaceOperationBatchScope; expectedPlan?: WorkspaceOperationNativeDeleteBatchPlan };
type ReadContext = Readonly<{ database: SqlConnection; schema: string; workspace: WorkspaceContext;
  status: WorkspaceOperationNativeDeleteBatchStatus }>;

/** Internal read adapter for an already authenticated caller. A workspace is
 * never converted into a RequestPrincipal, claim or mutation capability. */
export async function withWorkspaceOperationNativeDeleteReadContext<T>(input: Input,
  operation: (context: ReadContext) => Promise<T>): Promise<T | null> {
  const workspace = input.scope.workspace, other = input.scope.fileOptions.workspace;
  const userId = workspace.actor?.userId;
  if (!userId || !workspace.permissions.canRead || workspace.status !== 'active' || !other
    || other.actor?.userId !== userId || !other.permissions.canRead || other.status !== 'active') {
    throw new WorkspaceOperationNativeDeleteStatusError('BATCH_ACCESS_DENIED', 403);
  }
  const namespace = captureWorkspaceOperationJobScope(workspace), otherNamespace = captureWorkspaceOperationJobScope(other);
  const batchId = input.batchId, expectedPlan = input.expectedPlan && decodeWorkspaceOperationNativeDeleteBatchPlan(input.expectedPlan);
  const batch = await new WorkspaceOperationBatchStore().get(batchId);
  if (!batch || batch.plan.version !== 2) return null;
  const plan = decodeWorkspaceOperationNativeDeleteBatchPlan(batch.plan), auth = batch.authorization;
  if (auth.mode !== 'direct' || !isDeepStrictEqual(auth.jobScope, namespace)
    || !isDeepStrictEqual(auth.jobScope, otherNamespace)
    || !isDeepStrictEqual(plan.sourceEvidence.workspaceScope, auth.jobScope)
    || expectedPlan && !isDeepStrictEqual(plan, expectedPlan)) changed();
  freeze(batch);
  const database = await openDb();
  let began = false, committed = false, commitAttempted = false, failure: unknown, value: T | undefined;
  const unavailable = (cause: unknown) => new WorkspaceOperationNativeDeleteStatusError('BATCH_JOURNAL_UNAVAILABLE', 503, { cause });
  try {
    await database.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
    const realm = await database.get(`SELECT n.nspname AS schema_name,n.oid::bigint AS schema_oid,
      c.oid::bigint AS table_oid,(SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
      pg_catalog.current_setting('search_path') AS search_path FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid=pg_catalog.to_regclass('workspace_file_operation_batches') AND c.relkind='r' AND c.relpersistence='p'`) as Record<string, unknown> | undefined;
    if (!realm || typeof realm.schema_name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(realm.schema_name)
      || realm.schema_name.startsWith('pg_') || ['schema_oid','table_oid','database_oid'].some(key => !Number.isSafeInteger(Number(realm[key])) || Number(realm[key]) < 1)) changed();
    const schema = realm.schema_name as string, prefix = quote(schema);
    const assertCurrent = async (): Promise<WorkspaceContext> => {
      const user = await database.get(`SELECT id,email,role,banned FROM ${prefix}."user" WHERE id=$1`, [userId]) as Record<string, unknown> | undefined;
      if (!user || user.id !== userId || ![null, false, true, 0, 1, '0', '1'].includes(user.banned as never)
        || Number(user.banned) === 1) {
        throw new WorkspaceOperationNativeDeleteStatusError('BATCH_ACCESS_DENIED', 403);
      }
      const current = await readPostgresWorkspaceForActorOnConnection(database, resolveWorkspaceActor({
        id: userId, email: user.email as string | null, role: user.role as string | null,
      }), namespace.workspaceId);
      if (!current || current.status !== 'active' || !current.permissions.canRead
        || !workspaceOperationJobScopeMatches(auth.jobScope, current)) changed();
      const raw = await database.get(`SELECT * FROM ${prefix}.workspace_file_operation_batches WHERE batch_id=$1`, [batch.batchId]) as Record<string, unknown> | undefined;
      if (!raw || raw.plan_id !== batch.planId || raw.workspace_id !== batch.workspaceId
        || typeof raw.plan_json !== 'string' || Buffer.byteLength(raw.plan_json) > 16 * 1024 * 1024
        || typeof raw.authorization_json !== 'string' || Buffer.byteLength(raw.authorization_json) > 64 * 1024
        || !isDeepStrictEqual(JSON.parse(raw.plan_json), plan)
        || !isDeepStrictEqual(JSON.parse(raw.authorization_json), auth)
        || raw.action_mode !== batch.actionMode || raw.status !== batch.status
        || Number(raw.completed_actions) !== batch.completedActions || Number(raw.total_actions) !== batch.totalActions
        || raw.phase !== batch.phase) changed();
      const currentRealm = await database.get(`SELECT pg_catalog.to_regclass('workspace_file_operation_batches')::oid::bigint AS table_oid,
        pg_catalog.to_regclass($1)::oid::bigint AS qualified_oid,pg_catalog.current_setting('search_path') AS search_path,
        (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
        (SELECT oid::bigint FROM pg_catalog.pg_namespace WHERE nspname=$2) AS schema_oid`, [`${prefix}.workspace_file_operation_batches`, schema]) as Record<string, unknown> | undefined;
      if (!currentRealm || Number(currentRealm.qualified_oid) !== Number(realm.table_oid)
        || ['table_oid','schema_oid','database_oid','search_path'].some(key => String(currentRealm[key]) !== String(realm[key]))) changed();
      return current;
    };
    const current = await assertCurrent();
    const observation = await readWorkspaceOperationOriginalDeleteObservationOnConnection(database, { schema,
      context: { batchId: batch.batchId, planId: batch.planId, workspaceId: batch.workspaceId,
        authorization: auth, sourcePath: plan.nativeTarget.path }, workspace: current, dataRoot: resolveWorkspaceDataRoot() });
    if (observation.original && !isDeepStrictEqual(observation.original.native, plan.nativeTarget)) changed();
    const status = Object.freeze({ batch, plan, observation });
    value = await operation(Object.freeze({ database, schema, workspace: current, status }));
    await assertCurrent();
    commitAttempted = true; await database.run('COMMIT'); committed = true;
  } catch (error) {
    failure = commitAttempted || !(error instanceof Error) ? unavailable(error) : error;
    if (began && !committed) {
      try { await database.run('ROLLBACK'); }
      catch (rollback) { failure = unavailable(new AggregateError([failure, rollback], 'Native status rollback is unconfirmed.')); }
    }
  }
  try { await database.close(failure instanceof Error ? failure : undefined); }
  catch (close) { failure = unavailable(new AggregateError([...(failure === undefined ? [] : [failure]), close], 'Native status disposal is unconfirmed.')); }
  if (failure !== undefined) throw failure;
  return value as T;
}

export function readWorkspaceOperationNativeDeleteBatchStatus(input: Input): Promise<WorkspaceOperationNativeDeleteBatchStatus | null> {
  return withWorkspaceOperationNativeDeleteReadContext(input, async context => context.status);
}
