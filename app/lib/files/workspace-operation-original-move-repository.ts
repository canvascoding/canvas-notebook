import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '../db';

/** Mechanical original records, not an execution/actor/Claim/DA04 capability.
 * The caller retains its actual transaction and header locks through every
 * operation. No checkout, BEGIN/COMMIT, cleanup or domain JSON authority here. */
export type WorkspaceOperationOriginalMoveIntent = Readonly<{
  batchId: string; planId: string; workspaceId: string; requestHash: string;
  intentText: string; intentDigest: string; createdAt: number;
}>;
export type WorkspaceOperationOriginalMoveReceipt = Readonly<{
  batchId: string; intentDigest: string; receiptText: string; receiptDigest: string; createdAt: number;
}>;
export type WorkspaceOperationOriginalMoveParentReceipt = WorkspaceOperationOriginalMoveReceipt & Readonly<{
  parentKey: string; parentPath: string; producerStep: string;
  consumerBindingsText: string; consumerBindingsDigest: string;
}>;
export type WorkspaceOperationOriginalMovePathReceipt = WorkspaceOperationOriginalMoveReceipt & Readonly<{ stepKey: string }>;
export type WorkspaceOperationOriginalMoveInsertResult<T> = Readonly<{ kind: 'created' | 'existing'; row: T }>
  | Readonly<{ kind: 'conflict' }>;
type ReadInput = Readonly<{ schema: string; batchId: string; forShare?: true; forUpdate?: true }>;
type OriginalInput = ReadInput & Readonly<{ intentDigest: string }>;
type ParentRead = OriginalInput & Readonly<{ parentPath: string }>;
type PathRead = OriginalInput & Readonly<{ stepKey: string }>;
// maxTotalBytes bounds UTF-8 receipt/consumer payload only. Identifiers remain
// separately bounded; the Owner/domain codec must enforce the complete budget.
type ListInput = OriginalInput & Readonly<{ maxRows?: number; maxTotalBytes?: number }>;
type IntentInput = Readonly<{ schema: string; batchId: string; planId: string; workspaceId: string; requestHash: string; intentText: string }>;
type ReceiptInput = Readonly<{ schema: string; batchId: string; intentDigest: string; receiptText: string }>;
type ParentInput = ReceiptInput & Readonly<{ parentPath: string; producerStep: string; consumerBindingsText: string }>;
type PathInput = ReceiptInput & Readonly<{ stepKey: string }>;
type Row = Record<string, unknown>;
type Kind = 'parent' | 'path' | 'final';
type Receipt = WorkspaceOperationOriginalMoveReceipt | WorkspaceOperationOriginalMoveParentReceipt | WorkspaceOperationOriginalMovePathReceipt;
const MiB = 1024 * 1024;
const limits = { intent: 16 * MiB, parent: MiB, path: 64 * MiB, final: MiB, listRows: 1000, listBytes: 64 * MiB } as const;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const tables = { parent: 'workspace_file_operation_move_parent_receipts', path: 'workspace_file_operation_move_path_receipts',
  final: 'workspace_file_operation_move_receipts' } as const;
const conflict = Object.freeze({ kind: 'conflict' as const });
export class WorkspaceOperationOriginalMoveRepositoryError extends Error {
  readonly status = 409;
  constructor(readonly code: 'ORIGINAL_MOVE_REPOSITORY_INVALID' | 'ORIGINAL_MOVE_REPOSITORY_CHANGED' | 'ORIGINAL_MOVE_REPOSITORY_LIMIT') {
    super('Original Move records could not be confirmed.'); this.name = 'WorkspaceOperationOriginalMoveRepositoryError';
  }
}
function fail(code: WorkspaceOperationOriginalMoveRepositoryError['code'] = 'ORIGINAL_MOVE_REPOSITORY_INVALID'): never {
  throw new WorkspaceOperationOriginalMoveRepositoryError(code);
}
function data(input: unknown, required: readonly string[], optional: readonly string[] = []): Row {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length > required.length + optional.length || required.some(key => !Object.hasOwn(input, key))) fail();
  const result: Row = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function field(row: unknown, key: string): unknown {
  if (!row || Object.getPrototypeOf(row) !== Object.prototype) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
  return descriptor.value;
}
function id(value: unknown, min = 1, max = 256): string {
  if (typeof value !== 'string' || value.length > max * 2 || Array.from(value).length < min || Array.from(value).length > max
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString('utf8') !== value) fail();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/u.test(value)) fail(); return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')
    || Buffer.byteLength(value) > max || Buffer.from(value).toString('utf8') !== value) fail(); return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail(); return value;
}
function count(value: unknown, max: number): number {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/u.test(value)) return integer(Number(value), 0, max);
  return integer(value, 0, max);
}
function schema(value: unknown): string {
  const name = text(value, 63); if (/[\u0000-\u001f\u007f]/u.test(name)) fail(); return `"${name.replaceAll('"', '""')}"`;
}
function parentPath(value: unknown): string {
  const name = text(value, 4096), parts = name.split('/');
  if (parts.length > 33 || /[\\\u0000-\u001f\u007f]/u.test(name)
    || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) fail(); return name;
}
function consumers(value: unknown): string {
  const raw = text(value, MiB);
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { fail(); }
  // Contents intentionally remain opaque domain JSON: shared parents may bind
  // native absence, other steps or later domain variants without relabeling births.
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 1000) fail(); return raw;
}
function selection(input: unknown, extra: readonly string[] = [], list = false, original = true): Row & {
  schema: string; batchId: string; intentDigest: string | undefined; lock: string; maxRows?: number; maxTotalBytes?: number;
} {
  const captured = data(input, ['schema', 'batchId', ...(original ? ['intentDigest'] : []), ...extra],
    ['forShare', 'forUpdate', ...(list ? ['maxRows', 'maxTotalBytes'] : [])]);
  if (captured.forShare !== undefined && captured.forShare !== true || captured.forUpdate !== undefined && captured.forUpdate !== true
    || captured.forShare && captured.forUpdate) fail();
  return { ...captured, schema: schema(captured.schema), batchId: id(captured.batchId, 16, 128),
    intentDigest: original ? digest(captured.intentDigest) : undefined,
    lock: captured.forUpdate ? ' FOR UPDATE NOWAIT' : ' FOR SHARE NOWAIT',
    ...(list ? { maxRows: captured.maxRows === undefined ? limits.listRows : integer(captured.maxRows, 1, limits.listRows),
      maxTotalBytes: captured.maxTotalBytes === undefined ? limits.listBytes : integer(captured.maxTotalBytes, 1, limits.listBytes) } : {}) };
}
const intentColumns = `batch_id AS "batchId",plan_id AS "planId",workspace_id AS "workspaceId",request_hash AS "requestHash",
  CASE WHEN octet_length(intent_text) BETWEEN 1 AND ${limits.intent} THEN intent_text ELSE NULL END AS "intentText",
  intent_digest AS "intentDigest",created_at AS "createdAt"`;
function receiptColumns(kind: Kind, prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  const total = `octet_length(${p}receipt_text)${kind === 'parent' ? `+octet_length(${p}consumer_bindings_text)` : ''}`;
  return `${p}batch_id AS "batchId",${p}intent_digest AS "intentDigest",
    CASE WHEN ${total} BETWEEN 1 AND ${limits[kind]} THEN ${p}receipt_text ELSE NULL END AS "receiptText",
    ${p}receipt_digest AS "receiptDigest",${p}created_at AS "createdAt"${kind === 'parent' ? `,
    ${p}parent_key AS "parentKey",${p}parent_path AS "parentPath",${p}producer_step AS "producerStep",
    CASE WHEN ${total} BETWEEN 1 AND ${limits.parent} THEN ${p}consumer_bindings_text ELSE NULL END AS "consumerBindingsText",
    ${p}consumer_bindings_digest AS "consumerBindingsDigest"` : kind === 'path' ? `,${p}step_key AS "stepKey"` : ''}`;
}
function intentRow(row: unknown): WorkspaceOperationOriginalMoveIntent {
  const intentText = text(field(row, 'intentText'), limits.intent), intentDigest = digest(field(row, 'intentDigest'));
  if (hash(intentText) !== intentDigest) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
  return Object.freeze({ batchId: id(field(row, 'batchId'), 16, 128), planId: digest(field(row, 'planId')),
    workspaceId: id(field(row, 'workspaceId')), requestHash: digest(field(row, 'requestHash')), intentText, intentDigest,
    createdAt: count(field(row, 'createdAt'), Number.MAX_SAFE_INTEGER - 1) });
}
function receiptRow(kind: Kind, row: unknown): Receipt {
  const receiptText = text(field(row, 'receiptText'), limits[kind]), receiptDigest = digest(field(row, 'receiptDigest'));
  if (hash(receiptText) !== receiptDigest) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
  const base = { batchId: id(field(row, 'batchId'), 16, 128), intentDigest: digest(field(row, 'intentDigest')),
    receiptText, receiptDigest, createdAt: count(field(row, 'createdAt'), Number.MAX_SAFE_INTEGER - 1) };
  if (kind === 'parent') {
    const literal = parentPath(field(row, 'parentPath')), parentKey = digest(field(row, 'parentKey'));
    const consumerBindingsText = consumers(field(row, 'consumerBindingsText')), consumerBindingsDigest = digest(field(row, 'consumerBindingsDigest'));
    if (parentKey !== hash(literal) || consumerBindingsDigest !== hash(consumerBindingsText)
      || Buffer.byteLength(receiptText) + Buffer.byteLength(consumerBindingsText) > limits.parent) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
    return Object.freeze({ ...base, parentKey, parentPath: literal, producerStep: id(field(row, 'producerStep')), consumerBindingsText, consumerBindingsDigest });
  }
  return Object.freeze(kind === 'path' ? { ...base, stepKey: id(field(row, 'stepKey')) } : base);
}
async function header(database: SqlConnection, selected: ReturnType<typeof selection>, write = false): Promise<boolean> {
  const row = await database.get(`SELECT intent_digest AS "intentDigest" FROM ${selected.schema}.workspace_file_operation_move_intents
    WHERE batch_id=$1${write ? ' FOR UPDATE NOWAIT' : selected.lock}`, [selected.batchId]);
  return !!row && digest(field(row, 'intentDigest')) === selected.intentDigest;
}

export async function readWorkspaceOperationOriginalMoveIntentOnConnection(database: SqlConnection, input: ReadInput): Promise<WorkspaceOperationOriginalMoveIntent | null> {
  const selected = selection(input, [], false, false);
  const row = await database.get(`SELECT ${intentColumns} FROM ${selected.schema}.workspace_file_operation_move_intents WHERE batch_id=$1${selected.lock}`, [selected.batchId]);
  if (!row) return null;
  const value = intentRow(row); if (value.batchId !== selected.batchId) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED'); return value;
}
export async function insertWorkspaceOperationOriginalMoveIntentOnConnection(database: SqlConnection, input: IntentInput): Promise<WorkspaceOperationOriginalMoveInsertResult<WorkspaceOperationOriginalMoveIntent>> {
  const raw = data(input, ['schema', 'batchId', 'planId', 'workspaceId', 'requestHash', 'intentText']);
  const selected = { schema: schema(raw.schema), batchId: id(raw.batchId, 16, 128), planId: digest(raw.planId), workspaceId: id(raw.workspaceId),
    requestHash: digest(raw.requestHash), intentText: text(raw.intentText, limits.intent) };
  const intentDigest = hash(selected.intentText);
  // Lock the original batch even before the header exists. Caller retains this
  // transaction; ON CONFLICT plus exact reread handles identical competing inserts.
  if (!await database.get(`SELECT batch_id FROM ${selected.schema}.workspace_file_operation_batches WHERE batch_id=$1 FOR UPDATE NOWAIT`, [selected.batchId])) return conflict;
  const inserted = await database.get(`INSERT INTO ${selected.schema}.workspace_file_operation_move_intents
    (batch_id,plan_id,workspace_id,request_hash,intent_text,intent_digest) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(batch_id) DO NOTHING RETURNING ${intentColumns}`,
  [selected.batchId, selected.planId, selected.workspaceId, selected.requestHash, selected.intentText, intentDigest]);
  const current = await readWorkspaceOperationOriginalMoveIntentOnConnection(database, { schema: raw.schema as string, batchId: selected.batchId, forShare: true });
  if (!current || current.planId !== selected.planId || current.workspaceId !== selected.workspaceId || current.requestHash !== selected.requestHash
    || current.intentText !== selected.intentText || current.intentDigest !== intentDigest
    || inserted && JSON.stringify(intentRow(inserted)) !== JSON.stringify(current)) return conflict;
  return Object.freeze({ kind: inserted ? 'created' : 'existing', row: current });
}
async function readReceipt(database: SqlConnection, input: OriginalInput | ParentRead | PathRead, kind: Kind): Promise<Receipt | null> {
  const selected = selection(input, kind === 'parent' ? ['parentPath'] : kind === 'path' ? ['stepKey'] : []);
  const literal = kind === 'parent' ? parentPath(selected.parentPath) : kind === 'path' ? id(selected.stepKey) : null;
  if (!await header(database, selected)) return null;
  const key = kind === 'parent' ? 'parent_key' : kind === 'path' ? 'step_key' : null;
  const row = await database.get(`SELECT ${receiptColumns(kind)} FROM ${selected.schema}.${tables[kind]}
    WHERE batch_id=$1 AND intent_digest=$2${key ? ` AND ${key}=$3` : ''}${selected.lock}`,
  [selected.batchId, selected.intentDigest, ...(key ? [kind === 'parent' ? hash(literal!) : literal] : [])]);
  if (!row) return null;
  const value = receiptRow(kind, row);
  if (value.batchId !== selected.batchId || value.intentDigest !== selected.intentDigest
    || kind === 'parent' && (value as WorkspaceOperationOriginalMoveParentReceipt).parentPath !== literal
    || kind === 'path' && (value as WorkspaceOperationOriginalMovePathReceipt).stepKey !== literal) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED'); return value;
}
async function insertReceipt(database: SqlConnection, input: ReceiptInput | ParentInput | PathInput, kind: Kind): Promise<WorkspaceOperationOriginalMoveInsertResult<Receipt>> {
  const raw = data(input, ['schema', 'batchId', 'intentDigest', 'receiptText', ...(kind === 'parent'
    ? ['parentPath', 'producerStep', 'consumerBindingsText'] : kind === 'path' ? ['stepKey'] : [])]);
  const selected = selection({ schema: raw.schema, batchId: raw.batchId, intentDigest: raw.intentDigest });
  const receiptText = text(raw.receiptText, limits[kind]), receiptDigest = hash(receiptText);
  const extra = kind === 'parent' ? { parentPath: parentPath(raw.parentPath), producerStep: id(raw.producerStep), consumerBindingsText: consumers(raw.consumerBindingsText) }
    : kind === 'path' ? { stepKey: id(raw.stepKey) } : {};
  if (kind === 'parent' && Buffer.byteLength(receiptText) + Buffer.byteLength(extra.consumerBindingsText!) > limits.parent) fail();
  if (!await header(database, selected, true)) return conflict;
  const columns = kind === 'parent' ? ',parent_key,parent_path,producer_step,consumer_bindings_text,consumer_bindings_digest' : kind === 'path' ? ',step_key' : '';
  const values = kind === 'parent' ? [hash(extra.parentPath!), extra.parentPath, extra.producerStep, extra.consumerBindingsText, hash(extra.consumerBindingsText!)] : kind === 'path' ? [extra.stepKey] : [];
  const inserted = await database.get(`INSERT INTO ${selected.schema}.${tables[kind]}
    (batch_id,intent_digest,receipt_text,receipt_digest${columns}) VALUES(${Array.from({ length: 4 + values.length }, (_, index) => `$${index + 1}`).join(',')})
    ON CONFLICT(${kind === 'parent' ? 'batch_id,parent_key' : kind === 'path' ? 'batch_id,step_key' : 'batch_id'}) DO NOTHING RETURNING ${receiptColumns(kind)}`,
  [selected.batchId, selected.intentDigest, receiptText, receiptDigest, ...values]);
  const current = await readReceipt(database, { schema: raw.schema as string, batchId: selected.batchId, intentDigest: selected.intentDigest!,
    ...(kind === 'parent' ? { parentPath: extra.parentPath! } : kind === 'path' ? { stepKey: extra.stepKey! } : {}) }, kind);
  if (!current || current.receiptText !== receiptText || current.receiptDigest !== receiptDigest
    || kind === 'parent' && ((current as WorkspaceOperationOriginalMoveParentReceipt).producerStep !== extra.producerStep
      || (current as WorkspaceOperationOriginalMoveParentReceipt).consumerBindingsText !== extra.consumerBindingsText)
    || inserted && JSON.stringify(receiptRow(kind, inserted)) !== JSON.stringify(current)) return conflict;
  return Object.freeze({ kind: inserted ? 'created' : 'existing', row: current });
}

async function listReceipts(database: SqlConnection, input: ListInput, kind: 'parent' | 'path'): Promise<Receipt[] | null> {
  const selected = selection(input, [], true), maxRows = selected.maxRows!, maxTotalBytes = selected.maxTotalBytes!;
  if (!await header(database, selected)) return null;
  const order = kind === 'parent' ? 'parent_key' : 'step_key';
  const size = `octet_length(receipt_text)${kind === 'parent' ? '+octet_length(consumer_bindings_text)' : ''}`;
  // The limited rows and aggregate byte gate share ONE SQL snapshot. A gated
  // lateral relation emits no payload when either bound fails, including a
  // concurrent append. The materialized relation contains KEYS/LENGTHS only;
  // no TOAST/tuplestore behavior is relied upon to defer payload allocation.
  const rows = await database.all(`WITH bounded AS MATERIALIZED (
    SELECT batch_id,intent_digest,${order},(${size})::bigint AS payload_bytes
    FROM ${selected.schema}.${tables[kind]} WHERE batch_id=$1 AND intent_digest=$2
    ORDER BY ${order} COLLATE "C" LIMIT $3${selected.lock}
  ), measured AS MATERIALIZED (SELECT count(*)::integer AS row_count,coalesce(sum(payload_bytes),0)::bigint AS byte_count FROM bounded)
  SELECT measured.row_count AS "_rowCount",measured.byte_count AS "_byteCount",${receiptColumns(kind, 'payload')}
  FROM measured LEFT JOIN LATERAL (SELECT stored.* FROM bounded witness JOIN ${selected.schema}.${tables[kind]} stored
    ON stored.batch_id=witness.batch_id AND stored.intent_digest=witness.intent_digest AND stored.${order}=witness.${order}
    WHERE measured.row_count<=$4 AND measured.byte_count<=$5
    ORDER BY stored.${order} COLLATE "C") payload ON true ORDER BY payload.${order} COLLATE "C"`,
  [selected.batchId, selected.intentDigest, maxRows + 1, maxRows, maxTotalBytes]);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > maxRows + 1) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
  const rowCount = count(field(rows[0], '_rowCount'), Number.MAX_SAFE_INTEGER - 1), byteCount = count(field(rows[0], '_byteCount'), Number.MAX_SAFE_INTEGER - 1);
  if (rowCount > maxRows || byteCount > maxTotalBytes) fail('ORIGINAL_MOVE_REPOSITORY_LIMIT');
  if (rowCount === 0) { if (rows.length !== 1 || field(rows[0], 'batchId') !== null || byteCount !== 0) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED'); return []; }
  if (rows.length !== rowCount) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
  const result = rows.map(row => {
    if (count(field(row, '_rowCount'), maxRows) !== rowCount || count(field(row, '_byteCount'), maxTotalBytes) !== byteCount) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
    const value = receiptRow(kind, row); if (value.batchId !== selected.batchId || value.intentDigest !== selected.intentDigest) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED'); return value;
  });
  const keys = result.map(row => kind === 'parent' ? (row as WorkspaceOperationOriginalMoveParentReceipt).parentKey : (row as WorkspaceOperationOriginalMovePathReceipt).stepKey);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0
    && Buffer.compare(Buffer.from(key, 'utf8'), Buffer.from(keys[index - 1], 'utf8')) <= 0)) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
  const actualBytes = result.reduce((sum, row) => sum + Buffer.byteLength(row.receiptText)
    + (kind === 'parent' ? Buffer.byteLength((row as WorkspaceOperationOriginalMoveParentReceipt).consumerBindingsText) : 0), 0);
  if (actualBytes !== byteCount) fail('ORIGINAL_MOVE_REPOSITORY_CHANGED');
  return result;
}
export const readWorkspaceOperationOriginalMoveParentReceiptOnConnection = (database: SqlConnection, input: ParentRead) =>
  readReceipt(database, input, 'parent') as Promise<WorkspaceOperationOriginalMoveParentReceipt | null>;
export const insertWorkspaceOperationOriginalMoveParentReceiptOnConnection = (database: SqlConnection, input: ParentInput) =>
  insertReceipt(database, input, 'parent') as Promise<WorkspaceOperationOriginalMoveInsertResult<WorkspaceOperationOriginalMoveParentReceipt>>;
export const listWorkspaceOperationOriginalMoveParentReceiptsOnConnection = (database: SqlConnection, input: ListInput) =>
  listReceipts(database, input, 'parent') as Promise<WorkspaceOperationOriginalMoveParentReceipt[] | null>;
export const readWorkspaceOperationOriginalMovePathReceiptOnConnection = (database: SqlConnection, input: PathRead) =>
  readReceipt(database, input, 'path') as Promise<WorkspaceOperationOriginalMovePathReceipt | null>;
export const insertWorkspaceOperationOriginalMovePathReceiptOnConnection = (database: SqlConnection, input: PathInput) =>
  insertReceipt(database, input, 'path') as Promise<WorkspaceOperationOriginalMoveInsertResult<WorkspaceOperationOriginalMovePathReceipt>>;
export const listWorkspaceOperationOriginalMovePathReceiptsOnConnection = (database: SqlConnection, input: ListInput) =>
  listReceipts(database, input, 'path') as Promise<WorkspaceOperationOriginalMovePathReceipt[] | null>;
export const readWorkspaceOperationOriginalMoveReceiptOnConnection = (database: SqlConnection, input: OriginalInput) =>
  readReceipt(database, input, 'final') as Promise<WorkspaceOperationOriginalMoveReceipt | null>;
export const insertWorkspaceOperationOriginalMoveReceiptOnConnection = (database: SqlConnection, input: ReceiptInput) =>
  insertReceipt(database, input, 'final') as Promise<WorkspaceOperationOriginalMoveInsertResult<WorkspaceOperationOriginalMoveReceipt>>;
