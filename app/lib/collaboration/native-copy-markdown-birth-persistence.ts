import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { SqlConnection } from '../db';
import { captureNativeCopyPhaseStage } from '../files/workspace-operation-native-copy-phase-contract';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import type { WorkspaceOperationManagedCopyStageV6 } from '../files/workspace-operation-managed-copy-stage';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from '../files/workspace-operation-copy-origin';
import { NATIVE_COPY_MARKDOWN_BIRTH_STATEMENTS } from '../db/native-copy-markdown-birth-migration';
import { MARKDOWN_FILE_IMPORT_STATEMENTS } from '../db/markdown-file-import-migration';
import { readNativeCopyReceiptStorageIdentityOnConnection, readHistoricalNativeWorkspaceCopyReceiptOnConnection } from './native-copy-historical-receipt';
import { bindPhysicalNativeImportLinks } from '../markdown/physical-native-import-binding';
import type { MarkdownFileImportReceipt } from './markdown-file-import-persistence';
import { loadCollaborationStateOnConnection } from './persistence';
import { decodeNativeCopyMarkdownBirthV1, nativeCopyMarkdownBirthText, nativeCopyMarkdownImportIds,
  NATIVE_COPY_MARKDOWN_BIRTH_LIMIT, rejectNativeCopyMarkdownBirth as fail, type NativeCopyMarkdownBirthV1 } from './native-copy-markdown-birth-contract';

type Row = Record<string, unknown>;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function stage6(stage:WorkspaceOperationManagedCopyStageV6):void {
  if (!stage || types.isProxy(stage) || Object.getPrototypeOf(stage)!==Object.prototype) fail();
  const discriminator=Object.getOwnPropertyDescriptor(stage,'version');
  if (!discriminator?.enumerable || !Object.hasOwn(discriminator,'value') || discriminator.value!==6) fail();
  if (captureNativeCopyPhaseStage(stage).payloadSha256!==stage.payloadSha256 || stage.plan.version!==5
    || stage.rawOriginals.length!==stage.plan.rawImportRequirements.length) fail();
}
async function realm(database:SqlConnection):Promise<void> {
  const row=await database.get(`SELECT bool_and(coalesce(pg_catalog.to_regclass(name)::oid=
    pg_catalog.to_regclass(pg_catalog.quote_ident(pg_catalog.current_schema())||'.'||pg_catalog.quote_ident(name))::oid,false)) AS same
    FROM pg_catalog.unnest($1::text[]) names(name)`,[['collaboration_native_copy_markdown_births','collaboration_native_copy_receipts',
    'collaboration_markdown_file_import_receipts','collaboration_documents','collaboration_yjs_states','file_collaboration_lineages']]) as Row|undefined;
  if (row?.same!==true) fail();
}
async function owner(database:SqlConnection,stage:WorkspaceOperationManagedCopyStageV6):Promise<void> {
  stage6(stage);
  const {assertNativeCopySessionOnConnection}=await import('../files/workspace-operation-native-copy-owner');
  await assertNativeCopySessionOnConnection(database,stage.origin); await realm(database); stage6(stage);
}
async function parent(database:SqlConnection,stage:WorkspaceOperationManagedCopyStageV6,fresh:boolean):Promise<Row> {
  const row=await database.get(`SELECT workspace_id,operation_id,organization_id,actor_user_id,actor_session_id,kind,version,
    request_fingerprint,publication_fingerprint,publication_status,xmin::text AS xmin,
    pg_catalog.pg_current_xact_id_if_assigned()::text AS xid
    FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`,
  [stage.identity.destinationWorkspaceId,stage.identity.operationId]) as Row|undefined;
  if (!row || row.workspace_id!==stage.identity.destinationWorkspaceId || row.operation_id!==stage.identity.operationId
    || row.organization_id!==stage.origin.destinationScope.organizationId || row.actor_user_id!==stage.origin.actor.userId
    || row.actor_session_id!==stage.origin.actor.sessionId || row.kind!=='native_clone' || row.version!==1
    || row.publication_fingerprint!==stage.payloadSha256 || !['native_committed','published','publication_failed'].includes(String(row.publication_status))
    || typeof row.request_fingerprint!=='string' || !/^[a-f0-9]{64}$/u.test(row.request_fingerprint)
    || fresh && (row.publication_status!=='native_committed' || typeof row.xid!=='string'
      || row.xmin!==String(BigInt(row.xid)&BigInt('4294967295')))) fail();
  return row;
}
function bindRequirement(birth:NativeCopyMarkdownBirthV1,stage:WorkspaceOperationManagedCopyStageV6,index:number):void {
  const req=stage.plan.rawImportRequirements[index],original=stage.rawOriginals[index],b=birth.binding;
  const ids=nativeCopyMarkdownImportIds(stage.identity.operationId,stage.payloadSha256,index);
  if (!req || !original || !equal(birth.origin,stage.origin) || birth.parent.operationId!==stage.identity.operationId
    || birth.parent.planId!==stage.plan.planId || birth.parent.stageDigest!==stage.payloadSha256
    || birth.parent.requestHash!==stage.identity.canonicalRequestHash || birth.parent.requirementIndex!==index
    || birth.parent.entityKey!==req.entityKey || birth.parent.requirementProof!==proof(req)
    || b.receipt.operationId!==ids.operationId || b.source.workspaceId!==req.sourceWorkspaceId || b.source.path!==req.sourcePath
    || b.source.physicalSourceProof!==req.physicalSourceProof || b.source.filesystemIdentity!==req.physical.filesystemIdentity
    || b.source.sourceHash!==req.physical.byteHash || b.source.sourceBytes!==req.physical.byteLength
    || b.receipt.target.workspaceId!==req.destinationWorkspaceId || b.receipt.target.path!==req.destinationPath
    || original.physicalSourceProof!==b.source.physicalSourceProof || b.receipt.sourceHash!==req.preparation.sourceHash
    || b.receipt.sourceBytes!==req.preparation.sourceBytes || b.receipt.target.representation!==req.preparation.representation
    || b.receipt.target.newlineStyle!==req.preparation.newlineStyle || b.receipt.target.hasBom!==req.preparation.hasBom
    || req.linkBindings.some(link=>!b.links.some(actual=>actual.physicalLinkId===link.physicalLinkId))) fail();
}
async function originalImport(database:SqlConnection,stage:WorkspaceOperationManagedCopyStageV6,birth:NativeCopyMarkdownBirthV1,fresh:boolean):Promise<void> {
  if (birth.parent.operationId!==stage.identity.operationId || birth.parent.stageDigest!==stage.payloadSha256
    || !equal(birth.origin,stage.origin)) fail();
  return originalImportReceipt(database,birth,fresh);
}
/** Shared immutable receipt checks; no current document, Yjs state or Stage is
 * read. Stage-owned and completed-history readers both bind their own parent. */
async function originalImportReceipt(database:SqlConnection,birth:NativeCopyMarkdownBirthV1,fresh:boolean):Promise<void> {
  const ids=nativeCopyMarkdownImportIds(birth.parent.operationId,birth.parent.stageDigest,birth.parent.requirementIndex);
  const origin=birth.origin;
  const row=await database.get(`SELECT version,organization_id,actor_user_id,actor_session_id,request_id,request_fingerprint,
    CASE WHEN octet_length(private_result::text)<=32768 THEN private_result END AS private_result,
    created_at,live_yjs_state_sha256,live_state_vector_sha256,xmin::text AS xmin,
    octet_length(after_state_snapshot) AS snapshot_bytes,
    CASE WHEN octet_length(after_state_snapshot) BETWEEN 1 AND 8388608
      THEN pg_catalog.encode(pg_catalog.sha256(after_state_snapshot),'hex') END AS snapshot_hash
    FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2
      AND (organization_id IS NULL OR octet_length(organization_id)<=1024)
      AND octet_length(actor_user_id)<=1024 AND (actor_session_id IS NULL OR octet_length(actor_session_id)<=1024)
      AND octet_length(request_id)<=1024 AND octet_length(request_fingerprint)=64
      AND octet_length(live_yjs_state_sha256)=64 AND octet_length(live_state_vector_sha256)=64`,
  [origin.destinationScope.workspaceId,ids.operationId]) as Row|undefined;
  if (!row || row.version!==1 || row.organization_id!==origin.destinationScope.organizationId
    || row.actor_user_id!==origin.actor.userId || row.actor_session_id!==origin.actor.sessionId
    || row.request_id!==ids.requestId || row.request_fingerprint!==birth.binding.receipt.requestFingerprint
    || !equal(row.private_result,birth.binding.receipt) || Number(row.created_at)!==birth.binding.receipt.target.persistedAt
    || row.live_yjs_state_sha256!==birth.binding.nativeBinaryHash || row.live_state_vector_sha256!==birth.binding.nativeVectorHash
    || !Number.isSafeInteger(Number(row.snapshot_bytes)) || Number(row.snapshot_bytes)<1 || Number(row.snapshot_bytes)>8388608
    || `yjs-snapshot-sha256-v1:${String(row.snapshot_hash)}`!==birth.binding.receipt.target.initialStateProof
    || fresh && row.xmin!==String(BigInt(birth.b1TransactionId)&BigInt('4294967295'))) fail();
}
/** Fixed fresh B1 only. Actual imported seq0 bytes, actual FD-stage proof and
 * current Copy principal are checked; a caller-supplied receipt grants nothing. */
export async function persistNativeCopyMarkdownBirthOnConnection(database:SqlConnection,input:Readonly<{
  stage:WorkspaceOperationManagedCopyStageV6;requirementIndex:number;receipt:MarkdownFileImportReceipt;
}>):Promise<NativeCopyMarkdownBirthV1> {
  if (!input || types.isProxy(input) || Object.getPrototypeOf(input)!==Object.prototype || Reflect.ownKeys(input).length!==3
    || !['stage','requirementIndex','receipt'].every(key=>{const field=Object.getOwnPropertyDescriptor(input,key);
      return field?.enumerable && Object.hasOwn(field,'value');})) fail();
  const {stage,requirementIndex:index}=input;
  const receipt=captureWorkspaceOperationNativePlanData(input.receipt,fail,32768) as MarkdownFileImportReceipt;
  const {assertNativeCopyMarkdownImportPreparationOnConnection}=await import('../files/workspace-operation-native-copy-phase');
  await assertNativeCopyMarkdownImportPreparationOnConnection(database,stage,index);
  await realm(database); const header=await parent(database,stage,true);
  const state=await loadCollaborationStateOnConnection(database,receipt.target.documentId,true);
  if (!state) fail();
  const binding=bindPhysicalNativeImportLinks({original:stage.rawOriginals[index],receipt,state,lineageId:receipt.target.lineageId});
  const body={version:1 as const,parent:{operationId:stage.identity.operationId,planId:stage.plan.planId,stageDigest:stage.payloadSha256,
    requestHash:stage.identity.canonicalRequestHash,requirementIndex:index,entityKey:stage.plan.rawImportRequirements[index].entityKey,
    requirementProof:proof(stage.plan.rawImportRequirements[index])},origin:stage.origin,binding,b1TransactionId:String(header.xid)};
  const birth=decodeNativeCopyMarkdownBirthV1({...body,birthProof:proof(body)}); bindRequirement(birth,stage,index);
  await originalImport(database,stage,birth,true);
  const actual=await database.get(`SELECT d.xmin::text AS d,s.xmin::text AS s,l.xmin::text AS l,s.document_sequence,
    s.room_owner_epoch,s.room_owner_token,s.room_owner_backend_pid,s.room_owner_backend_start,l.workspace_id,l.organization_id,l.path,l.status
    FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
    JOIN file_collaboration_lineages l ON l.id=d.lineage_id WHERE d.id=$1 AND d.lineage_id=$2`,
  [receipt.target.documentId,receipt.target.lineageId]) as Row|undefined;
  const xmin=String(BigInt(birth.b1TransactionId)&BigInt('4294967295'));
  if (!actual || actual.d!==xmin || actual.s!==xmin || actual.l!==xmin || Number(actual.document_sequence)!==0
    || Number(actual.room_owner_epoch)!==0 || actual.room_owner_token!==null || actual.room_owner_backend_pid!==null
    || actual.room_owner_backend_start!==null || actual.workspace_id!==receipt.target.workspaceId
    || actual.organization_id!==receipt.target.organizationId || actual.path!==receipt.target.path || actual.status!=='active') fail();
  const serialized=nativeCopyMarkdownBirthText(birth);
  await assertNativeCopyMarkdownImportPreparationOnConnection(database,stage,index);
  const inserted=await database.get(`INSERT INTO collaboration_native_copy_markdown_births
    (workspace_id,parent_operation_id,requirement_index,version,import_operation_id,document_id,lineage_id,
     plan_id,stage_digest,request_hash,requirement_key,requirement_proof,birth_text,birth_digest,b1_transaction_id,created_at)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING xmin::text AS xmin`,
  [stage.identity.destinationWorkspaceId,stage.identity.operationId,index,receipt.operationId,receipt.target.documentId,receipt.target.lineageId,
    stage.plan.planId,stage.payloadSha256,stage.identity.canonicalRequestHash,birth.parent.entityKey,birth.parent.requirementProof,
    serialized,digest(serialized),birth.b1TransactionId,receipt.target.persistedAt]) as Row|undefined;
  if (inserted?.xmin!==xmin) fail();
  await assertNativeCopyMarkdownImportPreparationOnConnection(database,stage,index); await parent(database,stage,true);
  return birth;
}
/** Original history only: no today-state/Yjs load, rebind, migration or writer.
 * Caller must additionally require all original link receipts/reservations. */
export async function readNativeCopyMarkdownBirthsOnConnection(database:SqlConnection,input:Readonly<{
  stage:WorkspaceOperationManagedCopyStageV6;
}>):Promise<readonly NativeCopyMarkdownBirthV1[]> {
  if (!input || types.isProxy(input) || Object.getPrototypeOf(input)!==Object.prototype || Reflect.ownKeys(input).length!==1) fail();
  const field=Object.getOwnPropertyDescriptor(input,'stage');
  if (!field?.enumerable || !Object.hasOwn(field,'value')) fail();
  const stage:WorkspaceOperationManagedCopyStageV6=field.value;
  await owner(database,stage); await parent(database,stage,false);
  const rows=await database.all(`SELECT requirement_index,document_id,lineage_id,import_operation_id,plan_id,stage_digest,request_hash,
    requirement_key,requirement_proof,birth_digest,b1_transaction_id,created_at,
    octet_length(birth_text) AS bytes FROM collaboration_native_copy_markdown_births
    WHERE workspace_id=$1 AND parent_operation_id=$2 ORDER BY requirement_index LIMIT 10001`,
  [stage.identity.destinationWorkspaceId,stage.identity.operationId]) as Row[];
  if (rows.length!==stage.plan.rawImportRequirements.length || rows.length>10000) fail();
  const total=rows.reduce((sum,row)=>sum+Number(row.bytes),0);
  if (!Number.isSafeInteger(total) || total>64*1024*1024 || rows.some(row=>!Number.isSafeInteger(Number(row.bytes))
    || Number(row.bytes)<1 || Number(row.bytes)>NATIVE_COPY_MARKDOWN_BIRTH_LIMIT)) fail();
  const births:NativeCopyMarkdownBirthV1[]=[];
  for (const [index,row] of rows.entries()) {
    const size=Number(row.bytes);
    const payload=await database.get(`SELECT birth_text FROM collaboration_native_copy_markdown_births
      WHERE workspace_id=$1 AND parent_operation_id=$2 AND requirement_index=$3 AND birth_digest=$4
        AND octet_length(birth_text)=$5 AND octet_length(birth_text)<=16777216`,
    [stage.identity.destinationWorkspaceId,stage.identity.operationId,index,row.birth_digest,size]) as Row|undefined;
    if (Number(row.requirement_index)!==index || !payload || typeof payload.birth_text!=='string'
      || Buffer.byteLength(payload.birth_text)!==size || digest(payload.birth_text)!==row.birth_digest) fail();
    let parsed:unknown; try { parsed=JSON.parse(payload.birth_text); } catch { return fail(); }
    const birth=decodeNativeCopyMarkdownBirthV1(parsed); bindRequirement(birth,stage,index);
    if (nativeCopyMarkdownBirthText(birth)!==payload.birth_text || row.document_id!==birth.binding.receipt.target.documentId
      || row.lineage_id!==birth.binding.receipt.target.lineageId || row.import_operation_id!==birth.binding.receipt.operationId
      || row.plan_id!==birth.parent.planId || row.stage_digest!==birth.parent.stageDigest || row.request_hash!==birth.parent.requestHash
      || row.requirement_key!==birth.parent.entityKey || row.requirement_proof!==birth.parent.requirementProof
      || row.b1_transaction_id!==birth.b1TransactionId || Number(row.created_at)!==birth.binding.receipt.target.persistedAt) fail();
    await originalImport(database,stage,birth,false); births.push(birth);
  }
  await owner(database,stage); return Object.freeze(births);
}

const HISTORY_COHORT_LIMIT = 64 * 1024 * 1024;
const HISTORY_COHORT_COUNT = 10000;
const historyHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const historyId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
const historyInteger = (value: unknown, maximum: number): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= maximum;
const historyQuote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Ordered digest of already decoded immutable births. This data helper grants
 * no authority and does not infer a current document from a historical ID. */
export function nativeCopyMarkdownBirthsProof(births: readonly NativeCopyMarkdownBirthV1[]): string {
  if (!births || types.isProxy(births) || !Array.isArray(births) || Object.getPrototypeOf(births) !== Array.prototype
    || births.length > HISTORY_COHORT_COUNT || Reflect.ownKeys(births).length !== births.length + 1) fail();
  const birthProofs = Array.from({ length: births.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(births, String(index));
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) return fail();
    const birth: unknown = item.value;
    if (!birth || typeof birth !== 'object' || types.isProxy(birth) || Object.getPrototypeOf(birth) !== Object.prototype) return fail();
    const field = Object.getOwnPropertyDescriptor(birth, 'birthProof');
    if (!field?.enumerable || !Object.hasOwn(field, 'value') || !historyHash(field.value)) return fail();
    return field.value as string;
  });
  return proof({ version: 1, kind: 'native-copy-markdown-birth-cohort', birthProofs });
}
export type HistoricalNativeCopyMarkdownBirthsInput = Readonly<{
  operationId: string; planId: string; stageDigest: string; requestHash: string;
  origin: WorkspaceOperationCopyOrigin; expectedBirthsProof: string; expectedBirthCount: number;
}>;
function historyInput(input: HistoricalNativeCopyMarkdownBirthsInput): HistoricalNativeCopyMarkdownBirthsInput {
  const captured = captureWorkspaceOperationNativePlanData(input, fail, 65536) as HistoricalNativeCopyMarkdownBirthsInput;
  const keys = ['operationId', 'planId', 'stageDigest', 'requestHash', 'origin', 'expectedBirthsProof', 'expectedBirthCount'];
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)
    || Reflect.ownKeys(captured).length !== keys.length || keys.some(key => !Object.hasOwn(captured, key))
    || !historyId(captured.operationId) || ![captured.planId, captured.stageDigest, captured.requestHash, captured.expectedBirthsProof].every(historyHash)
    || !historyInteger(captured.expectedBirthCount, HISTORY_COHORT_COUNT)) return fail();
  return Object.freeze({ ...captured, origin: decodeWorkspaceOperationCopyOrigin(captured.origin) });
}
async function historyWitness(database: SqlConnection): Promise<Readonly<{ schemaName: string; pin: string }>> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid()::text AS backend,a.backend_start::text AS start,
    a.datid::text AS database,pg_catalog.current_schema() AS schema,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::text AS schema_oid,
    pg_catalog.current_setting('search_path') AS search_path,pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,pg_catalog.current_setting('session_replication_role') AS replication,
    pg_catalog.pg_current_xact_id_if_assigned()::text AS xid,
    (SELECT virtualtransaction FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='virtualxid' AND mode='ExclusiveLock' AND granted) AS virtual
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined;
  if (!row || ![row.backend, row.database, row.schema_oid].every(value => typeof value === 'string' && /^[1-9][0-9]*$/u.test(value))
    || typeof row.start !== 'string' || !row.start || row.start.length > 128
    || typeof row.schema !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(row.schema) || row.schema.startsWith('pg_')
    || typeof row.search_path !== 'string' || !row.search_path || Buffer.byteLength(row.search_path) > 16384
    || row.isolation !== 'repeatable read' || row.read_only !== 'on' || row.replication !== 'origin' || row.xid !== null
    || typeof row.virtual !== 'string' || !/^[0-9]+\/[0-9]+$/u.test(row.virtual)) return fail();
  return Object.freeze({ schemaName: row.schema, pin: JSON.stringify(row) });
}
function historyTriggerBody(statements: readonly string[], name: string): string {
  const statement = statements.find(value => value.startsWith(`CREATE OR REPLACE FUNCTION ${name}()`));
  const start = statement?.indexOf(' AS $$') ?? -1, end = statement?.lastIndexOf('$$') ?? -1;
  if (!statement || start < 0 || end <= start + 6) return fail();
  return statement.slice(start + 6, end);
}
/** Fixed real tables/triggers/FKs in the caller's already proven B realm. No
 * schema, relation name, SQL, callback or principal is accepted in input data. */
async function historyStorage(database: SqlConnection, schemaName: string): Promise<string> {
  const tables: Row[] = [];
  const descriptors = [
    { table: 'collaboration_native_copy_markdown_births', trigger: 'native_copy_markdown_birth_guard',
      fn: 'validate_native_copy_markdown_birth', statements: NATIVE_COPY_MARKDOWN_BIRTH_STATEMENTS },
    { table: 'collaboration_markdown_file_import_receipts', trigger: 'markdown_file_import_receipt_guard',
      fn: 'validate_markdown_file_import_receipt', statements: MARKDOWN_FILE_IMPORT_STATEMENTS },
  ];
  for (const descriptor of descriptors) {
    const row = await database.get(`SELECT c.oid::text AS table_oid,n.oid::text AS schema_oid,n.nspname AS schema_name,
      c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
      pg_catalog.to_regclass($1)::oid::text AS resolved_oid,pg_catalog.current_schema() AS current_schema
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid=pg_catalog.to_regclass($2)`, [descriptor.table, `${historyQuote(schemaName)}.${historyQuote(descriptor.table)}`]) as Row | undefined;
    if (!row || row.schema_name !== schemaName || row.current_schema !== schemaName || row.relkind !== 'r'
      || row.relpersistence !== 'p' || row.relrowsecurity !== false || row.relforcerowsecurity !== false
      || typeof row.table_oid !== 'string' || !/^[1-9][0-9]*$/u.test(row.table_oid) || row.resolved_oid !== row.table_oid) return fail();
    const triggers = await database.all(`SELECT t.oid::text AS trigger_oid,t.tgname,t.tgtype,t.tgenabled,t.tgisinternal,
      t.tgnargs,t.tgqual::text AS qualification,t.tgattr::text AS attributes,t.tgdeferrable,t.tginitdeferred,
      t.tgconstraint::text AS constraint_oid,p.oid::text AS function_oid,p.proname,p.pronamespace::text AS function_schema,
      p.prosrc,p.prosecdef,p.proconfig,p.prokind,p.pronargs,p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger,l.lanname
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE t.tgrelid=$1::oid AND NOT t.tgisinternal ORDER BY t.oid LIMIT 2`, [row.table_oid]) as Row[];
    const trigger = triggers[0];
    if (triggers.length !== 1 || trigger.tgname !== descriptor.trigger || Number(trigger.tgtype) !== 31
      || !['O', 'A'].includes(String(trigger.tgenabled)) || trigger.tgisinternal !== false || Number(trigger.tgnargs) !== 0
      || trigger.qualification !== null || trigger.attributes !== '' || trigger.tgdeferrable !== false
      || trigger.tginitdeferred !== false || trigger.constraint_oid !== '0' || trigger.proname !== descriptor.fn
      || trigger.function_schema !== row.schema_oid || trigger.prosrc !== historyTriggerBody(descriptor.statements, descriptor.fn)
      || trigger.prosecdef !== false || trigger.proconfig !== null || trigger.prokind !== 'f' || Number(trigger.pronargs) !== 0
      || trigger.returns_trigger !== true || trigger.lanname !== 'plpgsql') return fail();
    tables.push({ ...row, trigger });
  }
  const parentStorage = await readNativeCopyReceiptStorageIdentityOnConnection(database, schemaName);
  const foreignKeys = await database.all(`SELECT c.oid::text AS oid,c.confrelid::text AS target_oid,
    c.convalidated,c.condeferrable,c.condeferred,
    ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(number,position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.number ORDER BY k.position) AS source_columns,
    ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(number,position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.number ORDER BY k.position) AS target_columns
    FROM pg_catalog.pg_constraint c WHERE c.conrelid=$1::oid AND c.contype='f' ORDER BY c.oid`, [tables[0].table_oid]) as Row[];
  const expected = [
    { target: String(parentStorage.tableOid), source: ['workspace_id', 'parent_operation_id'] },
    { target: tables[1].table_oid, source: ['workspace_id', 'import_operation_id'] },
  ];
  if (foreignKeys.length !== expected.length || expected.some(wanted => foreignKeys.filter(row => row.target_oid === wanted.target
    && row.convalidated === true && row.condeferrable === false && row.condeferred === false
    && equal(row.source_columns, wanted.source) && equal(row.target_columns, ['workspace_id', 'operation_id'])).length !== 1)) return fail();
  return JSON.stringify({ tables, parentStorage, foreignKeys });
}
/** Stage-free original completion history ONLY. The caller must already have
 * verified Completion5 and actual Owner/MCP ACL on this same RR/RO/no-XID B.
 * This function opens nothing, authorizes nothing and never reads today's
 * registry/state/lineage, imports, rebinds, repairs, reserves or writes a row. */
export async function readHistoricalNativeCopyMarkdownBirthsOnConnection(database: SqlConnection,
  supplied: HistoricalNativeCopyMarkdownBirthsInput): Promise<readonly NativeCopyMarkdownBirthV1[]> {
  const input = historyInput(supplied), initial = await historyWitness(database);
  const storage = await historyStorage(database, initial.schemaName);
  const parentStorage = await readNativeCopyReceiptStorageIdentityOnConnection(database, initial.schemaName);
  const parentRow = await database.get(`SELECT version,kind,organization_id,actor_user_id,actor_session_id,request_fingerprint,
    publication_fingerprint,publication_status,
    CASE WHEN octet_length(scope_paths::text)<=131072 THEN scope_paths END AS scope_paths FROM collaboration_native_copy_receipts
    WHERE workspace_id=$1 AND operation_id=$2 AND octet_length(actor_user_id)<=1024
      AND (actor_session_id IS NULL OR octet_length(actor_session_id)<=1024)
      AND (organization_id IS NULL OR octet_length(organization_id)<=1024)
      AND octet_length(kind)<=32 AND octet_length(request_fingerprint)=64 AND octet_length(publication_fingerprint)=64`,
  [input.origin.destinationScope.workspaceId, input.operationId]) as Row | undefined;
  if (!parentRow || parentRow.version !== 1 || parentRow.kind !== 'native_clone' || parentRow.publication_status !== 'published'
    || parentRow.publication_fingerprint !== input.stageDigest || !historyHash(parentRow.request_fingerprint)
    || parentRow.organization_id !== input.origin.destinationScope.organizationId
    || parentRow.actor_user_id !== input.origin.actor.userId || parentRow.actor_session_id !== input.origin.actor.sessionId) return fail();
  const parentReceipt = await readHistoricalNativeWorkspaceCopyReceiptOnConnection(database, { storage: parentStorage,
    workspaceId: input.origin.destinationScope.workspaceId, organizationId: input.origin.destinationScope.organizationId,
    operationId: input.operationId, actorUserId: input.origin.actor.userId, actorSessionId: input.origin.actor.sessionId,
    kind: 'native_clone', requestFingerprint: parentRow.request_fingerprint, publicationFingerprint: input.stageDigest });
  if (!parentReceipt || parentReceipt.publicationStatus !== 'published' || !Array.isArray(parentRow.scope_paths)
    || parentRow.scope_paths.some(value => typeof value !== 'string')) return fail();
  const parentScopes = parentRow.scope_paths as string[];
  const args = [input.origin.destinationScope.workspaceId, input.operationId];
  const aggregate = await database.get(`SELECT count(*)::text AS count,coalesce(sum(octet_length(birth_text)),0)::text AS bytes
    FROM collaboration_native_copy_markdown_births WHERE workspace_id=$1 AND parent_operation_id=$2`, args) as Row | undefined;
  if (!aggregate || Number(aggregate.count) !== input.expectedBirthCount
    || !historyInteger(Number(aggregate.bytes), HISTORY_COHORT_LIMIT)) return fail();
  const rows = await database.all(`SELECT version,requirement_index,document_id,lineage_id,import_operation_id,plan_id,stage_digest,request_hash,
    requirement_key,requirement_proof,birth_digest,b1_transaction_id,created_at,octet_length(birth_text) AS bytes
    FROM collaboration_native_copy_markdown_births WHERE workspace_id=$1 AND parent_operation_id=$2
      AND octet_length(document_id)<=1024 AND octet_length(lineage_id)<=1024 AND octet_length(import_operation_id)<=1024
      AND octet_length(plan_id)=64 AND octet_length(stage_digest)=64 AND octet_length(request_hash)=64
      AND octet_length(requirement_key)<=16384 AND octet_length(requirement_proof)=64 AND octet_length(birth_digest)=64
      AND octet_length(b1_transaction_id)<=32 ORDER BY requirement_index LIMIT 10001`, args) as Row[];
  if (rows.length !== input.expectedBirthCount) return fail();
  const births: NativeCopyMarkdownBirthV1[] = [];
  const documents = new Set(parentReceipt.documents.map(document => document.clone.documentId));
  const lineages = new Set(parentReceipt.documents.map(document => document.clone.lineageId));
  const imports = new Set<string>(), requirements = new Set<string>(), destinations = new Set<string>();
  let bytes = 0, transaction: string | null = null;
  for (const [index, row] of rows.entries()) {
    const size = Number(row.bytes);
    if (row.version !== 1 || Number(row.requirement_index) !== index || !historyInteger(size, NATIVE_COPY_MARKDOWN_BIRTH_LIMIT) || size < 1
      || row.plan_id !== input.planId || row.stage_digest !== input.stageDigest || row.request_hash !== input.requestHash
      || !historyHash(row.birth_digest) || !historyHash(row.requirement_proof)) return fail();
    bytes += size; if (bytes > HISTORY_COHORT_LIMIT) return fail();
    const payload = await database.get(`SELECT birth_text FROM collaboration_native_copy_markdown_births
      WHERE workspace_id=$1 AND parent_operation_id=$2 AND requirement_index=$3 AND birth_digest=$4
        AND octet_length(birth_text)=$5 AND octet_length(birth_text) BETWEEN 1 AND 16777216`,
    [...args, index, row.birth_digest, size]) as Row | undefined;
    if (!payload || typeof payload.birth_text !== 'string' || Buffer.byteLength(payload.birth_text) !== size
      || digest(payload.birth_text) !== row.birth_digest) return fail();
    let parsed: unknown; try { parsed = JSON.parse(payload.birth_text); } catch { return fail(); }
    const birth = decodeNativeCopyMarkdownBirthV1(parsed), target = birth.binding.receipt.target;
    const ids = nativeCopyMarkdownImportIds(input.operationId, input.stageDigest, index);
    if (nativeCopyMarkdownBirthText(birth) !== payload.birth_text || !equal(birth.origin, input.origin)
      || birth.parent.operationId !== input.operationId || birth.parent.planId !== input.planId
      || birth.parent.stageDigest !== input.stageDigest || birth.parent.requestHash !== input.requestHash
      || birth.parent.requirementIndex !== index || birth.parent.entityKey !== row.requirement_key
      || birth.parent.requirementProof !== row.requirement_proof || birth.b1TransactionId !== row.b1_transaction_id
      || target.documentId !== row.document_id || target.lineageId !== row.lineage_id
      || birth.binding.receipt.operationId !== ids.operationId || row.import_operation_id !== ids.operationId
      || !parentScopes.some(scope => target.path === scope || target.path.startsWith(`${scope}/`))
      || target.persistedAt !== Number(row.created_at) || documents.has(target.documentId) || lineages.has(target.lineageId)
      || imports.has(ids.operationId) || requirements.has(birth.parent.entityKey) || destinations.has(target.path)
      || transaction !== null && birth.b1TransactionId !== transaction) return fail();
    documents.add(target.documentId); lineages.add(target.lineageId); imports.add(ids.operationId);
    requirements.add(birth.parent.entityKey); destinations.add(target.path); transaction = birth.b1TransactionId;
    await originalImportReceipt(database, birth, false); births.push(birth);
  }
  if (bytes !== Number(aggregate.bytes) || nativeCopyMarkdownBirthsProof(births) !== input.expectedBirthsProof
    || storage !== await historyStorage(database, initial.schemaName) || !equal(initial, await historyWitness(database))) return fail();
  return Object.freeze(births);
}
