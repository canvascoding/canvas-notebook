import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { NATIVE_FILE_SIDE_EFFECT_ROW_SPECS } from '../db/native-file-operation-side-effects-migration';
import { captureCollaborationAdmissionRequest, type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { requireCollaborationAdmissionMutationRequest, withCollaborationAdmissionMutation } from '../collaboration/room-admission-handoff';
import { readCollaborationAdmissionOutcome } from '../collaboration/room-admission-outcome';
import { readAppliedNativeFileOperationReceiptBindingsOnConnection,
  readStagedNativeFileOperationBindingOnConnection } from './native-file-operation-handoff';

type Binding = Awaited<ReturnType<typeof readStagedNativeFileOperationBindingOnConnection>>;
type Mutation = Binding['mutations'][number];
type Row = Record<string, unknown>;
type Rows = Record<(typeof NATIVE_FILE_SIDE_EFFECT_ROW_SPECS)[number]['key'], Row[]>;
type Effect = Pick<Mutation, 'mutationId' | 'kind' | 'source' | 'lineageId' | 'destinationPath'> & { beforeRows: Rows };
type Stage = Pick<Binding, 'operationId' | 'requestId' | 'requestDigest' | 'action' | 'changesBundleProof' | 'actor' | 'reviewDigest'> & {
  version: 1; capturedAt: number; mutationIds: string[]; effects: Effect[];
};
type Receipt = Omit<Stage, 'effects'> & { stageDigest: string; nativeReceiptSetProof: string; createdAt: number;
  effects: Array<Omit<Effect, 'kind' | 'destinationPath'> & { nativeReceiptDigest: string; after: unknown; afterRows: Rows }> };
type ConnectionIdentity = { schema: string; backend: number; transaction: string };
type Capture = { identity: ConnectionIdentity; stage: Stage; stageText: string; stageDigest: string; state: 'captured' | 'applying' };
const captures = new WeakMap<SqlConnection, Capture>();
const MAX_INTENT_BYTES = 8 * 1024 * 1024;
const MAX_STAGE_BYTES = 1024 * 1024;
const MAX_ROWS = 256;
const MAX_MUTATIONS = 64;
const MAX_EFFECTS = 16;
const MAX_CAPTURE_ROWS = 2048;
const MAX_PRIVATE_ROW_BYTES = 8 * 1024 * 1024;
const terminalAgentStatuses = "'persisted_yjs','checkpointed_file','cancelled','expired','superseded','failed','rejected','reverted'";

export class NativeFileOperationSideEffectError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_FILE_SIDE_EFFECTS_INVALID' | 'NATIVE_FILE_SIDE_EFFECTS_STAGE_REQUIRED'
    | 'NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED' | 'NATIVE_FILE_SIDE_EFFECTS_BUSY' | 'NATIVE_FILE_SIDE_EFFECTS_UNCONFIRMED') {
    super(code); this.name = 'NativeFileOperationSideEffectError';
  }
}
function fail(code: NativeFileOperationSideEffectError['code']): never { throw new NativeFileOperationSideEffectError(code); }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const proofFor = (digest: string) => hash(`canvas.native-file-side-effects.v1\n${digest}`);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const table = (schema: string, name: string) => `${quote(schema)}.${quote(name)}`;

function canonical(value: unknown): string {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') return Object.fromEntries(Object.keys(node).sort().map(key => [key, visit((node as Row)[key])]));
    return node;
  };
  return JSON.stringify(visit(value));
}

function boundedText(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max || Buffer.byteLength(value) > max) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
}

function assertWorkspace(workspace: WorkspaceContext, actor?: Binding['actor']): void {
  if (!workspace || !validId(workspace.workspaceId) || workspace.legacy || workspace.organizationId !== null && !validId(workspace.organizationId)
    || workspace.status !== 'active' || !workspace.permissions.canRead || !workspace.permissions.canWrite || !workspace.permissions.canDelete
    || actor && workspace.actor?.userId && workspace.actor.userId !== actor.actorUserId) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
}

async function connectionIdentity(database: SqlConnection): Promise<ConnectionIdentity> {
  const row = await database.get('SELECT current_schema() AS schema_name,pg_backend_pid() AS backend_pid,pg_current_xact_id()::text AS transaction_id') as Row | undefined;
  if (!row || typeof row.schema_name !== 'string' || row.schema_name.length > 63 || /[\u0000-\u001f\u007f]/u.test(row.schema_name)
    || !Number.isSafeInteger(row.backend_pid) || typeof row.transaction_id !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction_id)) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
  return { schema: row.schema_name, backend: row.backend_pid as number, transaction: row.transaction_id };
}

async function databaseClock(database: SqlConnection): Promise<number> {
  const row = await database.get('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS clock_ms') as Row | undefined;
  const clock = Number(row?.clock_ms);
  if (!Number.isSafeInteger(clock) || clock < 0 || clock >= Number.MAX_SAFE_INTEGER) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
  return clock;
}

async function assertConnection(database: SqlConnection, captured: Capture, assertActive: () => void): Promise<void> {
  assertActive();
  if (captures.get(database) !== captured || captured.state !== 'applying'
    || canonical(await connectionIdentity(database)) !== canonical(captured.identity)) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  assertActive();
}

async function checkSchema(database: SqlConnection, schema: string): Promise<void> {
  const required = [...NATIVE_FILE_SIDE_EFFECT_ROW_SPECS.map(spec => spec.table), 'collaboration_native_file_operation_intents',
    'collaboration_native_file_operation_receipts', 'collaboration_native_file_operation_side_effect_stages',
    'collaboration_native_file_operation_side_effect_receipts', 'collaboration_admission_requests', 'collaboration_agent_operations'];
  for (const name of required) {
    const row = await database.get(`SELECT to_regclass($1)::oid=to_regclass($2)::oid AS same_relation`, [name, table(schema, name)]) as Row | undefined;
    if (row?.same_relation !== true) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  }
  for (const spec of NATIVE_FILE_SIDE_EFFECT_ROW_SPECS) if (spec.columns.length) {
    const rows = await database.all(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name LIMIT 65`, [schema, spec.table]) as Row[];
    if (canonical(rows.map(row => row.column_name).sort()) !== canonical([...spec.columns].sort())) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  }
}

async function checkIntentBudget(database: SqlConnection, schema: string, operationId: string): Promise<void> {
  const row = await database.get(`SELECT octet_length(intent_text) AS bytes,jsonb_array_length(intent_text::jsonb->'mutations') AS mutations
    FROM ${table(schema, 'collaboration_native_file_operation_intents')} WHERE operation_id=$1 AND octet_length(intent_text)<=$2`, [operationId, MAX_INTENT_BYTES]) as Row | undefined;
  if (!row || !Number.isSafeInteger(row.bytes) || (row.bytes as number) > MAX_INTENT_BYTES
    || !Number.isSafeInteger(row.mutations) || (row.mutations as number) < 1 || (row.mutations as number) > MAX_MUTATIONS) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
}

async function rowsFor(database: SqlConnection, schema: string, workspaceId: string, paths: string[], expectedAfter?: Rows,
  budget = { rows: 0, bytes: 0 }): Promise<Rows> {
  // Old unscoped public links cannot be attributed safely to a native workspace.
  // Their controlled migration is a separate activation gate, never a global revoke.
  if (await database.get(`SELECT 1 AS found FROM ${table(schema, 'public_file_shares')}
    WHERE workspace_id IS NULL AND status='active' AND workspace_path=ANY($1::text[]) LIMIT 1`, [paths])) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  const rows = {} as Rows;
  for (const spec of NATIVE_FILE_SIDE_EFFECT_ROW_SPECS) {
    const ids = expectedAfter && spec.id ? expectedAfter[spec.key].map(row => String(row.id)) : [];
    const parameters = spec.id ? [workspaceId, paths, ids] : [workspaceId, paths];
    const predicate = `workspace_id=$1 AND (${spec.path}=ANY($2::text[]) ${spec.active ? `AND ${spec.active}` : ''} ${spec.id ? 'OR id=ANY($3::text[])' : ''})`;
    // Only aggregate sizes cross this first read. The bounded CASE prevents
    // materializing/hash-encoding any large or unknown private credential row.
    const measured = await database.get(`SELECT count(*)::integer AS rows,coalesce(sum(bytes),0)::bigint AS bytes FROM (
      SELECT CASE WHEN ${spec.bounds} THEN ${spec.columns.map(column => `coalesce(octet_length(${column}::text),0)`).join('+')}
        ELSE ${MAX_PRIVATE_ROW_BYTES + 1} END AS bytes FROM ${table(schema, spec.table)} WHERE ${predicate}
      LIMIT ${MAX_ROWS + 1} FOR UPDATE) bounded`, parameters) as Row | undefined;
    const rowCount = Number(measured?.rows); const rowBytes = Number(measured?.bytes);
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > MAX_ROWS || !Number.isSafeInteger(rowBytes) || rowBytes < 0
      || budget.rows + rowCount > MAX_CAPTURE_ROWS || budget.bytes + rowBytes > MAX_PRIVATE_ROW_BYTES) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
    budget.rows += rowCount; budget.bytes += rowBytes;
    const result = await database.all(`SELECT CASE WHEN ${spec.bounds} THEN ${spec.json} ELSE NULL END AS row_json,${spec.order} AS row_key
      FROM ${table(schema, spec.table)} WHERE workspace_id=$1 AND (
        ${spec.path}=ANY($2::text[]) ${spec.active ? `AND ${spec.active}` : ''}
        ${spec.id ? 'OR id=ANY($3::text[])' : ''}) ORDER BY (${spec.order}) COLLATE "C" LIMIT ${MAX_ROWS + 1} FOR UPDATE`,
    parameters) as Array<{ row_json: Row | null }>;
    if (result.length > MAX_ROWS || result.some(row => !row.row_json || typeof row.row_json !== 'object')) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
    rows[spec.key] = result.map(row => row.row_json!);
    const child = await database.get(`SELECT 1 AS found FROM ${table(schema, spec.table)} WHERE workspace_id=$1 ${spec.active ? `AND ${spec.active}` : ''}
      AND EXISTS(SELECT 1 FROM unnest($2::text[]) scope WHERE left(${spec.path},length(scope)+1)=scope||'/') LIMIT 1`, [workspaceId, paths]);
    if (child) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  }
  boundedText(canonical(rows), MAX_STAGE_BYTES);
  return rows;
}

function pathsFor(effect: Effect): string[] { return [effect.source.path, ...(effect.destinationPath ? [effect.destinationPath] : [])]; }

function checkRows(effect: Effect, actor: Binding['actor'], now: number): void {
  const { beforeRows, source, destinationPath } = effect;
  for (const row of [...beforeRows.metadata, ...beforeRows.userStates, ...beforeRows.guests, ...beforeRows.publicShares]) {
    if (row.path !== source.path || row.workspaceId !== source.workspaceId
      || 'organizationId' in row && row.organizationId !== source.organizationId
      || 'documentId' in row && row.documentId !== source.documentId) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  }
  for (const row of beforeRows.guests) {
    // An unbound legacy invitation gains no authority here: it is only revoked
    // through its existing exact document/path. Older bound generations of the
    // same lineage may also be revoked; they must not permanently block a move.
    if (!Object.hasOwn(row, 'guestBinding')) continue;
    const binding = row.guestBinding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).some(key => !['version','lineageId','lifecycleGeneration'].includes(key))) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
    const target = binding as Row;
    if (target.version !== 1 || target.lineageId !== effect.lineageId
      || !Number.isSafeInteger(target.lifecycleGeneration) || Number(target.lifecycleGeneration) < 1
      || Number(target.lifecycleGeneration) > source.lifecycleGeneration) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  }
  for (const row of beforeRows.locks) {
    if (row.organizationId !== source.organizationId || row.workspaceId !== source.workspaceId
      || row.lineageId !== null && row.path === source.path && row.lineageId !== effect.lineageId) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
    if ((row.expiresAt as number) > now && (row.path === destinationPath
      || row.lockedByUserId !== actor.actorUserId || row.lockedBySessionId !== actor.actorSessionId)) fail('NATIVE_FILE_SIDE_EFFECTS_BUSY');
  }
}

async function assertAgentsIdle(database: SqlConnection, schema: string, documentId: string): Promise<void> {
  if (await database.get(`SELECT operation_id FROM ${table(schema, 'collaboration_agent_operations')}
    WHERE document_id=$1 AND status NOT IN(${terminalAgentStatuses}) LIMIT 1 FOR UPDATE`, [documentId])) fail('NATIVE_FILE_SIDE_EFFECTS_BUSY');
}

/** Called from authorized Handoff.prepare. This records a private before-image
 * inside the already-held transaction, and grants no mutation/room authority. */
export async function captureNativeFileOperationSideEffectsOnConnection(database: SqlConnection, input: {
  workspace: WorkspaceContext; request: CollaborationAdmissionRequest; operationId: string;
}): Promise<{ version: 1; executionReady: false }> {
  if (!validId(input.operationId) || captures.has(database)) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
  assertWorkspace(input.workspace);
  const capturedRequest = captureCollaborationAdmissionRequest(input.request);
  const identity = await connectionIdentity(database);
  await checkSchema(database, identity.schema);
  await checkIntentBudget(database, identity.schema, input.operationId);
  const binding = await readStagedNativeFileOperationBindingOnConnection(database, { request: capturedRequest.request, operationId: input.operationId });
  assertWorkspace(input.workspace, binding.actor);
  if (binding.mutations.length > MAX_MUTATIONS || binding.mutations.some(mutation => mutation.source.workspaceId !== input.workspace.workspaceId
    || mutation.source.organizationId !== input.workspace.organizationId)) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  const selected = binding.mutations.filter(mutation => mutation.kind !== 'link');
  if (selected.length < 1 || selected.length > MAX_EFFECTS) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
  const effects: Effect[] = [];
  const budget = { rows: 0, bytes: 0 };
  const capturedAt = await databaseClock(database);
  const occupiedPaths = new Set<string>();
  for (const mutation of selected) {
    const effect: Effect = { mutationId: mutation.mutationId, kind: mutation.kind, source: mutation.source,
      lineageId: mutation.lineageId, destinationPath: mutation.destinationPath, beforeRows: {} as Rows };
    for (const filePath of pathsFor(effect)) {
      if ([...occupiedPaths].some(other => filePath === other || filePath.startsWith(`${other}/`) || other.startsWith(`${filePath}/`))) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
      occupiedPaths.add(filePath);
    }
    effect.beforeRows = await rowsFor(database, identity.schema, input.workspace.workspaceId, pathsFor(effect), undefined, budget);
    checkRows(effect, binding.actor, capturedAt);
    await assertAgentsIdle(database, identity.schema, effect.source.documentId);
    effects.push(effect);
    boundedText(canonical(effects), MAX_STAGE_BYTES);
  }
  const stage: Stage = { version: 1, operationId: binding.operationId, requestId: binding.requestId, requestDigest: binding.requestDigest,
    action: binding.action, changesBundleProof: binding.changesBundleProof, actor: binding.actor, reviewDigest: binding.reviewDigest,
    capturedAt, mutationIds: binding.mutations.map(mutation => mutation.mutationId), effects };
  const stageText = canonical(stage); boundedText(stageText, MAX_STAGE_BYTES);
  if (canonical(await connectionIdentity(database)) !== canonical(identity)) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  const stageDigest = hash(stageText);
  await database.run(`INSERT INTO ${table(identity.schema, 'collaboration_native_file_operation_side_effect_stages')}
    (operation_id,request_id,stage_text,stage_digest) VALUES($1,$2,$3,$4)`, [stage.operationId, stage.requestId, stageText, stageDigest]);
  captures.set(database, { identity, stage, stageText, stageDigest, state: 'captured' });
  return { version: 1, executionReady: false };
}

function afterRowsFor(effect: Effect, now: number): Rows {
  const after = structuredClone(effect.beforeRows);
  for (const key of ['metadata','userStates'] as const) after[key] = effect.kind === 'archive' ? []
    : after[key].map(row => ({ ...row, path: effect.destinationPath! }));
  after.guests = after.guests.map(row => ({ ...row, status: 'revoked', policyRevision: (row.policyRevision as number) + 1, challengeCleared: true, updatedAt: now }));
  after.publicShares = after.publicShares.map(row => ({ ...row, status: 'revoked', policyRevision: (row.policyRevision as number) + 1,
    revokedAt: now, revokedReason: effect.kind === 'archive' ? 'target_deleted' : 'target_moved', updatedAt: now }));
  after.locks = after.locks.map(row => ({ ...row, path: (row.expiresAt as number) > now && effect.kind === 'move' ? effect.destinationPath! : row.path,
    status: (row.expiresAt as number) <= now ? 'expired' : effect.kind === 'archive' ? 'released' : 'active', updatedAt: now }));
  return after;
}

async function applyRows(database: SqlConnection, schema: string, effect: Effect, after: Rows, now: number, assertActive: () => void): Promise<void> {
  const write = async (sql: string, parameters: unknown[], expected: number) => {
    assertActive(); const result = await database.run(sql, parameters) as { changes?: number };
    assertActive(); if (result.changes !== expected) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
  };
  for (const key of ['metadata','userStates'] as const) {
    const spec = NATIVE_FILE_SIDE_EFFECT_ROW_SPECS.find(candidate => candidate.key === key)!;
    if (effect.kind === 'archive') await write(`DELETE FROM ${table(schema, spec.table)} WHERE workspace_id=$1 AND path=$2`,
      [effect.source.workspaceId, effect.source.path], effect.beforeRows[key].length);
    else await write(`UPDATE ${table(schema, spec.table)} SET path=$1 WHERE workspace_id=$2 AND path=$3`,
      [effect.destinationPath, effect.source.workspaceId, effect.source.path], effect.beforeRows[key].length);
  }
  await write(`UPDATE ${table(schema, 'file_guest_invitations')} SET status='revoked',policy_revision=policy_revision+1,challenge_hash=NULL,updated_at=$1
    WHERE workspace_id=$2 AND id=ANY($3::text[]) AND status='active'`, [now, effect.source.workspaceId, effect.beforeRows.guests.map(row => row.id)], after.guests.length);
  await write(`UPDATE ${table(schema, 'public_file_shares')} SET status='revoked',policy_revision=policy_revision+1,revoked_at=$1,revoked_reason=$2,updated_at=$1
    WHERE workspace_id=$3 AND id=ANY($4::text[]) AND status='active'`, [now, effect.kind === 'archive' ? 'target_deleted' : 'target_moved',
    effect.source.workspaceId, effect.beforeRows.publicShares.map(row => row.id)], after.publicShares.length);
  // Release/expire destination locks before transporting a source lock, keeping
  // the real active-path uniqueness constraint intact without a forced unlock.
  for (const row of [...after.locks].sort((a,b) => (a.status === 'active' ? 1 : 0) - (b.status === 'active' ? 1 : 0))) {
    await write(`UPDATE ${table(schema, 'file_locks')} SET path=$1,status=$2,updated_at=$3 WHERE workspace_id=$4 AND id=$5 AND status='active'`,
      [row.path, row.status, now, effect.source.workspaceId, row.id], 1);
  }
}

/** SAME actual DA04 authority, after all native receipts. No new document claim,
 * transaction, pool connection, forced lock release, or public private-row DTO.
 * executionReady remains false: absent-row writers require the same lifecycle
 * fence, and filesystem publication/undo need separate journaled capabilities. */
export async function applyNativeFileOperationSideEffectsOnConnection(database: SqlConnection, input: {
  workspace: WorkspaceContext; operationId: string;
}): Promise<{ version: 1; nativeFileSideEffectSetProof: string; executionReady: false }> {
  const captured = captures.get(database);
  if (!captured || captured.state !== 'captured' || input.operationId !== captured.stage.operationId) fail('NATIVE_FILE_SIDE_EFFECTS_STAGE_REQUIRED');
  captured.state = 'applying';
  return withCollaborationAdmissionMutation(database, captured.stage.action, async assertActive => {
    assertWorkspace(input.workspace, captured.stage.actor);
    const { workspaceId, organizationId } = input.workspace;
    if (captured.stage.effects.some(effect => effect.source.workspaceId !== workspaceId
      || effect.source.organizationId !== organizationId)) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
    await assertConnection(database, captured, assertActive);
    const request = requireCollaborationAdmissionMutationRequest(database, captured.stage.action);
    if (captureCollaborationAdmissionRequest(request).requestDigest !== captured.stage.requestDigest) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
    await checkSchema(database, captured.identity.schema); await assertConnection(database, captured, assertActive);
    await checkIntentBudget(database, captured.identity.schema, input.operationId); await assertConnection(database, captured, assertActive);
    const bound = await readAppliedNativeFileOperationReceiptBindingsOnConnection(database, captured.stage.action, input.operationId);
    await assertConnection(database, captured, assertActive);
    if (bound.changesBundleProof !== captured.stage.changesBundleProof || bound.requestDigest !== captured.stage.requestDigest
      || canonical(bound.actor) !== canonical(captured.stage.actor) || bound.reviewDigest !== captured.stage.reviewDigest
      || canonical(bound.mutations.map(mutation => mutation.mutationId)) !== canonical(captured.stage.mutationIds)
      || bound.mutations.some(mutation => mutation.source.workspaceId !== workspaceId
        || mutation.source.organizationId !== organizationId)) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
    const now = await databaseClock(database); await assertConnection(database, captured, assertActive);
    const effects = [];
    for (const effect of captured.stage.effects) {
      const native = bound.receipts.find(receipt => receipt.mutationId === effect.mutationId);
      if (!native || native.lineageId !== effect.lineageId || canonical(native.source) !== canonical(effect.source)) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
      const before = await rowsFor(database, captured.identity.schema, effect.source.workspaceId, pathsFor(effect));
      await assertConnection(database, captured, assertActive);
      if (canonical(before) !== canonical(effect.beforeRows)) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
      checkRows(effect, captured.stage.actor, now);
      await assertAgentsIdle(database, captured.identity.schema, effect.source.documentId); await assertConnection(database, captured, assertActive);
      const afterRows = afterRowsFor(effect, now);
      await applyRows(database, captured.identity.schema, effect, afterRows, now, assertActive);
      const actual = await rowsFor(database, captured.identity.schema, effect.source.workspaceId, pathsFor(effect), afterRows);
      await assertConnection(database, captured, assertActive);
      if (canonical(actual) !== canonical(afterRows)) fail('NATIVE_FILE_SIDE_EFFECTS_SCOPE_CHANGED');
      effects.push({ mutationId: effect.mutationId, source: effect.source, lineageId: effect.lineageId,
        nativeReceiptDigest: native.receiptDigest, after: { identity: native.after.identity, status: native.after.status },
        beforeRows: effect.beforeRows, afterRows });
    }
    const { effects: _beforeEffects, ...header } = captured.stage;
    const receiptText = canonical({ ...header, stageDigest: captured.stageDigest, nativeReceiptSetProof: bound.receiptSetProof, createdAt: now, effects });
    boundedText(receiptText, 2 * MAX_STAGE_BYTES);
    const receiptDigest = hash(receiptText);
    await database.run(`INSERT INTO ${table(captured.identity.schema, 'collaboration_native_file_operation_side_effect_receipts')}
      (operation_id,request_id,stage_digest,native_receipt_set_proof,receipt_text,receipt_digest) VALUES($1,$2,$3,$4,$5,$6)`,
    [captured.stage.operationId, captured.stage.requestId, captured.stageDigest, bound.receiptSetProof, receiptText, receiptDigest]);
    await assertConnection(database, captured, assertActive);
    captures.delete(database);
    return { version: 1, nativeFileSideEffectSetProof: proofFor(receiptDigest), executionReady: false };
  });
}

/** Trusted coordinator recovery read after fresh authorization. Certifies the
 * initial entire SQL commit; it exposes no rows and never replays side effects. */
export async function readCommittedNativeFileOperationSideEffectsOnConnection(database: SqlConnection, input: {
  request: CollaborationAdmissionRequest; operationId: string; actor: Binding['actor'];
}): Promise<{ version: 1; nativeFileSideEffectSetProof: string; executionReady: false } | null> {
  if (!validId(input.operationId)) fail('NATIVE_FILE_SIDE_EFFECTS_INVALID');
  const captured = captureCollaborationAdmissionRequest(input.request);
  const identity = await connectionIdentity(database);
  await checkSchema(database, identity.schema);
  const row = await database.get(`SELECT r.receipt_text,r.receipt_digest,r.stage_digest,r.native_receipt_set_proof,s.stage_text,s.stage_digest AS actual_stage_digest
    FROM ${table(identity.schema, 'collaboration_native_file_operation_side_effect_receipts')} r
    JOIN ${table(identity.schema, 'collaboration_native_file_operation_side_effect_stages')} s USING(operation_id)
    WHERE r.operation_id=$1 AND r.request_id=$2 AND octet_length(r.receipt_text)<=2097152 AND octet_length(s.stage_text)<=1048576`, [input.operationId, captured.request.requestId]) as Row | undefined;
  if (!row) return null;
  boundedText(row.receipt_text, 2 * MAX_STAGE_BYTES); boundedText(row.stage_text, MAX_STAGE_BYTES);
  if (hash(row.receipt_text) !== row.receipt_digest || hash(row.stage_text) !== row.stage_digest || row.stage_digest !== row.actual_stage_digest) fail('NATIVE_FILE_SIDE_EFFECTS_UNCONFIRMED');
  const receipt = JSON.parse(row.receipt_text) as Receipt;
  const stage = JSON.parse(row.stage_text) as Stage;
  const { effects: receiptEffects, stageDigest, nativeReceiptSetProof: _nativeProof, createdAt, ...receiptHeader } = receipt;
  const { effects: stageEffects, ...stageHeader } = stage;
  if (receipt.operationId !== input.operationId || receipt.requestId !== captured.request.requestId || receipt.requestDigest !== captured.requestDigest
    || canonical(receipt.actor) !== canonical(input.actor) || canonical(stage.actor) !== canonical(input.actor)
    || receipt.version !== 1 || stage.version !== 1 || canonical(receiptHeader) !== canonical(stageHeader) || stageDigest !== row.stage_digest
    || !Number.isSafeInteger(createdAt) || createdAt < stage.capturedAt || !Number.isSafeInteger(stage.capturedAt)
    || !Array.isArray(stage.mutationIds) || stage.mutationIds.length < 1 || stage.mutationIds.length > MAX_MUTATIONS
    || stage.mutationIds.some(id => !validId(id)) || new Set(stage.mutationIds).size !== stage.mutationIds.length
    || !Array.isArray(stageEffects) || stageEffects.length < 1 || stageEffects.length > MAX_EFFECTS
    || !Array.isArray(receiptEffects) || receiptEffects.length !== stageEffects.length
    || new Set(receiptEffects.map(effect => effect.mutationId)).size !== receiptEffects.length) fail('NATIVE_FILE_SIDE_EFFECTS_UNCONFIRMED');
  for (const effect of receiptEffects) {
    const original = stageEffects.find(candidate => candidate.mutationId === effect.mutationId);
    if (!original || !stage.mutationIds.includes(effect.mutationId) || canonical(effect.source) !== canonical(original.source)
      || effect.lineageId !== original.lineageId || canonical(effect.beforeRows) !== canonical(original.beforeRows)
      || canonical(effect.afterRows) !== canonical(afterRowsFor(original, createdAt))) fail('NATIVE_FILE_SIDE_EFFECTS_UNCONFIRMED');
  }
  const outcome = await readCollaborationAdmissionOutcome(database, captured);
  if (!outcome || outcome.result.nativeFileSideEffectSetProof !== proofFor(String(row.receipt_digest))
    || outcome.result.nativeFileReceiptSetProof !== row.native_receipt_set_proof || receipt.nativeReceiptSetProof !== row.native_receipt_set_proof) fail('NATIVE_FILE_SIDE_EFFECTS_UNCONFIRMED');
  const nativeRows = await database.all(`SELECT mutation_id,receipt_digest FROM ${table(identity.schema, 'collaboration_native_file_operation_receipts')}
    WHERE operation_id=$1 ORDER BY mutation_id COLLATE "C" LIMIT ${MAX_MUTATIONS + 1}`, [input.operationId]) as Row[];
  if (nativeRows.length !== stage.mutationIds.length || nativeRows.some((native,index) => native.mutation_id !== stage.mutationIds[index])
    || receiptEffects.some(effect => nativeRows.find(native => native.mutation_id === effect.mutationId)?.receipt_digest !== effect.nativeReceiptDigest)
    || hash('canvas.native-file-receipt-set.v1\n' + nativeRows.map(native => `${native.mutation_id}\t${native.receipt_digest}`).join('\n')) !== row.native_receipt_set_proof
    || canonical(await connectionIdentity(database)) !== canonical(identity)) fail('NATIVE_FILE_SIDE_EFFECTS_UNCONFIRMED');
  return { version: 1, nativeFileSideEffectSetProof: proofFor(String(row.receipt_digest)), executionReady: false };
}
