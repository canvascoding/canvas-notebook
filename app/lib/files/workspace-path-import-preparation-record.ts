import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { SqlConnection } from '../db';
import { WORKSPACE_PATH_IMPORT_PREPARATION_MIGRATION_STATEMENTS } from '../db/workspace-path-import-preparation-migration';
import { MARKDOWN_FILE_IMPORT_STATEMENTS } from '../db/markdown-file-import-migration';
import type { MarkdownFileImportReceipt } from '../collaboration/markdown-file-import-persistence';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceOperationJobScope, WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationNativeMoveBatchPlan, type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { decodeWorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-native-delete-plan';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { workspaceOperationMcpBatchId } from './workspace-operation-mcp-authorization';
import { workspaceOperationSourceNativeEvidence } from './workspace-operation-mixed-source-evidence';
import { decodeWorkspacePathImportPreparationPlanV1, type WorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import { decodeWorkspacePathHtmlImportPreparationRecordV2, serializeWorkspacePathHtmlImportPreparationRecordV2,
  type WorkspacePathHtmlImportPreparationRecordV2 } from './workspace-path-html-import-record';
import type { WorkspacePathImportPreparationHandle } from './workspace-path-import-preparation-phase';

/** Immutable original B0 facts only. This data never authenticates a request,
 * creates a principal/claim, grants SQL access, or describes today's pathname. */
export type WorkspacePathImportPreparationRecordV1 = Readonly<{
  version: 1; operationId: string; batchId: string;
  origin: Readonly<{ version: 1; kind: 'request' | 'direct-mcp'; userId: string; sessionId: string;
    clientId: string | null; tool: 'move' | 'rename' | 'delete'; scope: WorkspaceOperationJobScope;
    realm: Readonly<{ schemaName: string; schemaOid: number; databaseOid: number }> }>;
  previewPlan: WorkspacePathImportPreparationPlanV1;
  imports: readonly Readonly<{ requirementIndex: number; receipt: MarkdownFileImportReceipt;
    bindingProof: string; initialBinaryHash: string; initialVectorHash: string }>[];
  nativePlan: WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationNativeDeleteBatchPlan;
  b0TransactionId: string; preparedAt: number; recordProof: string;
}>;
type Code = 'PATH_IMPORT_PREPARATION_RECORD_INVALID' | 'PATH_IMPORT_PREPARATION_RECORD_CHANGED'
  | 'PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE' | 'PATH_IMPORT_PREPARATION_RECORD_UNAVAILABLE';
export class WorkspacePathImportPreparationRecordError extends Error {
  readonly status: 409 | 413 | 503;
  constructor(readonly code: Code) {
    super(code); this.name = 'WorkspacePathImportPreparationRecordError';
    this.status = code.endsWith('TOO_LARGE') ? 413 : code.endsWith('UNAVAILABLE') ? 503 : 409;
  }
}
type Row = Record<string, unknown>;
type Locator = Readonly<{ schema: string; workspaceId: string; batchId: string }>;
const recordLimit = 16 * 1024 * 1024;
const receiptLimit = 32768;
const recordKeys = ['version', 'operationId', 'batchId', 'origin', 'previewPlan', 'imports', 'nativePlan', 'b0TransactionId', 'preparedAt', 'recordProof'];
const receiptKeys = ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired'];
const targetKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration',
  'newlineStyle', 'hasBom', 'lineageId', 'initialSequence', 'initialStateProof', 'persistedAt'];
const storageNames = ['workspace_path_import_preparations', 'collaboration_markdown_file_import_receipts'] as const;
const triggerBodies = [
  /\$\$([\s\S]*)\$\$/u.exec(WORKSPACE_PATH_IMPORT_PREPARATION_MIGRATION_STATEMENTS.find(sql =>
    sql.startsWith('CREATE OR REPLACE FUNCTION validate_workspace_path_import_preparation()'))!)?.[1],
  /\$\$([\s\S]*)\$\$/u.exec(MARKDOWN_FILE_IMPORT_STATEMENTS.find(sql =>
    sql.startsWith('CREATE OR REPLACE FUNCTION validate_markdown_file_import_receipt()'))!)?.[1],
];

function workspacePathRecordFailure(code: Code = 'PATH_IMPORT_PREPARATION_RECORD_INVALID'): never {
  throw new WorkspacePathImportPreparationRecordError(code);
}
function captureWorkspacePathRecordData(input: unknown, maximum = recordLimit): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => workspacePathRecordFailure(reason === 'too-large'
    ? 'PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE' : 'PATH_IMPORT_PREPARATION_RECORD_INVALID'), maximum);
}
function workspacePathRecordObject(input: unknown, keys: readonly string[]): Row {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return workspacePathRecordFailure();
  return input as Row;
}
function workspacePathRecordIdentifier(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
}
function workspacePathRecordInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
}
function workspacePathRecordDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
/** Called only after bounded own-data capture. Arrays keep cohort order. */
function workspacePathRecordCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => workspacePathRecordCanonical(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${workspacePathRecordCanonical((value as Row)[key])}`).join(',')}}`;
  const text = JSON.stringify(value); if (typeof text !== 'string') return workspacePathRecordFailure(); return text;
}
function workspacePathRecordFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) workspacePathRecordFreeze(child); Object.freeze(value); }
  return value;
}
function workspacePathRecordReceipt(input: unknown): MarkdownFileImportReceipt {
  const value = workspacePathRecordObject(input, receiptKeys), target = workspacePathRecordObject(value.target, targetKeys);
  if (value.version !== 1 || !workspacePathRecordIdentifier(value.operationId) || value.checkpointRequired !== true
    || !workspacePathRecordDigest(value.requestFingerprint) || !workspacePathRecordDigest(value.sourceHash)
    || !workspacePathRecordInteger(value.sourceBytes, 0, 4 * 1024 * 1024)
    || !['documentId', 'lineageId', 'workspaceId'].every(key => workspacePathRecordIdentifier(target[key]))
    || target.organizationId !== null && !workspacePathRecordIdentifier(target.organizationId)
    || !workspacePathRecordIdentifier(target.path, 4096) || !isCanonicalAdmissionPath(target.path)
    || !/\.(?:md|markdown)$/iu.test(target.path) || typeof target.representation !== 'string'
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(target.representation)
    || target.schemaVersion !== 1 || target.lifecycleGeneration !== 1 || target.initialSequence !== 0
    || typeof target.newlineStyle !== 'string' || !['lf', 'crlf'].includes(target.newlineStyle) || typeof target.hasBom !== 'boolean'
    || !workspacePathRecordInteger(target.persistedAt) || typeof target.initialStateProof !== 'string'
    || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(target.initialStateProof)
    || Buffer.byteLength(workspacePathRecordCanonical(value)) > receiptLimit) return workspacePathRecordFailure();
  return value as MarkdownFileImportReceipt;
}

/** Stable original child IDs. SID never rotates an acknowledged operation.
 * These identifiers are data, never a receipt, principal or import grant. */
export function workspacePathOriginalImportIds(parentOperationId: string, previewPlanId: string, index: number): Readonly<{
  operationId: string; requestId: string;
}> {
  if (typeof parentOperationId !== 'string' || parentOperationId.length < 1 || parentOperationId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(parentOperationId) || Buffer.from(parentOperationId).toString('utf8') !== parentOperationId
    || !workspacePathRecordDigest(previewPlanId) || !workspacePathRecordInteger(index, 0, 9999)) return workspacePathRecordFailure();
  const digest = createHash('sha256').update(JSON.stringify(['workspace-path-original-markdown-import-v1', parentOperationId, previewPlanId, index])).digest('hex');
  return Object.freeze({ operationId: `path-import-${digest}`, requestId: `path-original-import:${digest}` });
}

/** History decoder: all initial identities are facts in the original native
 * plan. No live-state read, source import, rebind, authority or D2 adoption. */
export function decodeWorkspacePathImportPreparationRecordV1(input: unknown): WorkspacePathImportPreparationRecordV1 {
  const originalText = typeof input === 'string' ? input : undefined;
  if (originalText !== undefined) {
    if (Buffer.byteLength(originalText) < 1 || Buffer.byteLength(originalText) > recordLimit) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE');
    try { input = JSON.parse(originalText); } catch { return workspacePathRecordFailure(); }
  }
  const value = workspacePathRecordObject(captureWorkspacePathRecordData(input), recordKeys);
  const origin = workspacePathRecordObject(value.origin, ['version', 'kind', 'userId', 'sessionId', 'clientId', 'tool', 'scope', 'realm']);
  const realm = workspacePathRecordObject(origin.realm, ['schemaName', 'schemaOid', 'databaseOid']);
  if (value.version !== 1 || typeof value.operationId !== 'string' || value.operationId.length < 1 || value.operationId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value.operationId) || Buffer.from(value.operationId).toString('utf8') !== value.operationId
    || !workspacePathRecordIdentifier(value.batchId, 128)
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.batchId) || origin.version !== 1 || typeof origin.kind !== 'string'
    || !['request', 'direct-mcp'].includes(origin.kind)
    || !workspacePathRecordIdentifier(origin.userId) || !workspacePathRecordIdentifier(origin.sessionId)
    || (origin.kind === 'request' ? origin.clientId !== null : !workspacePathRecordIdentifier(origin.clientId)
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.operationId))
    || typeof origin.tool !== 'string' || !['move', 'rename', 'delete'].includes(origin.tool) || !workspacePathRecordIdentifier(realm.schemaName, 63)
    || Buffer.byteLength(realm.schemaName) > 63 || !workspacePathRecordInteger(realm.schemaOid, 1, 4294967295)
    || !workspacePathRecordInteger(realm.databaseOid, 1, 4294967295) || !workspacePathRecordInteger(value.preparedAt)
    || typeof value.b0TransactionId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value.b0TransactionId)
    || BigInt(value.b0TransactionId) > BigInt('18446744073709551615') || !workspacePathRecordDigest(value.recordProof)
    || !Array.isArray(value.imports) || !value.imports.length || value.imports.length > 10000) return workspacePathRecordFailure();
  let scope: WorkspaceOperationJobScope, previewPlan: WorkspacePathImportPreparationPlanV1;
  let nativePlan: WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationNativeDeleteBatchPlan;
  try {
    scope = parseWorkspaceOperationJobScope(origin.scope);
    previewPlan = decodeWorkspacePathImportPreparationPlanV1(value.previewPlan);
    const native = workspacePathRecordObject(value.nativePlan, Object.keys(value.nativePlan as object));
    nativePlan = native.version === 3 ? decodeWorkspaceOperationNativeMoveBatchPlan(native) : decodeWorkspaceOperationNativeDeleteBatchPlan(native);
  } catch (error) {
    if (error instanceof WorkspacePathImportPreparationRecordError) throw error;
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
    return workspacePathRecordFailure(typeof code === 'string' && code.endsWith('_TOO_LARGE')
      ? 'PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE' : 'PATH_IMPORT_PREPARATION_RECORD_INVALID');
  }
  if (scope.legacy || scope.rootRelativePath === null || previewPlan.readiness !== 'requires-import-rebinding'
    || !equal(scope, previewPlan.scope) || origin.tool !== previewPlan.request.kind || !equal(scope, nativePlan.sourceEvidence.workspaceScope)
    || nativePlan.planIdentityVersion !== 2 && nativePlan.planIdentityVersion !== 3 || nativePlan.readiness !== 'ready'
    || !nativePlan.coverage.complete || nativePlan.actions.length !== 1 || nativePlan.actions[0].kind !== origin.tool
    || (origin.tool === 'delete' ? nativePlan.version !== 2 : nativePlan.version !== 3)
    || !equal(nativePlan.actions[0].selections, previewPlan.request.selections)
    || value.imports.length !== previewPlan.importRequirements.length) return workspacePathRecordFailure();
  let expectedBatchId: string;
  try { expectedBatchId = origin.kind === 'request'
    ? createHash('sha256').update(JSON.stringify(['workspace-path-operation-id-v1', scope.workspaceId, origin.userId, value.operationId])).digest('hex')
    : workspaceOperationMcpBatchId({ userId: origin.userId as string, clientId: origin.clientId as string, workspaceId: scope.workspaceId,
      tool: origin.tool === 'delete' ? 'delete_knowledge_source' : 'move_knowledge_source', operationId: value.operationId as string }); }
  catch { return workspacePathRecordFailure(); }
  if (value.batchId !== expectedBatchId) return workspacePathRecordFailure();
  const reviewId = `${createHash('sha256').update(JSON.stringify(['workspace-path-action-v1', scope.workspaceId,
    origin.tool, previewPlan.request.selections.map(selection => ({ sourcePath: selection.sourcePath,
      ...(selection.destinationPath === undefined ? {} : { destinationPath: selection.destinationPath }) })), false, false])).digest('hex')}-request`;
  if (nativePlan.actions[0].reviewId !== reviewId) return workspacePathRecordFailure();
  const nativeEvidence = workspaceOperationSourceNativeEvidence(nativePlan.sourceEvidence);
  const nativeById = new Map(nativeEvidence.nativeBindings.map(binding => [binding.expected.documentId, binding]));
  const usedDocuments = new Set<string>(), usedLineages = new Set<string>(), usedOperations = new Set<string>();
  const imports = value.imports.map((entry, index) => {
    const item = workspacePathRecordObject(entry, ['requirementIndex', 'receipt', 'bindingProof', 'initialBinaryHash', 'initialVectorHash']);
    const receipt = workspacePathRecordReceipt(item.receipt), target = receipt.target;
    const requirement = previewPlan.importRequirements[index], ids = workspacePathOriginalImportIds(value.operationId as string, previewPlan.planId, index);
    const binding = nativeById.get(target.documentId);
    if (item.requirementIndex !== index || !workspacePathRecordDigest(item.bindingProof) || !workspacePathRecordDigest(item.initialBinaryHash)
      || !workspacePathRecordDigest(item.initialVectorHash) || receipt.operationId !== ids.operationId
      || requirement.workspaceId !== scope.workspaceId || target.workspaceId !== scope.workspaceId || target.organizationId !== scope.organizationId
      || target.path !== requirement.path || receipt.sourceHash !== requirement.physical.byteHash
      || receipt.sourceBytes !== requirement.physical.byteLength || receipt.sourceHash !== requirement.preparation.sourceHash
      || receipt.sourceBytes !== requirement.preparation.sourceBytes || target.representation !== requirement.preparation.representation
      || target.newlineStyle !== requirement.preparation.newlineStyle || target.hasBom !== requirement.preparation.hasBom
      || target.persistedAt > Number(value.preparedAt) || usedDocuments.has(target.documentId) || usedLineages.has(target.lineageId)
      || usedOperations.has(receipt.operationId) || !binding || binding.expected.lineageId !== target.lineageId
      || binding.expected.workspaceId !== target.workspaceId || binding.expected.organizationId !== target.organizationId
      || binding.expected.path !== target.path || binding.expected.representation !== target.representation
      || binding.expected.schemaVersion !== target.schemaVersion || binding.expected.lifecycleGeneration !== target.lifecycleGeneration
      || binding.expected.registryStateVersion !== 0 || binding.expected.documentSequence !== target.initialSequence
      || binding.expected.persistedAt !== target.persistedAt || binding.expected.stateProof !== target.initialStateProof
      || binding.expected.binaryHash !== item.initialBinaryHash || binding.expected.vectorHash !== item.initialVectorHash
      || binding.byteProfile.newlineStyle !== target.newlineStyle || binding.byteProfile.hasBom !== target.hasBom) return workspacePathRecordFailure();
    usedDocuments.add(target.documentId); usedLineages.add(target.lineageId); usedOperations.add(receipt.operationId);
    return { requirementIndex: index, receipt, bindingProof: item.bindingProof,
      initialBinaryHash: item.initialBinaryHash, initialVectorHash: item.initialVectorHash };
  });
  const capturedOrigin: WorkspacePathImportPreparationRecordV1['origin'] = { version: 1,
    kind: origin.kind as 'request' | 'direct-mcp', userId: origin.userId as string, sessionId: origin.sessionId as string,
    clientId: origin.clientId as string | null, tool: origin.tool as 'move' | 'rename' | 'delete', scope,
    realm: { schemaName: realm.schemaName as string, schemaOid: realm.schemaOid as number, databaseOid: realm.databaseOid as number } };
  const body = { version: 1 as const, operationId: value.operationId, batchId: value.batchId,
    origin: capturedOrigin, previewPlan, imports, nativePlan, b0TransactionId: value.b0TransactionId, preparedAt: value.preparedAt };
  const recordProof = createHash('sha256').update(workspacePathRecordCanonical(body)).digest('hex');
  const result = { ...body, recordProof } as WorkspacePathImportPreparationRecordV1;
  const text = workspacePathRecordCanonical(result);
  if (recordProof !== value.recordProof || Buffer.byteLength(text) > recordLimit
    || originalText !== undefined && originalText !== text) return workspacePathRecordFailure();
  return workspacePathRecordFreeze(result);
}
export function serializeWorkspacePathImportPreparationRecordV1(input: WorkspacePathImportPreparationRecordV1): string {
  return workspacePathRecordCanonical(decodeWorkspacePathImportPreparationRecordV1(input));
}
/** Explicit historical discriminator; malformed V2 is never retried as V1. */
export type WorkspacePathImportPreparationRecord = WorkspacePathImportPreparationRecordV1 | WorkspacePathHtmlImportPreparationRecordV2;
export function decodeWorkspacePathAnyImportPreparationRecord(input: unknown): WorkspacePathImportPreparationRecord {
  let value = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > recordLimit) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE');
    try { value = JSON.parse(value); } catch { return workspacePathRecordFailure(); }
  }
  const captured = workspacePathRecordObject(captureWorkspacePathRecordData(value), recordKeys);
  return captured.version === 1 ? decodeWorkspacePathImportPreparationRecordV1(input)
    : captured.version === 2 ? decodeWorkspacePathHtmlImportPreparationRecordV2(input) : workspacePathRecordFailure();
}
function serializeWorkspacePathAnyImportPreparationRecord(input: WorkspacePathImportPreparationRecord): string {
  return input.version === 1 ? serializeWorkspacePathImportPreparationRecordV1(input)
    : serializeWorkspacePathHtmlImportPreparationRecordV2(input);
}
function workspacePathRecordQuote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function workspacePathRecordReadInput(input: Locator): Locator {
  const value = workspacePathRecordObject(captureWorkspacePathRecordData(input, 16384), ['schema', 'workspaceId', 'batchId']);
  if (!workspacePathRecordIdentifier(value.schema, 63) || Buffer.byteLength(value.schema) > 63
    || !workspacePathRecordIdentifier(value.workspaceId) || !workspacePathRecordIdentifier(value.batchId, 128)
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.batchId)) return workspacePathRecordFailure();
  return Object.freeze(value) as Locator;
}

/** Mechanical permanent relation/custom-trigger identity. The caller retains
 * current authority, transaction identity, isolation and ownership duties. */
export async function assertWorkspacePathImportPreparationStorageOnConnection(database: SqlConnection, supplied: Locator): Promise<Readonly<{
  schemaName: string; schemaOid: number; databaseOid: number;
}>> {
  const input = workspacePathRecordReadInput(supplied);
  const rows = await database.all(`SELECT n.name,c.oid::bigint AS oid,c.relnamespace::bigint AS schema_oid,
    pg_catalog.current_schema() AS current_schema,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.to_regnamespace($1)::oid::bigint AS expected_schema_oid,
    c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,c.relhasrules,
    pg_catalog.to_regclass(pg_catalog.quote_ident(n.name))::oid::bigint AS resolved,
    EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_index i ON i.indexrelid=k.conindid
      WHERE k.conrelid=c.oid AND k.contype='p' AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
        AND i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
        AND ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY x(attnum,ordinality)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.attnum ORDER BY x.ordinality)
          =CASE WHEN n.name='workspace_path_import_preparations' THEN ARRAY['workspace_id','batch_id']::text[]
            ELSE ARRAY['workspace_id','operation_id']::text[] END) AS exact_primary,
    (SELECT count(*)::integer FROM pg_catalog.pg_trigger x WHERE x.tgrelid=c.oid AND NOT x.tgisinternal) AS user_triggers,
    t.tgname,t.tgtype,t.tgenabled,t.tgisinternal,t.tgconstraint::bigint AS tgconstraint,t.tgfoid::bigint AS function_oid,
    t.tgnargs,pg_catalog.octet_length(t.tgargs) AS argument_bytes,t.tgattr::text AS trigger_attributes,t.tgqual IS NULL AS unconditional,
    p.proname,p.pronamespace::bigint AS function_schema,p.prosecdef,p.proconfig,p.prokind,p.pronargs,
    p.prorettype='pg_catalog.trigger'::pg_catalog.regtype AS returns_trigger,l.lanname,
    CASE WHEN pg_catalog.octet_length(p.prosrc)<=65536 THEN p.prosrc END AS function_body
    FROM ROWS FROM (pg_catalog.unnest($2::text[]),pg_catalog.unnest($3::text[])) n(name,trigger_name)
    LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(pg_catalog.quote_ident($1)||'.'||pg_catalog.quote_ident(n.name))
    LEFT JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid AND t.tgname=n.trigger_name
    LEFT JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang`,
  [input.schema, [...storageNames], ['workspace_path_import_preparation_guard', 'markdown_file_import_receipt_guard']]) as Row[];
  if (rows.length !== 2 || new Set(rows.map(row => row.name)).size !== 2 || rows.some(row => {
    const index = storageNames.indexOf(row.name as typeof storageNames[number]);
    return index < 0 || row.current_schema !== input.schema || !workspacePathRecordInteger(Number(row.oid), 1, 4294967295)
      || Number(row.schema_oid) !== Number(row.expected_schema_oid) || !workspacePathRecordInteger(Number(row.schema_oid), 1, 4294967295)
      || !workspacePathRecordInteger(Number(row.database_oid), 1, 4294967295) || Number(row.resolved) !== Number(row.oid)
      || row.relkind !== 'r' || row.relpersistence !== 'p' || row.relrowsecurity !== false || row.relforcerowsecurity !== false
      || row.relispartition !== false || row.relhasrules !== false || row.exact_primary !== true
      || Number(row.user_triggers) !== 1 || Number(row.tgtype) !== 31
      || row.tgenabled !== 'O' || row.tgisinternal !== false || Number(row.tgconstraint) !== 0
      || Number(row.tgnargs) !== 0 || Number(row.argument_bytes) !== 0 || row.trigger_attributes !== '' || row.unconditional !== true
      || !workspacePathRecordInteger(Number(row.function_oid), 1, 4294967295) || Number(row.function_schema) !== Number(row.schema_oid)
      || row.proname !== (index === 0 ? 'validate_workspace_path_import_preparation' : 'validate_markdown_file_import_receipt')
      || row.prosecdef !== false || row.proconfig !== null || row.prokind !== 'f' || Number(row.pronargs) !== 0
      || row.returns_trigger !== true || row.lanname !== 'plpgsql'
      || typeof triggerBodies[index] !== 'string' || row.function_body !== triggerBodies[index];
  })) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_UNAVAILABLE');
  return Object.freeze({ schemaName: input.schema, schemaOid: Number(rows[0].schema_oid), databaseOid: Number(rows[0].database_oid) });
}

/** The complete original receipt cohort, including exact immutable binary and
 * vector certifications. Deliberately never reads today's native tables. */
async function workspacePathRecordReceiptsOnConnection(database: SqlConnection, schema: string,
  record: WorkspacePathImportPreparationRecord): Promise<void> {
  const ids = record.imports.map(item => item.receipt.operationId), expectedIds = new Set(ids), prefix = workspacePathRecordQuote(schema);
  const sizes = await database.all(`SELECT operation_id,pg_catalog.octet_length(private_result::text) AS bytes
    FROM ${prefix}.collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=ANY($2::text[])
    ORDER BY operation_id COLLATE "C" LIMIT 10001`, [record.origin.scope.workspaceId, ids]) as Row[];
  if (sizes.length !== ids.length || new Set(sizes.map(row => row.operation_id)).size !== ids.length
    || sizes.some(row => !expectedIds.has(String(row.operation_id)) || !workspacePathRecordInteger(Number(row.bytes), 1, receiptLimit))
    || sizes.reduce((sum, row) => sum + Number(row.bytes), 0) > recordLimit) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED');
  const sizeByOperation = new Map(sizes.map(row => [row.operation_id, Number(row.bytes)]));
  const rows = await database.all(`SELECT operation_id,version,organization_id,actor_user_id,actor_session_id,request_id,request_fingerprint,
    CASE WHEN pg_catalog.octet_length(private_result::text) BETWEEN 1 AND 32768 THEN private_result::text END AS receipt_text,
    pg_catalog.octet_length(private_result::text) AS bytes,created_at,live_yjs_state_sha256,live_state_vector_sha256,xmin::text AS xmin,
    CASE WHEN pg_catalog.octet_length(after_state_snapshot) BETWEEN 1 AND 8388608
      THEN 'yjs-snapshot-sha256-v1:'||pg_catalog.encode(pg_catalog.sha256(after_state_snapshot),'hex') END AS snapshot_proof
    FROM ${prefix}.collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=ANY($2::text[])
    ORDER BY operation_id COLLATE "C" LIMIT 10001`, [record.origin.scope.workspaceId, ids]) as Row[];
  const byOperation = new Map(rows.map(row => [row.operation_id, row]));
  if (rows.length !== ids.length || byOperation.size !== ids.length) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED');
  const xmin = String(BigInt(record.b0TransactionId) & BigInt('4294967295'));
  for (const [index, imported] of record.imports.entries()) {
    const receipt = imported.receipt, row = byOperation.get(receipt.operationId), child = workspacePathOriginalImportIds(record.operationId, record.previewPlan.planId, index);
    let actual: unknown;
    try { actual = row && typeof row.receipt_text === 'string' ? JSON.parse(row.receipt_text) : null; }
    catch { return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED'); }
    if (!row || !equal(actual, receipt) || row.version !== 1 || row.organization_id !== record.origin.scope.organizationId
      || row.actor_user_id !== record.origin.userId || row.actor_session_id !== record.origin.sessionId || row.request_id !== child.requestId
      || row.request_fingerprint !== receipt.requestFingerprint || Number(row.created_at) !== receipt.target.persistedAt
      || row.live_yjs_state_sha256 !== imported.initialBinaryHash || row.live_state_vector_sha256 !== imported.initialVectorHash
      || row.snapshot_proof !== receipt.target.initialStateProof || row.xmin !== xmin
      || Number(row.bytes) !== sizeByOperation.get(row.operation_id)) {
      return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED');
    }
  }
}

/** Data/history read only. A later moved/archived document or D2 at the same
 * path is irrelevant; every caller still needs its genuine current policy. */
export async function readWorkspacePathImportPreparationRecordOnConnection(database: SqlConnection,
  supplied: Locator): Promise<WorkspacePathImportPreparationRecord | null> {
  const input = workspacePathRecordReadInput(supplied), realm = await assertWorkspacePathImportPreparationStorageOnConnection(database, input);
  const row = await database.get(`SELECT workspace_id,batch_id,operation_id,version,preview_plan_id,native_plan_id,record_digest,b0_xid,created_at,
    pg_catalog.octet_length(record_text) AS bytes,xmin::text AS xmin,
    CASE WHEN pg_catalog.octet_length(record_text) BETWEEN 1 AND 16777216 THEN record_text END AS record_text
    FROM ${workspacePathRecordQuote(input.schema)}.workspace_path_import_preparations WHERE workspace_id=$1 AND batch_id=$2`,
  [input.workspaceId, input.batchId]) as Row | undefined;
  if (!row) return null;
  if (row.workspace_id !== input.workspaceId || row.batch_id !== input.batchId || ![1, 2].includes(Number(row.version))
    || !workspacePathRecordInteger(Number(row.bytes), 1, recordLimit) || typeof row.record_text !== 'string'
    || Buffer.byteLength(row.record_text) !== Number(row.bytes) || !workspacePathRecordDigest(row.record_digest)
    || createHash('sha256').update(row.record_text).digest('hex') !== row.record_digest) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED');
  const record = decodeWorkspacePathAnyImportPreparationRecord(row.record_text);
  if (record.version !== row.version || record.origin.scope.workspaceId !== input.workspaceId || record.batchId !== input.batchId || record.operationId !== row.operation_id
    || !equal(record.origin.realm, realm) || record.previewPlan.planId !== row.preview_plan_id || record.nativePlan.planId !== row.native_plan_id
    || record.b0TransactionId !== row.b0_xid || record.preparedAt !== Number(row.created_at)
    || row.xmin !== String(BigInt(record.b0TransactionId) & BigInt('4294967295'))) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED');
  await workspacePathRecordReceiptsOnConnection(database, input.schema, record);
  return record;
}

/** Only the Root-owned fixed B0 completion phase may insert. No callback,
 * supplied actor/bytes or decoded record can install that private capability. */
export async function insertWorkspacePathImportPreparationRecordOnConnection(database: SqlConnection, supplied: Readonly<{
  handle: WorkspacePathImportPreparationHandle; record: WorkspacePathImportPreparationRecord;
}>): Promise<WorkspacePathImportPreparationRecord> {
  // The handle is opaque and cannot be copied by JSON capture. Read only its
  // own top-level data descriptors, then let the fixed owner verify provenance.
  if (!supplied || typeof supplied !== 'object' || types.isProxy(supplied) || Object.getPrototypeOf(supplied) !== Object.prototype
    || Reflect.ownKeys(supplied).length !== 2
    || ['handle', 'record'].some(key => { const field = Object.getOwnPropertyDescriptor(supplied, key);
      return !field?.enumerable || !Object.hasOwn(field, 'value'); })) return workspacePathRecordFailure();
  const handle = Object.getOwnPropertyDescriptor(supplied, 'handle')!.value as WorkspacePathImportPreparationHandle;
  const record = decodeWorkspacePathAnyImportPreparationRecord(Object.getOwnPropertyDescriptor(supplied, 'record')!.value);
  const { assertWorkspacePathImportRecordPreparationOnConnection } = await import('./workspace-path-import-preparation-phase');
  await assertWorkspacePathImportRecordPreparationOnConnection(database, handle, record);
  const locator = { schema: record.origin.realm.schemaName, workspaceId: record.origin.scope.workspaceId, batchId: record.batchId };
  const realm = await assertWorkspacePathImportPreparationStorageOnConnection(database, locator);
  if (!equal(realm, record.origin.realm)) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED');
  await workspacePathRecordReceiptsOnConnection(database, locator.schema, record);
  const text = serializeWorkspacePathAnyImportPreparationRecord(record), digest = createHash('sha256').update(text).digest('hex');
  await assertWorkspacePathImportRecordPreparationOnConnection(database, handle, record);
  const inserted = await database.get(`INSERT INTO ${workspacePathRecordQuote(locator.schema)}.workspace_path_import_preparations
    (workspace_id,batch_id,operation_id,version,preview_plan_id,native_plan_id,record_text,record_digest,b0_xid,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,batch_id) DO NOTHING RETURNING record_digest`,
  [locator.workspaceId, record.batchId, record.operationId, record.version, record.previewPlan.planId, record.nativePlan.planId, text, digest, record.b0TransactionId, record.preparedAt]) as Row | undefined;
  if (inserted && inserted.record_digest !== digest) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED');
  const actual = await readWorkspacePathImportPreparationRecordOnConnection(database, locator);
  if (!actual || !equal(actual, record)) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_CHANGED');
  await assertWorkspacePathImportRecordPreparationOnConnection(database, handle, record);
  return actual;
}
