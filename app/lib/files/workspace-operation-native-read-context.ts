import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5, type WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import 'server-only';
import { decodeWorkspaceOperationCohortDeletePlan, type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';

import { isDeepStrictEqual, types } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { resolveWorkspaceActor } from '../workspaces/context';
import { readPostgresWorkspaceForActorOnConnection } from '../workspaces/postgres-runtime';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import type { WorkspaceOperationApiKeyJobReadPrincipal } from '../workspaces/workspace-operation-api-key-job-principal';
import { captureWorkspaceOperationProgrammaticJobReadOptions,
  type WorkspaceOperationProgrammaticJobReadOptions } from '../workspaces/workspace-operation-programmatic-job-principal';
import { assertApiKeyWorkspacePathPrincipalCaptured, withApiKeyWorkspacePathPrincipalOnConnection } from '../api-keys/document-read-principal';
import { assertDirectMcpWorkspaceMovePrincipalCaptured, assertDirectMcpWorkspaceDeletePrincipalCaptured,
  withDirectMcpWorkspaceMovePrincipalOnConnection, withDirectMcpWorkspaceDeletePrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { decodeWorkspaceOperationBatchRecord, type WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationNativeDeleteBatchPlan,
  WorkspaceOperationDirectMcpAuthorization } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-native-delete-plan';
import { decodeWorkspaceOperationNativeMoveBatchPlan, type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { captureWorkspaceOperationJobScope, workspaceOperationJobScopeMatches } from './workspace-operation-job-scope';
import { assertWorkspaceOperationMcpAuthorizationCurrent,
  type WorkspaceOperationMcpAuthorizationCurrent } from './workspace-operation-mcp-authorization';
import { assertWorkspaceOperationApiKeyAuthorizationCurrent,
  workspaceOperationApiKeyBatchId,
  type WorkspaceOperationApiKeyAuthorization, type WorkspaceOperationApiKeyAuthorizationCurrent } from './workspace-operation-api-key-authorization';

type NativePlan = WorkspaceOperationNativeDeleteBatchPlan | WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationPhysicalDeleteBatchPlanV5 | WorkspaceOperationCohortDeletePlan;
const moveHistoryTables = Object.freeze(['collaboration_admission_requests', 'collaboration_admission_targets',
  'collaboration_native_file_operation_intents', 'collaboration_native_file_operation_receipts',
  'collaboration_native_file_operation_side_effect_stages', 'collaboration_native_file_operation_side_effect_receipts',
  'workspace_file_operation_move_intents', 'workspace_file_operation_move_parent_receipts',
  'workspace_file_operation_move_path_receipts', 'workspace_file_operation_move_receipts']);
export class WorkspaceOperationNativeReadError extends Error {
  constructor(readonly code:'BATCH_ACCESS_DENIED'|'BATCH_SCOPE_CHANGED'|'BATCH_JOURNAL_UNAVAILABLE',readonly status=409,options?:ErrorOptions) {
    super(code,options);this.name='WorkspaceOperationNativeReadError';
  }
}
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
function changed():never{throw new WorkspaceOperationNativeReadError('BATCH_SCOPE_CHANGED');}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export type WorkspaceOperationNativeBatchReadContext=Readonly<{database:SqlConnection;schema:string;workspace:WorkspaceContext;
  batch:WorkspaceOperationBatchRecord;plan:NativePlan}>;
type SnapshotInput={batchId:string;scope:WorkspaceOperationBatchScope;planVersion:2|3|5|6|'path';expectedPlan?:NativePlan};
export type WorkspaceOperationNativePathReadInput=
  |({batchId:string;scope:WorkspaceOperationBatchScope}&WorkspaceOperationProgrammaticJobReadOptions)
  |{workspaceId:string;operationId:string;apiKeyPrincipal:WorkspaceOperationApiKeyJobReadPrincipal;mcpPrincipal?:never};
type PathLookupInput=WorkspaceOperationNativePathReadInput&{planVersion:'path';expectedPlan?:never};
export type WorkspaceOperationNativeBatchReadLookup<T>=Readonly<{value:T|null;scope:WorkspaceOperationBatchScope;batchId:string}>;
type Input=({batchId:string;scope:WorkspaceOperationBatchScope;planVersion:2|3|5|6;expectedPlan?:NativePlan}
  |PathLookupInput)&WorkspaceOperationProgrammaticJobReadOptions;
type McpRealm=Readonly<{schemaName:string;schemaOid:number;databaseOid:number;searchPath:string;tableOid:number}>;
type McpAuthority=Readonly<{facts:WorkspaceOperationMcpAuthorizationCurrent;realm:McpRealm}>;
type ApiKeyAuthority=Readonly<{transport:'api-key';facts:WorkspaceOperationApiKeyAuthorizationCurrent;realm:McpRealm}>;
type ProgrammaticAuthority=McpAuthority|ApiKeyAuthority;
type ProgrammaticOriginal=Readonly<{authorization:WorkspaceOperationDirectMcpAuthorization|WorkspaceOperationApiKeyAuthorization;plan:NativePlan}>;
type Snapshot<T>=Readonly<{value:T|null;original?:ProgrammaticOriginal}>;
const unavailable=(cause:unknown)=>new WorkspaceOperationNativeReadError('BATCH_JOURNAL_UNAVAILABLE',503,{cause});

/** Fixed catalog facts only. Both unqualified and qualified batch names must
 * identify the permanent table in the actual current schema, never pg_temp. */
async function readMcpStatusRealm(database:SqlConnection):Promise<McpRealm>{
  const row=await database.get(`SELECT pg_catalog.current_schema() AS schema_name,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    CASE WHEN octet_length(pg_catalog.current_setting('search_path'))<=16384 THEN pg_catalog.current_setting('search_path') END AS search_path,
    c.oid::bigint AS table_oid,c.relnamespace::bigint AS table_schema_oid,c.relkind,c.relpersistence,
    pg_catalog.to_regclass(pg_catalog.quote_ident(pg_catalog.current_schema())||'.workspace_file_operation_batches')::oid::bigint AS qualified_oid
    FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('workspace_file_operation_batches')`) as Record<string,unknown>|undefined;
  if(!row||typeof row.schema_name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(row.schema_name)||row.schema_name.startsWith('pg_')
    ||typeof row.search_path!=='string'||!row.search_path||row.search_path.length>4096
    ||['schema_oid','database_oid','table_oid'].some(key=>!Number.isSafeInteger(Number(row[key]))||Number(row[key])<1)
    ||Number(row.table_schema_oid)!==Number(row.schema_oid)||Number(row.qualified_oid)!==Number(row.table_oid)
    ||row.relkind!=='r'||row.relpersistence!=='p')changed();
  return Object.freeze({schemaName:row.schema_name,schemaOid:Number(row.schema_oid),databaseOid:Number(row.database_oid),
    searchPath:row.search_path,tableOid:Number(row.table_oid)});
}

/** One fixed authorization transaction, with no caller callback or history
 * query. COMMIT and checkout disposal must both finish before facts escape. */
async function withStatusAuthorityConnection<T extends object>(operation:(database:SqlConnection)=>Promise<T>):Promise<T>{
  let database:SqlConnection;
  try{database=await openDb();}catch(error){throw unavailable(error);}
  let began=false,commitAttempted=false,failure:unknown,result:T|undefined;
  try{
    await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');began=true;
    result=await operation(database);
    commitAttempted=true;await database.run('COMMIT');began=false;
  }catch(error){failure=commitAttempted||!(error instanceof Error)?unavailable(error):error;
    if(began)try{await database.run('ROLLBACK');}catch(rollback){failure=unavailable(new AggregateError([failure,rollback],'Native status authorization rollback is unconfirmed.'));}}
  try{await database.close(failure instanceof Error?failure:undefined);}catch(close){failure=unavailable(new AggregateError([...(failure===undefined?[]:[failure]),close],'Native status authorization disposal is unconfirmed.'));}
  if(failure!==undefined)throw failure;
  if(!result)throw unavailable(new Error('Native status authorization result is absent.'));
  return result;
}
async function readMcpStatusAuthority(live:WorkspaceOperationMcpJobPrincipal,initial?:McpAuthority,
  original?:ProgrammaticOriginal):Promise<McpAuthority>{
  return withStatusAuthorityConnection(async database=>{
    const inspect=async(current:DirectMcpWorkspaceMovePrincipalAccess|DirectMcpWorkspaceDeletePrincipalAccess):Promise<McpAuthority>=>{
      const facts:WorkspaceOperationMcpAuthorizationCurrent=Object.freeze({userId:current.userId,clientId:current.clientId,
        sessionId:current.sessionId,workspace:current.workspace,tool:current.tool});
      const realm=await readMcpStatusRealm(database);
      if(initial&&(facts.userId!==initial.facts.userId||facts.clientId!==initial.facts.clientId
        ||facts.sessionId!==initial.facts.sessionId||facts.tool!==initial.facts.tool
        ||!isDeepStrictEqual(captureWorkspaceOperationJobScope(facts.workspace),captureWorkspaceOperationJobScope(initial.facts.workspace))
        ||!isDeepStrictEqual(realm,initial.realm)))changed();
      if(original){if(original.authorization.mode!=='direct-mcp')changed();
        assertWorkspaceOperationMcpAuthorizationCurrent(original.authorization,facts,original.plan);}
      await current.assertCurrent();
      if(!isDeepStrictEqual(await readMcpStatusRealm(database),realm))changed();
      return Object.freeze({facts,realm});
    };
    return live.kind==='move'
      ?await withDirectMcpWorkspaceMovePrincipalOnConnection(database,live.principal,inspect)
      :await withDirectMcpWorkspaceDeletePrincipalOnConnection(database,live.principal,inspect);
  });
}
async function readApiKeyStatusAuthority(live:WorkspaceOperationApiKeyJobReadPrincipal,initial?:ApiKeyAuthority,
  original?:ProgrammaticOriginal):Promise<ApiKeyAuthority>{
  return withStatusAuthorityConnection(database=>withApiKeyWorkspacePathPrincipalOnConnection(database,live.principal,live.purpose,async current=>{
    const facts:WorkspaceOperationApiKeyAuthorizationCurrent=Object.freeze({userId:current.userId,integrationId:current.integrationId,
      instanceId:current.instanceId,credentialId:current.credentialId,entryPoint:current.entryPoint,workspace:current.workspace,kind:live.kind});
    const realm=await readMcpStatusRealm(database);
    if(initial&&(facts.userId!==initial.facts.userId||facts.integrationId!==initial.facts.integrationId||facts.instanceId!==initial.facts.instanceId
      ||facts.credentialId!==initial.facts.credentialId||facts.entryPoint!==initial.facts.entryPoint||facts.kind!==initial.facts.kind
      ||!isDeepStrictEqual(captureWorkspaceOperationJobScope(facts.workspace),captureWorkspaceOperationJobScope(initial.facts.workspace))
      ||!isDeepStrictEqual(realm,initial.realm)))changed();
    if(original){if(original.authorization.mode!=='api-key')changed();
      assertWorkspaceOperationApiKeyAuthorizationCurrent(original.authorization,facts,original.plan);}
    await current.assertCurrent();if(!isDeepStrictEqual(await readMcpStatusRealm(database),realm))changed();
    return Object.freeze({transport:'api-key' as const,facts,realm});
  }));
}

/** Read-only current-ACL and immutable job binding shared by native status
 * consumers. This creates neither a claim nor owner/DA04 mutation authority. */
async function readNativeBatchSnapshot<T>(input:SnapshotInput,
  operation:(context:WorkspaceOperationNativeBatchReadContext)=>Promise<T>,mcp?:ProgrammaticAuthority):Promise<Snapshot<T>>{
  const workspace=input.scope.workspace,other=input.scope.fileOptions.workspace,userId=workspace.actor?.userId;
  if(!userId||!workspace.permissions.canRead||workspace.status!=='active'||!other||other.actor?.userId!==userId
    ||!other.permissions.canRead||other.status!=='active')throw new WorkspaceOperationNativeReadError('BATCH_ACCESS_DENIED',403);
  const namespace=captureWorkspaceOperationJobScope(workspace),otherNamespace=captureWorkspaceOperationJobScope(other);
  const version=input.planVersion,batchId=input.batchId,expected=input.expectedPlan && (version===6 ?decodeWorkspaceOperationCohortDeletePlan(input.expectedPlan):version===5
    ?decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(input.expectedPlan):version===2
    ?decodeWorkspaceOperationNativeDeleteBatchPlan(input.expectedPlan):decodeWorkspaceOperationNativeMoveBatchPlan(input.expectedPlan));
  let original:ProgrammaticOriginal|undefined;
  const database=await openDb();
  let began=false,committed=false,commitAttempted=false,failure:unknown,value:T|null=null;
  try{
    await database.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
    if(mcp){
      await database.run("SET LOCAL statement_timeout='5s'");await database.run("SET LOCAL lock_timeout='50ms'");await database.run("SET LOCAL transaction_timeout='5s'");
      if(!isDeepStrictEqual(await readMcpStatusRealm(database),mcp.realm))changed();
    }
    const realm=await database.get(`SELECT n.nspname AS schema_name,n.oid::bigint AS schema_oid,c.oid::bigint AS table_oid,
      (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
      pg_catalog.current_setting('search_path') AS search_path FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid=pg_catalog.to_regclass('workspace_file_operation_batches') AND c.relkind='r' AND c.relpersistence='p'`) as Record<string,unknown>|undefined;
    if(!realm||typeof realm.schema_name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(realm.schema_name)||realm.schema_name.startsWith('pg_')
      ||['schema_oid','table_oid','database_oid'].some(key=>!Number.isSafeInteger(Number(realm[key]))||Number(realm[key])<1))changed();
    const schema=realm.schema_name as string,prefix=quote(schema);
    // The original record decoder is pure. Header lookup and all historical
    // facts share this one actual RR snapshot, including the missing case.
    const inspectSnapshot=async():Promise<T|null>=>{
    const header=await database.get(`SELECT * FROM ${prefix}.workspace_file_operation_batches WHERE batch_id=$1`,[batchId]) as Record<string,unknown>|undefined;
    if(!header)return null;
    const batch=decodeWorkspaceOperationBatchRecord(header);
    if(mcp?batch.authorization.mode!==('transport' in mcp?'api-key':'direct-mcp'):
      batch.authorization.mode==='direct-mcp'||batch.authorization.mode==='api-key')changed();
    if(mcp&&batch.actionMode!=='apply')changed();
    if(version!=='path'&&batch.plan.version!==version)return null;
    if(![2,3,5,6].includes(batch.plan.version))changed();
    const plan=batch.plan.version===6?decodeWorkspaceOperationCohortDeletePlan(batch.plan):batch.plan.version===5?decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(batch.plan):batch.plan.version===2?decodeWorkspaceOperationNativeDeleteBatchPlan(batch.plan):decodeWorkspaceOperationNativeMoveBatchPlan(batch.plan),auth=batch.authorization;
    if(mcp){
      if('transport' in mcp){if(auth.mode!=='api-key')changed();assertWorkspaceOperationApiKeyAuthorizationCurrent(auth,mcp.facts,plan);}
      else{if(auth.mode!=='direct-mcp')changed();assertWorkspaceOperationMcpAuthorizationCurrent(auth,mcp.facts,plan);}
      original=Object.freeze({authorization:auth,plan});
    }else if(auth.mode!=='direct')changed();
    if(auth.mode!=='direct'&&auth.mode!=='direct-mcp'&&auth.mode!=='api-key'||!isDeepStrictEqual(auth.jobScope,namespace)||!isDeepStrictEqual(auth.jobScope,otherNamespace)
      ||!isDeepStrictEqual(plan.sourceEvidence.workspaceScope,auth.jobScope)||expected&&!isDeepStrictEqual(plan,expected))changed();
    freeze(batch);
    // Historical helper reads are facts, never mutation capabilities. Their
    // unqualified relations must still resolve to this exact job schema; a
    // stable search_path alone does not rule out a shadow history schema.
    let historyRelations: readonly Record<string,unknown>[] | undefined;
    const assertHistorySchema=async()=>{
      if(plan.version!==3)return;
      const resolved=await database.all(`SELECT expected.name,expected.ordinality::integer AS ordinal,
        c.oid::bigint AS table_oid,c.relnamespace::bigint AS schema_oid,c.relkind,c.relpersistence,
        pg_catalog.to_regclass(pg_catalog.quote_ident(expected.name))::oid::bigint AS resolved_oid,
        pg_catalog.current_schema() AS current_schema
        FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY expected(name,ordinality)
        LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(pg_catalog.quote_ident($2)||'.'||pg_catalog.quote_ident(expected.name))
        ORDER BY expected.ordinality`,[moveHistoryTables,schema]) as Record<string,unknown>[];
      if(resolved.length!==moveHistoryTables.length||resolved.some((row,index)=>row.name!==moveHistoryTables[index]
        ||Number(row.ordinal)!==index+1||row.current_schema!==schema||row.relkind!=='r'||row.relpersistence!=='p'
        ||Number(row.schema_oid)!==Number(realm.schema_oid)||!Number.isSafeInteger(Number(row.table_oid))||Number(row.table_oid)<1
        ||Number(row.resolved_oid)!==Number(row.table_oid))||historyRelations&&!isDeepStrictEqual(resolved,historyRelations))changed();
      historyRelations ??= Object.freeze(resolved.map(row=>Object.freeze({...row})));
    };
    const assertCurrent=async():Promise<WorkspaceContext>=>{
      if(mcp&&!isDeepStrictEqual(await readMcpStatusRealm(database),mcp.realm))changed();
      await assertHistorySchema();
      const user=await database.get(`SELECT id,email,role,banned FROM ${prefix}."user" WHERE id=$1`,[userId]) as Record<string,unknown>|undefined;
      if(!user||user.id!==userId||![null,false,true,0,1,'0','1'].includes(user.banned as never)||Number(user.banned)===1)
        throw new WorkspaceOperationNativeReadError('BATCH_ACCESS_DENIED',403);
      const current=await readPostgresWorkspaceForActorOnConnection(database,resolveWorkspaceActor({id:userId,email:user.email as string|null,role:user.role as string|null}),namespace.workspaceId);
      if(!current||current.status!=='active'||!current.permissions.canRead||!workspaceOperationJobScopeMatches(auth.jobScope,current))changed();
      const raw=await database.get(`SELECT * FROM ${prefix}.workspace_file_operation_batches WHERE batch_id=$1`,[batch.batchId]) as Record<string,unknown>|undefined;
      if(!raw||raw.plan_id!==batch.planId||raw.workspace_id!==batch.workspaceId||typeof raw.plan_json!=='string'||Buffer.byteLength(raw.plan_json)>16*1024**2
        ||typeof raw.authorization_json!=='string'||Buffer.byteLength(raw.authorization_json)>64*1024
        ||!isDeepStrictEqual(JSON.parse(raw.plan_json),plan)||!isDeepStrictEqual(JSON.parse(raw.authorization_json),auth)
        ||raw.action_mode!==batch.actionMode||raw.status!==batch.status||Number(raw.completed_actions)!==batch.completedActions
        ||Number(raw.total_actions)!==batch.totalActions||raw.phase!==batch.phase)changed();
      const now=await database.get(`SELECT pg_catalog.to_regclass('workspace_file_operation_batches')::oid::bigint AS table_oid,
        pg_catalog.to_regclass($1)::oid::bigint AS qualified_oid,pg_catalog.current_setting('search_path') AS search_path,
        (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
        (SELECT oid::bigint FROM pg_catalog.pg_namespace WHERE nspname=$2) AS schema_oid`,[`${prefix}.workspace_file_operation_batches`,schema]) as Record<string,unknown>|undefined;
      if(!now||Number(now.qualified_oid)!==Number(realm.table_oid)||['table_oid','schema_oid','database_oid','search_path'].some(key=>String(now[key])!==String(realm[key])))changed();
      return current;
    };
    const current=await assertCurrent(),result=await operation(Object.freeze({database,schema,workspace:current,batch,plan}));
    await assertCurrent();return result;
    };
    value=await inspectSnapshot();
    if(mcp&&!isDeepStrictEqual(await readMcpStatusRealm(database),mcp.realm))changed();
    commitAttempted=true;await database.run('COMMIT');committed=true;
  }catch(error){failure=commitAttempted||!(error instanceof Error)?unavailable(error):error;
    if(began&&!committed)try{await database.run('ROLLBACK');}catch(rollback){failure=unavailable(new AggregateError([failure,rollback],'Native status rollback is unconfirmed.'));}}
  try{await database.close(failure instanceof Error?failure:undefined);}catch(close){failure=unavailable(new AggregateError([...(failure===undefined?[]:[failure]),close],'Native status disposal is unconfirmed.'));}
  if(failure!==undefined)throw failure;return Object.freeze({value,...(original?{original}:{})});
}

/** Legacy retains its READ policy and result shape. Programmatic results are private until C1, the
 * actual historical snapshot/close and fresh C2 authorization all complete. */
export async function withWorkspaceOperationNativeBatchReadContext<T>(input:Input,
  operation:(context:WorkspaceOperationNativeBatchReadContext)=>Promise<T>):Promise<T|null>{
  return(await readNativeBatchWithScope(input,operation)).value;
}

/** Factual lookup metadata is available after C2 even when the job is absent.
 * It creates neither a batch nor write authority. Existing numeric readers
 * retain their nullable value through the wrapper above. */
export async function withWorkspaceOperationNativePathReadLookup<T>(input:PathLookupInput,
  operation:(context:WorkspaceOperationNativeBatchReadContext)=>Promise<T>):Promise<WorkspaceOperationNativeBatchReadLookup<T>>{
  return readNativeBatchWithScope(input,operation);
}

async function readNativeBatchWithScope<T>(input:Input,
  operation:(context:WorkspaceOperationNativeBatchReadContext)=>Promise<T>):Promise<WorkspaceOperationNativeBatchReadLookup<T>>{
  if(types.isProxy(input))changed();
  const live=captureWorkspaceOperationProgrammaticJobReadOptions(input),version=input.planVersion;
  if(live===undefined){if(version==='path')changed();return Object.freeze({value:(await readNativeBatchSnapshot(input,operation)).value,
    scope:input.scope,batchId:input.batchId});}
  if((version!=='path'&&(live.kind==='move'?version!==3:version!==2&&version!==5&&version!==6))||typeof operation!=='function')changed();
  if(version==='path'&&input.expectedPlan!==undefined)changed();
  const keyLookup='operationId' in input;
  if(keyLookup&&(version!=='path'||!('transport' in live)||Object.hasOwn(input,'scope')||Object.hasOwn(input,'batchId')
    ||typeof input.workspaceId!=='string'||!input.workspaceId||input.workspaceId.length>256
    ||typeof input.operationId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/u.test(input.operationId)))changed();
  const workspace=keyLookup?undefined:input.scope.workspace,other=keyLookup?undefined:input.scope.fileOptions.workspace;
  if(!keyLookup&&!other)changed();
  const namespace=workspace&&captureWorkspaceOperationJobScope(workspace),otherNamespace=other&&captureWorkspaceOperationJobScope(other);
  const expected=input.expectedPlan&&(version===6?decodeWorkspaceOperationCohortDeletePlan(input.expectedPlan):version===5?decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(input.expectedPlan):version===2?decodeWorkspaceOperationNativeDeleteBatchPlan(input.expectedPlan):decodeWorkspaceOperationNativeMoveBatchPlan(input.expectedPlan));
  const options={workspaceId:keyLookup?input.workspaceId:namespace!.workspaceId};
  if('transport' in live)assertApiKeyWorkspacePathPrincipalCaptured(live.principal,{...options,purpose:live.purpose});
  else if(live.kind==='move')assertDirectMcpWorkspaceMovePrincipalCaptured(live.principal,options);
  else assertDirectMcpWorkspaceDeletePrincipalCaptured(live.principal,options);
  const first='transport' in live?await readApiKeyStatusAuthority(live):await readMcpStatusAuthority(live);
  const currentNamespace=captureWorkspaceOperationJobScope(first.facts.workspace);
  if(!keyLookup&&(!isDeepStrictEqual(namespace,currentNamespace)||!isDeepStrictEqual(otherNamespace,currentNamespace)))changed();
  const scope:WorkspaceOperationBatchScope={workspace:first.facts.workspace,fileOptions:{workspace:first.facts.workspace}};
  let batchId:string;
  if(keyLookup){if(!('transport' in first))changed();batchId=workspaceOperationApiKeyBatchId({userId:first.facts.userId,
    integrationId:first.facts.integrationId,instanceId:first.facts.instanceId,workspaceId:currentNamespace.workspaceId,
    kind:first.facts.kind,operationId:input.operationId});}else batchId=input.batchId;
  const snapshot=await readNativeBatchSnapshot({batchId,scope,planVersion:version,expectedPlan:expected},operation,first);
  let final:ProgrammaticAuthority;
  if('transport' in live){if(!('transport' in first))changed();final=await readApiKeyStatusAuthority(live,first,snapshot.original);}
  else{if('transport' in first)changed();final=await readMcpStatusAuthority(live,first,snapshot.original);}
  const current=final.facts.workspace;
  return Object.freeze({value:snapshot.value,batchId,scope:Object.freeze({workspace:current,fileOptions:Object.freeze({workspace:current})})});
}
