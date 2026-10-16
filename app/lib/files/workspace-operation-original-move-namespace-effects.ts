import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { NATIVE_FILE_SIDE_EFFECT_ROW_SPECS } from '../db/native-file-operation-side-effects-migration';
import { withCollaborationAdmissionMutation } from '../collaboration/room-admission-handoff';
import { readWorkspacePathSideEffectRowsOnConnection } from '../markdown/native-file-operation-side-effects';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { workspaceOperationOriginalMoveNamespaceEffects,
  type WorkspaceOperationOriginalMoveContext, type WorkspaceOperationOriginalMoveIntentData } from './workspace-operation-original-move';

type Row = Record<string, unknown>;
type Rows = Awaited<ReturnType<typeof readWorkspacePathSideEffectRowsOnConnection>>;
export type WorkspaceOperationOriginalMoveNamespaceStage = Readonly<{
  version: 1; batchId: string; planId: string; workspaceId: string; organizationId: string | null;
  requestHash: string; actor: WorkspaceOperationOriginalMoveContext['actor']; schema: string;
  effectsProof: string; beforeRows: Rows; lineages: readonly Row[];
}>;
export type WorkspaceOperationOriginalMoveNamespaceReceipt = Readonly<{
  version: 1; batchId: string; planId: string; workspaceId: string; effectsProof: string;
  stageDigest: string; appliedAt: number; afterRowsProof: string; rowCounts: Record<string, number>;
}>;
export type WorkspaceOperationOriginalMoveNamespaceState = Readonly<{ stageText: string; stageDigest: string }>;
const keys = ['metadata', 'userStates', 'guests', 'publicShares', 'locks'] as const;
const MiB = 1024 * 1024;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const table = (schema: string, name: string) => `${quote(schema)}.${quote(name)}`;
const lineageKeys = ['id','organization_id','customer_id','project_id','workspace_id','workspace_type','path','status','created_at','archived_at','trash_entry_id'];
export class WorkspaceOperationOriginalMoveNamespaceError extends Error {
  readonly status = 409;
  constructor(readonly code: 'ORIGINAL_MOVE_NAMESPACE_INVALID' | 'ORIGINAL_MOVE_NAMESPACE_CHANGED'
    | 'ORIGINAL_MOVE_NAMESPACE_BUSY' | 'ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED') { super(code); this.name = 'WorkspaceOperationOriginalMoveNamespaceError'; }
}
function fail(code: WorkspaceOperationOriginalMoveNamespaceError['code'] = 'ORIGINAL_MOVE_NAMESPACE_INVALID'): never {
  throw new WorkspaceOperationOriginalMoveNamespaceError(code);
}
function canonical(value: unknown): string {
  const visit = (item: unknown): unknown => Array.isArray(item) ? item.map(visit)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Row)[key])])) : item;
  return JSON.stringify(visit(value));
}
function exact(value: unknown, names: readonly string[]): Row {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length) fail();
  for (const name of names) { const field = Object.getOwnPropertyDescriptor(value, name);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) fail(); }
  return value as Row;
}
function text(value: unknown, max = 256, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || !value.length
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString('utf8') !== value) fail();
}
function clock(value: unknown, minimum = 0, nullable = false): asserts value is number | null {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value >= Number.MAX_SAFE_INTEGER) fail();
}
function proof(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
function parse(value: unknown, maximum: number): Row {
  if (typeof value !== 'string' || value.length > maximum || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString('utf8') !== value || value.includes('\0')) fail();
  let result: unknown; try { result = JSON.parse(value); } catch { return fail(); }
  if (!result || Object.getPrototypeOf(result) !== Object.prototype) fail();
  // Only bounded JSON supplied as text enters these decoders; never caller getters/toJSON.
  if (canonical(result) !== value) fail();
  return result as Row;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
function planPaths(context: WorkspaceOperationOriginalMoveContext) {
  const effects = workspaceOperationOriginalMoveNamespaceEffects(context);
  return { effects, sources: effects.map(effect => effect.sourcePath), destinations: effects.map(effect => effect.destinationPath),
    known: [...new Set(context.plan.nativePathPlan.pathMappings.flatMap(mapping => [mapping.source.path, mapping.destinationPath]))] };
}
function rows(value: unknown, context: WorkspaceOperationOriginalMoveContext): Rows {
  const row = exact(value, keys), allowed = new Set(planPaths(context).sources.concat(planPaths(context).destinations));
  let count = 0;
  const base: Record<string, string[]> = {
    metadata: ['workspaceId','path','title','createdAt','updatedAt'],
    userStates: ['workspaceId','userId','path','isFavorite','pinnedAt','createdAt','updatedAt'],
    publicShares: ['id','workspaceId','organizationId','path','status','policyRevision','revokedAt','revokedReason','updatedAt','preservedRowProof'],
    locks: ['id','workspaceId','organizationId','path','lineageId','revisionId','lockedByUserId','lockedBySessionId','lockType','status','expiresAt','createdAt','updatedAt','preservedRowProof'],
  };
  for (const key of keys) {
    const list = row[key]; if (!Array.isArray(list) || list.length > 256 || (count += list.length) > 2048) fail();
    if (key === 'guests' && list.length) fail('ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED');
    const seen = new Set<string>();
    for (const entry of list) {
      const item = exact(entry, base[key]);
      if (item.workspaceId !== context.plan.workspaceId || typeof item.path !== 'string' || !allowed.has(item.path)) fail();
      if (key === 'metadata') { if (item.title !== null && (typeof item.title !== 'string' || Buffer.byteLength(item.title) > 640)) fail(); }
      if (key === 'userStates') { text(item.userId); if (typeof item.isFavorite !== 'boolean') fail(); clock(item.pinnedAt, 0, true); }
      for (const name of ['createdAt','updatedAt'] as const) if (Object.hasOwn(item, name)) clock(item[name]);
      if (key === 'publicShares' || key === 'locks') {
        text(item.id); text(item.organizationId,256,true); proof(item.preservedRowProof);
        if (item.organizationId !== context.plan.sourceEvidence.workspaceScope.organizationId || item.status !== 'active') fail();
      }
      if (key === 'publicShares') { clock(item.policyRevision,1); if ((item.policyRevision as number) >= Number.MAX_SAFE_INTEGER-1) fail();
        clock(item.revokedAt,0,true); text(item.revokedReason,4096,true); }
      if (key === 'locks') { for (const name of ['lineageId','revisionId','lockedByUserId','lockedBySessionId']) text(item[name],256,true);
        if (!['edit','upload','agent_write'].includes(String(item.lockType))) fail(); clock(item.expiresAt); }
      const identity = key === 'metadata' ? item.path : key === 'userStates' ? `${item.path}\0${item.userId}` : item.id;
      if (seen.has(String(identity))) fail(); seen.add(String(identity));
    }
  }
  return row as Rows;
}
function lineageRows(value: unknown, context: WorkspaceOperationOriginalMoveContext): readonly Row[] {
  if (!Array.isArray(value) || value.length > 256) fail();
  const sources = new Set(planPaths(context).sources), ids = new Set<string>(), paths = new Set<string>();
  for (const raw of value) {
    const row = exact(raw,lineageKeys);
    for (const name of ['id','workspace_id','workspace_type']) text(row[name]);
    for (const name of ['organization_id','customer_id','project_id','trash_entry_id']) text(row[name],256,true);
    clock(row.created_at); clock(row.archived_at,0,true);
    if (row.workspace_id !== context.plan.workspaceId || row.workspace_type !== context.plan.sourceEvidence.workspaceScope.workspaceType
      || row.organization_id !== context.plan.sourceEvidence.workspaceScope.organizationId || row.status !== 'active'
      || row.archived_at !== null || typeof row.path !== 'string' || !sources.has(row.path)
      || ids.has(String(row.id)) || paths.has(row.path)) fail();
    ids.add(String(row.id)); paths.add(row.path);
  }
  return value as Row[];
}
export function decodeWorkspaceOperationOriginalMoveNamespaceStage(stageText: string,
  context: WorkspaceOperationOriginalMoveContext): WorkspaceOperationOriginalMoveNamespaceStage {
  const effects = planPaths(context).effects;
  const row = exact(parse(stageText,MiB),['version','batchId','planId','workspaceId','organizationId','requestHash','actor','schema','effectsProof','beforeRows','lineages']);
  if (row.version !== 1 || row.batchId !== context.batchId || row.planId !== context.plan.planId || row.workspaceId !== context.plan.workspaceId
    || row.organizationId !== context.plan.sourceEvidence.workspaceScope.organizationId || row.requestHash !== context.requestHash
    || !equal(row.actor,context.actor) || row.effectsProof !== nativeLinkJsonProof(effects) || !effects.length) fail();
  text(row.schema,63); rows(row.beforeRows,context); lineageRows(row.lineages,context);
  const sourcePaths = new Set(planPaths(context).sources);
  const beforeRows = row.beforeRows as Rows;
  for (const key of ['metadata','userStates','publicShares'] as const) {
    if (beforeRows[key].some(item => !sourcePaths.has(String(item.path)))) fail();
  }
  return freeze(row) as WorkspaceOperationOriginalMoveNamespaceStage;
}
function after(stage: WorkspaceOperationOriginalMoveNamespaceStage, context: WorkspaceOperationOriginalMoveContext, at: number) {
  const mapping = new Map(planPaths(context).effects.map(effect => [effect.sourcePath,effect.destinationPath]));
  const result = structuredClone(stage.beforeRows);
  for (const key of ['metadata','userStates'] as const) result[key] = result[key].map<Row>(row => ({...row,path:mapping.get(String(row.path))!}))
    .sort((left,right) => Buffer.compare(Buffer.from(`${left.path}${key === 'userStates' ? `\u001f${left.userId}` : ''}`),
      Buffer.from(`${right.path}${key === 'userStates' ? `\u001f${right.userId}` : ''}`)));
  result.publicShares = result.publicShares.map(row => ({...row,status:'revoked',policyRevision:Number(row.policyRevision)+1,
    revokedAt:at,revokedReason:'target_moved',updatedAt:at}));
  result.locks = result.locks.map(row => ({...row,path:Number(row.expiresAt)>at ? mapping.get(String(row.path))! : row.path,
    status:Number(row.expiresAt)>at ? 'active':'expired',updatedAt:at}));
  const lineages: Row[] = stage.lineages.map(row => ({...row,path:mapping.get(String(row.path))!}));
  return {rows:result,lineages};
}
export function decodeWorkspaceOperationOriginalMoveNamespaceReceipt(receiptText: string, context: WorkspaceOperationOriginalMoveContext,
  state: WorkspaceOperationOriginalMoveNamespaceState): WorkspaceOperationOriginalMoveNamespaceReceipt {
  const stage = decodeWorkspaceOperationOriginalMoveNamespaceStage(state.stageText,context);
  proof(state.stageDigest); if (sha(state.stageText) !== state.stageDigest) fail();
  const row = exact(parse(receiptText,16384),['version','batchId','planId','workspaceId','effectsProof','stageDigest','appliedAt','afterRowsProof','rowCounts']);
  if (row.version !== 1 || row.batchId !== context.batchId || row.planId !== context.plan.planId || row.workspaceId !== context.plan.workspaceId
    || row.effectsProof !== stage.effectsProof || row.stageDigest !== state.stageDigest) fail();
  clock(row.appliedAt); validateBefore(stage,context,row.appliedAt as number);
  const expected = after(stage,context,row.appliedAt as number);
  if (row.afterRowsProof !== nativeLinkJsonProof(expected) || !equal(row.rowCounts,
    Object.fromEntries([...keys.map(key => [key,stage.beforeRows[key].length]),['lineages',stage.lineages.length]]))) fail();
  return freeze(row) as WorkspaceOperationOriginalMoveNamespaceReceipt;
}
async function readLineages(database: SqlConnection, schema: string, context: WorkspaceOperationOriginalMoveContext): Promise<Row[]> {
  const {sources,destinations,known} = planPaths(context), paths = [...sources,...destinations];
  if (await database.get(`SELECT 1 AS found FROM ${table(schema,'collaboration_documents')} WHERE workspace_id=$1
    AND path=ANY($2::text[]) AND status='active' LIMIT 1`,[context.plan.workspaceId,paths])) fail('ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED');
  const selected = await database.all(`SELECT CASE WHEN octet_length(id)<=256 AND octet_length(path)<=4096
    AND octet_length(workspace_id)<=256 AND octet_length(workspace_type)<=64
    AND (organization_id IS NULL OR octet_length(organization_id)<=256)
    AND (customer_id IS NULL OR octet_length(customer_id)<=256) AND (project_id IS NULL OR octet_length(project_id)<=256)
    AND (trash_entry_id IS NULL OR octet_length(trash_entry_id)<=256) THEN to_jsonb(l) ELSE NULL END AS row_json
    FROM ${table(schema,'file_collaboration_lineages')} l WHERE workspace_id=$1 AND path=ANY($2::text[]) AND status='active'
    ORDER BY id COLLATE "C" LIMIT 257 FOR UPDATE`,[context.plan.workspaceId,paths]) as Array<{row_json:Row|null}>;
  if (selected.length>256 || selected.some(row=>!row.row_json)) fail();
  if (await database.get(`SELECT 1 AS found FROM ${table(schema,'file_collaboration_lineages')} WHERE workspace_id=$1 AND status='active'
    AND EXISTS(SELECT 1 FROM unnest($2::text[]) scope WHERE left(path,length(scope)+1)=scope||'/')
    AND NOT path=ANY($3::text[]) LIMIT 1`,[context.plan.workspaceId,paths,known])) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  const result=selected.map(row=>row.row_json!); lineageRows(result,context); return result;
}
function validateBefore(stage: WorkspaceOperationOriginalMoveNamespaceStage, context: WorkspaceOperationOriginalMoveContext, now:number) {
  const {sources,destinations}=planPaths(context), sourceSet=new Set(sources), destinationSet=new Set(destinations);
  for(const key of ['metadata','userStates','publicShares'] as const)
    if(stage.beforeRows[key].some(row=>!sourceSet.has(String(row.path)) || destinationSet.has(String(row.path)))) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  for(const row of stage.beforeRows.locks) {
    if(Number(row.expiresAt)>now && (!sourceSet.has(String(row.path)) || row.lockedByUserId!==context.actor.userId
      || row.lockedBySessionId!==context.actor.actorSessionId)) fail('ORIGINAL_MOVE_NAMESPACE_BUSY');
    if(row.lineageId!==null && sourceSet.has(String(row.path))
      && !stage.lineages.some(lineage=>lineage.path===row.path && lineage.id===row.lineageId)) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  }
}
async function realm(database:SqlConnection,schema:string) {
  const row=await database.get('SELECT current_schema() AS schema_name, floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS clock_ms') as Row|undefined;
  if(row?.schema_name!==schema) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  const now=Number(row.clock_ms); clock(now); return now;
}
/** Fixed bounded before-image only; the caller owns current policy, transaction,
 * immutable-journal staging and all filesystem/admission fences. */
export async function captureWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection(database:SqlConnection,input:{
  schema:string;workspace:WorkspaceContext;context:WorkspaceOperationOriginalMoveContext;
}):Promise<WorkspaceOperationOriginalMoveNamespaceState|null> {
  const {context,schema,workspace}=input,{effects,sources,destinations,known}=planPaths(context);
  if(!effects.length)return null;
  if(workspace.workspaceId!==context.plan.workspaceId || workspace.organizationId!==context.plan.sourceEvidence.workspaceScope.organizationId) fail();
  const now=await realm(database,schema);
  const beforeRows=await readWorkspacePathSideEffectRowsOnConnection(database,schema,workspace.workspaceId,[...sources,...destinations],undefined,undefined,known);
  const lineages=await readLineages(database,schema,context);
  const stageText=canonical({version:1,batchId:context.batchId,planId:context.plan.planId,workspaceId:workspace.workspaceId,
    organizationId:workspace.organizationId,requestHash:context.requestHash,actor:context.actor,schema,
    effectsProof:nativeLinkJsonProof(effects),beforeRows,lineages});
  const stage=decodeWorkspaceOperationOriginalMoveNamespaceStage(stageText,context); validateBefore(stage,context,now);
  return Object.freeze({stageText,stageDigest:sha(stageText)});
}
/** Fixed Move-owner consumer. A plain DTO or another connection cannot enter;
 * actual DA04 mutation authority and the immutable original journal are required. */
export async function applyWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection(database:SqlConnection,input:{
  workspace:WorkspaceContext;context:WorkspaceOperationOriginalMoveContext;intent:WorkspaceOperationOriginalMoveIntentData;
}):Promise<{effectsProof:string;receiptDigest:string;receiptText:string}|null> {
  const {readWorkspaceOperationOriginalMoveSourcesContext}=await import('./workspace-operation-job-lifecycle-owner');
  const actual=await readWorkspaceOperationOriginalMoveSourcesContext(database);
  if(!equal(input.context,actual.context)||!equal(input.intent,actual.intent)||input.workspace.workspaceId!==actual.context.plan.workspaceId) fail();
  if(!actual.intent.namespaceEffects.length)return null;
  const state=actual.intent.namespaceState; if(!state)fail();
  const stage=decodeWorkspaceOperationOriginalMoveNamespaceStage(state.stageText,actual.context);
  if(sha(state.stageText)!==state.stageDigest)fail();
  return withCollaborationAdmissionMutation(database,actual.context.plan.actions[0].kind,async assertActive=>{
    const check=async()=>{assertActive();await actual.assertCurrent();assertActive();};
    await check(); const now=await realm(database,stage.schema); validateBefore(stage,actual.context,now);
    const {sources,destinations,known}=planPaths(actual.context),paths=[...sources,...destinations];
    const before=await readWorkspacePathSideEffectRowsOnConnection(database,stage.schema,input.workspace.workspaceId,paths,undefined,undefined,known);
    const lineages=await readLineages(database,stage.schema,actual.context); await check();
    if(!equal(before,stage.beforeRows)||!equal(lineages,stage.lineages))fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
    const expected=after(stage,actual.context,now), mappings=planPaths(actual.context).effects;
    const write=async(sql:string,values:unknown[],count:number)=>{await check();const result=await database.run(sql,values) as {changes?:number};
      assertActive();if(result.changes!==count)fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');await check();};
    for(const mapping of mappings)for(const key of ['metadata','userStates'] as const){
      const spec=NATIVE_FILE_SIDE_EFFECT_ROW_SPECS.find(spec=>spec.key===key)!;
      await write(`UPDATE ${table(stage.schema,spec.table)} SET path=$1 WHERE workspace_id=$2 AND path=$3`,
        [mapping.destinationPath,input.workspace.workspaceId,mapping.sourcePath],stage.beforeRows[key].filter(row=>row.path===mapping.sourcePath).length);
    }
    for(const row of expected.rows.publicShares)await write(`UPDATE ${table(stage.schema,'public_file_shares')}
      SET status='revoked',policy_revision=policy_revision+1,revoked_at=$1,revoked_reason='target_moved',updated_at=$1
      WHERE workspace_id=$2 AND id=$3 AND status='active'`,[now,input.workspace.workspaceId,row.id],1);
    for(const row of [...expected.rows.locks].sort((a,b)=>Number(a.status==='active')-Number(b.status==='active')))
      await write(`UPDATE ${table(stage.schema,'file_locks')} SET path=$1,status=$2,updated_at=$3 WHERE workspace_id=$4 AND id=$5 AND status='active'`,
        [row.path,row.status,now,input.workspace.workspaceId,row.id],1);
    for(const row of expected.lineages)await write(`UPDATE ${table(stage.schema,'file_collaboration_lineages')}
      SET path=$1 WHERE workspace_id=$2 AND id=$3 AND status='active'`,[row.path,input.workspace.workspaceId,row.id],1);
    const observed=await readWorkspacePathSideEffectRowsOnConnection(database,stage.schema,input.workspace.workspaceId,paths,expected.rows,undefined,known);
    // Read only exact originally selected lineage IDs after their path transition.
    const actualLineages=await database.all(`SELECT to_jsonb(l) AS row_json FROM ${table(stage.schema,'file_collaboration_lineages')} l
      WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR UPDATE`,
    [input.workspace.workspaceId,stage.lineages.map(row=>row.id)]) as Array<{row_json:Row}>;
    await check();if(!equal(observed,expected.rows)||!equal(actualLineages.map(row=>row.row_json),expected.lineages))fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
    const receiptText=canonical({version:1,batchId:actual.context.batchId,planId:actual.context.plan.planId,workspaceId:input.workspace.workspaceId,
      effectsProof:stage.effectsProof,stageDigest:state.stageDigest,appliedAt:now,afterRowsProof:nativeLinkJsonProof(expected),
      rowCounts:Object.fromEntries([...keys.map(key=>[key,stage.beforeRows[key].length]),['lineages',stage.lineages.length]])});
    decodeWorkspaceOperationOriginalMoveNamespaceReceipt(receiptText,actual.context,state);await check();
    return Object.freeze({effectsProof:stage.effectsProof,receiptDigest:sha(receiptText),receiptText});
  });
}
