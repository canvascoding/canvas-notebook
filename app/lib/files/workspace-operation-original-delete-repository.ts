import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '../db';

export type WorkspaceOperationOriginalDeleteIntent = Readonly<{
  batchId: string; planId: string; workspaceId: string; requestHash: string;
  intentText: string; intentDigest: string; createdAt: number;
}>;
export type WorkspaceOperationOriginalDeleteReceipt = Readonly<{
  batchId: string; intentDigest: string; receiptText: string; receiptDigest: string; createdAt: number;
}>;
export type WorkspaceOperationOriginalDeleteInsertResult<T> =
  | Readonly<{ kind: 'created' | 'existing'; row: T }>
  | Readonly<{ kind: 'conflict' }>;

type ReadInput = Readonly<{ schema: string; batchId: string; forShare?: true; forUpdate?: true }>;
type IntentInput = Readonly<{ schema: string; batchId: string; planId: string; workspaceId: string;
  requestHash: string; intentText: string }>;
type ReceiptInput = Readonly<{ schema: string; batchId: string; intentDigest: string; receiptText: string }>;
type Row = Record<string, unknown>;
type IntentTable = 'workspace_file_operation_delete_intents' | 'workspace_file_operation_restore_intents';
type ReceiptTable = 'workspace_file_operation_delete_trash_receipts' | 'workspace_file_operation_delete_receipts'
  | 'workspace_file_operation_restore_receipts';
const intentColumns = `batch_id AS "batchId",plan_id AS "planId",workspace_id AS "workspaceId",request_hash AS "requestHash",
  intent_text AS "intentText",intent_digest AS "intentDigest",created_at AS "createdAt"`;
const receiptColumns = `batch_id AS "batchId",intent_digest AS "intentDigest",receipt_text AS "receiptText",
  receipt_digest AS "receiptDigest",created_at AS "createdAt"`;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Capture only own primitive data before the first await. The service, rather
 * than this mechanical repository, validates the private target JSON schema. */
function data(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)
      || !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) {
    throw new TypeError('Invalid original Delete repository input.');
  }
  const captured: Row = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid original Delete data field.');
    captured[key] = descriptor.value;
  }
  return captured;
}

/** One raw schema identifier, quoted here. This conveys no realm/Owner proof. */
function schemaName(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 63
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TypeError('Invalid original Delete schema identifier.');
  }
  return `"${value.replaceAll('"', '""')}"`;
}
function id(value: unknown, minimum = 1, maximum = 256): string {
  if (typeof value !== 'string' || Array.from(value).length < minimum || Array.from(value).length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new TypeError('Invalid original Delete identifier.');
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError('Invalid original Delete digest.');
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.includes('\u0000') || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > maximum || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TypeError('Invalid original Delete evidence text.');
  }
  return value;
}
function time(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Invalid original Delete timestamp.');
  }
  return Number(value);
}
function intentRow(row: Row): WorkspaceOperationOriginalDeleteIntent {
  const intentText = text(row.intentText, 1048576), intentDigest = digest(row.intentDigest);
  if (hash(intentText) !== intentDigest) throw new TypeError('Original Delete intent digest mismatch.');
  return Object.freeze({ batchId: id(row.batchId, 16, 128), planId: digest(row.planId), workspaceId: id(row.workspaceId),
    requestHash: digest(row.requestHash), intentText, intentDigest, createdAt: time(row.createdAt) });
}
function receiptRow(row: Row): WorkspaceOperationOriginalDeleteReceipt {
  const receiptText = text(row.receiptText, 2097152), receiptDigest = digest(row.receiptDigest);
  if (hash(receiptText) !== receiptDigest) throw new TypeError('Original Delete receipt digest mismatch.');
  return Object.freeze({ batchId: id(row.batchId, 16, 128), intentDigest: digest(row.intentDigest),
    receiptText, receiptDigest, createdAt: time(row.createdAt) });
}
function selection(input: ReadInput): { schema: string; batchId: string; lock: string } {
  const captured = data(input, ['schema', 'batchId', 'forShare', 'forUpdate']);
  if (captured.forShare !== undefined && captured.forShare !== true
    || captured.forUpdate !== undefined && captured.forUpdate !== true || captured.forShare && captured.forUpdate) {
    throw new TypeError('Choose one original Delete row lock.');
  }
  return { schema: schemaName(captured.schema), batchId: id(captured.batchId, 16, 128),
    lock: captured.forUpdate ? ' FOR UPDATE NOWAIT' : captured.forShare ? ' FOR SHARE NOWAIT' : '' };
}

/** Borrowed B only: no checkout, transaction, cleanup or authority grant. */
export async function readWorkspaceOperationOriginalDeleteIntentOnConnection(database: SqlConnection,
  input: ReadInput): Promise<WorkspaceOperationOriginalDeleteIntent | null> {
  return readIntent(database, input, 'workspace_file_operation_delete_intents');
}
async function readIntent(database: SqlConnection, input: ReadInput, table: IntentTable): Promise<WorkspaceOperationOriginalDeleteIntent | null> {
  const selected = selection(input);
  const row = await database.get(`SELECT ${intentColumns} FROM ${selected.schema}.${table}
    WHERE batch_id=$1${selected.lock}`, [selected.batchId]) as Row | undefined;
  return row ? intentRow(row) : null;
}
async function readReceipt(database: SqlConnection, input: ReadInput, table: ReceiptTable): Promise<WorkspaceOperationOriginalDeleteReceipt | null> {
  const selected = selection(input);
  const row = await database.get(`SELECT ${receiptColumns} FROM ${selected.schema}.${table}
    WHERE batch_id=$1${selected.lock}`, [selected.batchId]) as Row | undefined;
  return row ? receiptRow(row) : null;
}
export async function readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(database: SqlConnection,
  input: ReadInput): Promise<WorkspaceOperationOriginalDeleteReceipt | null> {
  return readReceipt(database, input, 'workspace_file_operation_delete_trash_receipts');
}
export async function readWorkspaceOperationOriginalDeleteReceiptOnConnection(database: SqlConnection,
  input: ReadInput): Promise<WorkspaceOperationOriginalDeleteReceipt | null> {
  return readReceipt(database, input, 'workspace_file_operation_delete_receipts');
}
export async function readWorkspaceOperationOriginalRestoreIntentOnConnection(database: SqlConnection,
  input: ReadInput): Promise<WorkspaceOperationOriginalDeleteIntent | null> {
  return readIntent(database, input, 'workspace_file_operation_restore_intents');
}
export async function readWorkspaceOperationOriginalRestoreReceiptOnConnection(database: SqlConnection,
  input: ReadInput): Promise<WorkspaceOperationOriginalDeleteReceipt | null> {
  return readReceipt(database, input, 'workspace_file_operation_restore_receipts');
}

/** Preserve exact original text on retry; equal JSON with different bytes is a
 * conflict. Even a successful INSERT is checked against an actual B reread. */
export async function insertWorkspaceOperationOriginalDeleteIntentOnConnection(database: SqlConnection,
  input: IntentInput): Promise<WorkspaceOperationOriginalDeleteInsertResult<WorkspaceOperationOriginalDeleteIntent>> {
  return insertIntent(database, input, 'workspace_file_operation_delete_intents');
}
async function insertIntent(database: SqlConnection, input: IntentInput, table: IntentTable):
Promise<WorkspaceOperationOriginalDeleteInsertResult<WorkspaceOperationOriginalDeleteIntent>> {
  const captured = data(input, ['schema', 'batchId', 'planId', 'workspaceId', 'requestHash', 'intentText']);
  const schema = schemaName(captured.schema), batchId = id(captured.batchId, 16, 128), planId = digest(captured.planId),
    workspaceId = id(captured.workspaceId), requestHash = digest(captured.requestHash), intentText = text(captured.intentText, 1048576),
    intentDigest = hash(intentText);
  const inserted = await database.get(`INSERT INTO ${schema}.${table}
    (batch_id,plan_id,workspace_id,request_hash,intent_text,intent_digest)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(batch_id) DO NOTHING RETURNING ${intentColumns}`,
  [batchId, planId, workspaceId, requestHash, intentText, intentDigest]) as Row | undefined;
  const current = await readIntent(database,
    { schema: captured.schema as string, batchId, forShare: true }, table);
  if (!current || current.planId !== planId || current.workspaceId !== workspaceId || current.requestHash !== requestHash
    || current.intentText !== intentText || current.intentDigest !== intentDigest
    || inserted && JSON.stringify(intentRow(inserted)) !== JSON.stringify(current)) return Object.freeze({ kind: 'conflict' });
  return Object.freeze({ kind: inserted ? 'created' : 'existing', row: current });
}

async function insertReceipt(database: SqlConnection, input: ReceiptInput, table: ReceiptTable):
Promise<WorkspaceOperationOriginalDeleteInsertResult<WorkspaceOperationOriginalDeleteReceipt>> {
  const captured = data(input, ['schema', 'batchId', 'intentDigest', 'receiptText']);
  const schema = schemaName(captured.schema), batchId = id(captured.batchId, 16, 128), intentDigest = digest(captured.intentDigest),
    receiptText = text(captured.receiptText, 2097152), receiptDigest = hash(receiptText);
  const inserted = await database.get(`INSERT INTO ${schema}.${table} (batch_id,intent_digest,receipt_text,receipt_digest)
    VALUES($1,$2,$3,$4) ON CONFLICT(batch_id) DO NOTHING RETURNING ${receiptColumns}`,
  [batchId, intentDigest, receiptText, receiptDigest]) as Row | undefined;
  const current = await readReceipt(database, { schema: captured.schema as string, batchId, forShare: true }, table);
  if (!current || current.intentDigest !== intentDigest || current.receiptText !== receiptText || current.receiptDigest !== receiptDigest
    || inserted && JSON.stringify(receiptRow(inserted)) !== JSON.stringify(current)) return Object.freeze({ kind: 'conflict' });
  return Object.freeze({ kind: inserted ? 'created' : 'existing', row: current });
}
export async function insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(database: SqlConnection,
  input: ReceiptInput): Promise<WorkspaceOperationOriginalDeleteInsertResult<WorkspaceOperationOriginalDeleteReceipt>> {
  return insertReceipt(database, input, 'workspace_file_operation_delete_trash_receipts');
}
export async function insertWorkspaceOperationOriginalDeleteReceiptOnConnection(database: SqlConnection,
  input: ReceiptInput): Promise<WorkspaceOperationOriginalDeleteInsertResult<WorkspaceOperationOriginalDeleteReceipt>> {
  return insertReceipt(database, input, 'workspace_file_operation_delete_receipts');
}
export async function insertWorkspaceOperationOriginalRestoreIntentOnConnection(database: SqlConnection,
  input: IntentInput): Promise<WorkspaceOperationOriginalDeleteInsertResult<WorkspaceOperationOriginalDeleteIntent>> {
  return insertIntent(database, input, 'workspace_file_operation_restore_intents');
}
export async function insertWorkspaceOperationOriginalRestoreReceiptOnConnection(database: SqlConnection,
  input: ReceiptInput): Promise<WorkspaceOperationOriginalDeleteInsertResult<WorkspaceOperationOriginalDeleteReceipt>> {
  return insertReceipt(database, input, 'workspace_file_operation_restore_receipts');
}
