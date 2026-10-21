import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5, type WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { resolveWorkspaceActor } from '../workspaces/context';
import { readPostgresWorkspaceForActorOnConnection } from '../workspaces/postgres-runtime';
import type { WorkspaceContext } from '../workspaces/types';
import { captureWorkspaceOperationMcpJobPrincipal, type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
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

type NativePlan = WorkspaceOperationNativeDeleteBatchPlan | WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationPhysicalDeleteBatchPlanV5;
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
type Input={batchId:string;scope:WorkspaceOperationBatchScope;planVersion:2|3|5;expectedPlan?:NativePlan;
  mcpPrincipal?:WorkspaceOperationMcpJobPrincipal};
type McpRealm=Readonly<{schemaName:string;schemaOid:number;databaseOid:number;searchPath:string;tableOid:number}>;
type McpAuthority=Readonly<{facts:WorkspaceOperationMcpAuthorizationCurrent;realm:McpRealm}>;
type McpOriginal=Readonly<{authorization:WorkspaceOperationDirectMcpAuthorization;plan:NativePlan}>;
type Snapshot<T>=Readonly<{value:T|null;original?:McpOriginal}>;
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
async function readMcpStatusAuthority(live:WorkspaceOperationMcpJobPrincipal,initial?:McpAuthority,
  original?:McpOriginal):Promise<McpAuthority>{
  let database:SqlConnection;
  try{database=await openDb();}catch(error){throw unavailable(error);}
  let began=false,commitAttempted=false,failure:unknown,result:McpAuthority|undefined;
  try{
    await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');began=true;
    const inspect=async(current:DirectMcpWorkspaceMovePrincipalAccess|DirectMcpWorkspaceDeletePrincipalAccess):Promise<McpAuthority>=>{
      const facts:WorkspaceOperationMcpAuthorizationCurrent=Object.freeze({userId:current.userId,clientId:current.clientId,
        sessionId:current.sessionId,workspace:current.workspace,tool:current.tool});
      const realm=await readMcpStatusRealm(database);
      if(initial&&(facts.userId!==initial.facts.userId||facts.clientId!==initial.facts.clientId
        ||facts.sessionId!==initial.facts.sessionId||facts.tool!==initial.facts.tool
        ||!isDeepStrictEqual(captureWorkspaceOperationJobScope(facts.workspace),captureWorkspaceOperationJobScope(initial.facts.workspace))
        ||!isDeepStrictEqual(realm,initial.realm)))changed();
      if(original)assertWorkspaceOperationMcpAuthorizationCurrent(original.authorization,facts,original.plan);
      await current.assertCurrent();
      if(!isDeepStrictEqual(await readMcpStatusRealm(database),realm))changed();
      return Object.freeze({facts,realm});
    };
    result=live.kind==='move'
      ?await withDirectMcpWorkspaceMovePrincipalOnConnection(database,live.principal,inspect)
      :await withDirectMcpWorkspaceDeletePrincipalOnConnection(database,live.principal,inspect);
    commitAttempted=true;await database.run('COMMIT');began=false;
  }catch(error){failure=commitAttempted||!(error instanceof Error)?unavailable(error):error;
    if(began)try{await database.run('ROLLBACK');}catch(rollback){failure=unavailable(new AggregateError([failure,rollback],'Native status authorization rollback is unconfirmed.'));}}
  try{await database.close(failure instanceof Error?failure:undefined);}catch(close){failure=unavailable(new AggregateError([...(failure===undefined?[]:[failure]),close],'Native status authorization disposal is unconfirmed.'));}
  if(failure!==undefined)throw failure;
  if(!result)throw unavailable(new Error('Native status authorization result is absent.'));
  return result;
}

/** Read-only current-ACL and immutable job binding shared by native status
 * consumers. This creates neither a claim nor owner/DA04 mutation authority. */
async function readNativeBatchSnapshot<T>(input:Omit<Input,'mcpPrincipal'>,
  operation:(context:WorkspaceOperationNativeBatchReadContext)=>Promise<T>,mcp?:McpAuthority):Promise<Snapshot<T>>{
  const workspace=input.scope.workspace,other=input.scope.fileOptions.workspace,userId=workspace.actor?.userId;
  if(!userId||!workspace.permissions.canRead||workspace.status!=='active'||!other||other.actor?.userId!==userId
    ||!other.permissions.canRead||other.status!=='active')throw new WorkspaceOperationNativeReadError('BATCH_ACCESS_DENIED',403);
  const namespace=captureWorkspaceOperationJobScope(workspace),otherNamespace=captureWorkspaceOperationJobScope(other);
  const version=input.planVersion,batchId=input.batchId,expected=input.expectedPlan && (version===5
    ?decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(input.expectedPlan):version===2
    ?decodeWorkspaceOperationNativeDeleteBatchPlan(input.expectedPlan):decodeWorkspaceOperationNativeMoveBatchPlan(input.expectedPlan));
  let original:McpOriginal|undefined;
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
    if(mcp?batch.authorization.mode!=='direct-mcp':batch.authorization.mode==='direct-mcp')changed();
    if(mcp&&batch.actionMode!=='apply')changed();
    if(batch.plan.version!==version)return null;
    const plan=batch.plan.version===5?decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(batch.plan):batch.plan.version===2?decodeWorkspaceOperationNativeDeleteBatchPlan(batch.plan):decodeWorkspaceOperationNativeMoveBatchPlan(batch.plan),auth=batch.authorization;
    if(mcp){
      if(auth.mode!=='direct-mcp')changed();
      assertWorkspaceOperationMcpAuthorizationCurrent(auth,mcp.facts,plan);
      original=Object.freeze({authorization:auth,plan});
    }else if(auth.mode!=='direct')changed();
    if(auth.mode!=='direct'&&auth.mode!=='direct-mcp'||!isDeepStrictEqual(auth.jobScope,namespace)||!isDeepStrictEqual(auth.jobScope,otherNamespace)
      ||!isDeepStrictEqual(plan.sourceEvidence.workspaceScope,auth.jobScope)||expected&&!isDeepStrictEqual(plan,expected))changed();
    freeze(batch);
    // Historical helper reads are facts, never mutation capabilities. Their
    // unqualified relations must still resolve to this exact job schema; a
    // stable search_path alone does not rule out a shadow history schema.
    let historyRelations: readonly Record<string,unknown>[] | undefined;
    const assertHistorySchema=async()=>{
      if(version!==3)return;
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

/** Legacy retains its READ policy and result shape. MCP results are private until C1, the
 * actual historical snapshot/close and fresh C2 authorization all complete. */
export async function withWorkspaceOperationNativeBatchReadContext<T>(input:Input,
  operation:(context:WorkspaceOperationNativeBatchReadContext)=>Promise<T>):Promise<T|null>{
  if(types.isProxy(input))changed();
  const field=Object.getOwnPropertyDescriptor(input,'mcpPrincipal');
  if(field&&(!field.enumerable||!Object.hasOwn(field,'value')))changed();
  if(field?.value===undefined)return(await readNativeBatchSnapshot(input,operation)).value;
  const live=captureWorkspaceOperationMcpJobPrincipal(field.value),version=input.planVersion;
  if((live.kind==='move'?version!==3:version!==2&&version!==5)||typeof operation!=='function')changed();
  const batchId=input.batchId,workspace=input.scope.workspace,other=input.scope.fileOptions.workspace;
  if(!other)changed();
  const namespace=captureWorkspaceOperationJobScope(workspace),otherNamespace=captureWorkspaceOperationJobScope(other);
  const expected=input.expectedPlan&&(version===5?decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(input.expectedPlan):version===2?decodeWorkspaceOperationNativeDeleteBatchPlan(input.expectedPlan):decodeWorkspaceOperationNativeMoveBatchPlan(input.expectedPlan));
  const options={workspaceId:namespace.workspaceId};
  if(live.kind==='move')assertDirectMcpWorkspaceMovePrincipalCaptured(live.principal,options);
  else assertDirectMcpWorkspaceDeletePrincipalCaptured(live.principal,options);
  const first=await readMcpStatusAuthority(live);
  const currentNamespace=captureWorkspaceOperationJobScope(first.facts.workspace);
  if(!isDeepStrictEqual(namespace,currentNamespace)||!isDeepStrictEqual(otherNamespace,currentNamespace))changed();
  const scope:WorkspaceOperationBatchScope={workspace:first.facts.workspace,fileOptions:{workspace:first.facts.workspace}};
  const snapshot=await readNativeBatchSnapshot({batchId,scope,planVersion:version,expectedPlan:expected},operation,first);
  await readMcpStatusAuthority(live,first,snapshot.original);
  return snapshot.value;
}
