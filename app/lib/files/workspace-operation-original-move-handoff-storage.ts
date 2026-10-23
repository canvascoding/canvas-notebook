import 'server-only';

import type { SqlConnection } from '../db';
import { NATIVE_FILE_OPERATION_HANDOFF_STATEMENTS } from '../db/native-file-operation-handoff-migration';
import { NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS } from '../db/native-file-operation-side-effects-migration';

type Row = Record<string,unknown>;
const quote = (value:string) => `"${value.replaceAll('"','""')}"`;
function fail():never { throw Object.assign(new Error('Original Move handoff storage changed.'),{code:'ORIGINAL_MOVE_STORAGE_CHANGED',status:409}); }
const tables = {
  collaboration_admission_requests: 'request_id:text request_digest:text intent_text:text status:text revision:bigint created_at:bigint completed_at:bigint? outcome_text:text?',
  collaboration_admission_scopes: 'request_id:text ordinal:integer workspace_id:text organization_id:text? path:text kind:text',
  collaboration_admission_targets: 'request_id:text document_id:text snapshot_text:text active:boolean status:text release_id:text? quiescence_kind:text? quiescence_text:text? source_outcome_request_id:text? outcome_snapshot_text:text? outcome_snapshot_digest:text?',
  collaboration_native_file_operation_intents: 'operation_id:text request_id:text changes_bundle_proof:text intent_text:text',
  collaboration_native_file_operation_receipts: 'operation_id:text mutation_id:text document_id:text request_id:text changes_bundle_proof:text receipt_text:text receipt_digest:text after_state_snapshot:bytea',
  collaboration_native_file_operation_side_effect_stages: 'operation_id:text request_id:text stage_text:text stage_digest:text',
  collaboration_native_file_operation_side_effect_receipts: 'operation_id:text request_id:text stage_digest:text native_receipt_set_proof:text receipt_text:text receipt_digest:text',
} as const;
const triggerSpecs = [
  ['collaboration_native_file_operation_intents','native_file_intent_immutable','immutable_native_file_operation_record',27,false],
  ['collaboration_native_file_operation_receipts','native_file_receipt_immutable','immutable_native_file_operation_record',27,false],
  ['collaboration_native_file_operation_receipts','native_file_receipt_endstate','validate_native_file_operation_endstate',5,true],
  ['collaboration_native_file_operation_side_effect_stages','native_file_side_effect_stage_guard','validate_native_file_side_effect_stage',7,false],
  ['collaboration_native_file_operation_side_effect_stages','native_file_side_effect_stage_immutable','immutable_native_file_side_effect_record',27,false],
  ['collaboration_native_file_operation_side_effect_stages','native_file_side_effect_stage_complete','native_file_side_effect_stage_complete',5,true],
  ['collaboration_native_file_operation_side_effect_receipts','native_file_side_effect_receipt_immutable','immutable_native_file_side_effect_record',27,false],
  ['collaboration_native_file_operation_side_effect_receipts','native_file_side_effect_receipt_guard','validate_native_file_side_effect_endstate',5,true],
] as const;
const functionSpecs = new Map([...NATIVE_FILE_OPERATION_HANDOFF_STATEMENTS,...NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS].flatMap(sql => {
  const matched = /^CREATE OR REPLACE FUNCTION ([a-z_]+)\([^]*?\$\$([^]*)\$\$/u.exec(sql);
  return matched ? [[matched[1],matched[2]] as const] : [];
}));

/** Fixed additional DA04/native stores. This is an internal schema pin only;
 * actual Claim, actor policy, session fences and TX lifetime stay in the Owner. */
export async function bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection(database:SqlConnection,
  source:Readonly<{schemaName:string;schemaOid:number;databaseOid:number}>) {
  const names = Object.keys(tables), prefix = quote(source.schemaName);
  const initial = await database.all(`SELECT c.relname,c.oid::bigint AS oid,c.relnamespace::bigint AS schema,c.relkind,c.relpersistence,
    c.relrowsecurity,c.relforcerowsecurity,pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname))::oid::bigint AS resolved
    FROM pg_catalog.pg_class c WHERE c.relnamespace=$1::oid AND c.relname=ANY($2::text[]) ORDER BY c.relname COLLATE "C"`,[source.schemaOid,names]) as Row[];
  if (initial.length !== names.length || new Set(initial.map(row=>row.relname)).size !== names.length || initial.some(row=>
    !names.includes(String(row.relname)) || Number(row.oid) !== Number(row.resolved) || Number(row.schema) !== source.schemaOid
    || !Number.isSafeInteger(Number(row.oid)) || Number(row.oid)<1 || row.relkind!=='r' || row.relpersistence!=='p'
    || row.relrowsecurity!==false || row.relforcerowsecurity!==false)) fail();
  const ids=initial.map(row=>Number(row.oid));
  await database.run(`LOCK TABLE ${names.map(name=>`${prefix}.${quote(name)}`).join(',')} IN ROW EXCLUSIVE MODE NOWAIT`);
  const snapshotSql=`WITH observed_relations AS MATERIALIZED (
SELECT c.relname,c.oid::bigint AS oid,c.relnamespace::bigint AS schema,c.relkind,c.relpersistence,
      c.relrowsecurity,c.relforcerowsecurity,pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname))::oid::bigint AS resolved
      FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::oid[]) ORDER BY c.relname COLLATE "C"
),
observed_locks AS MATERIALIZED (
SELECT count(DISTINCT relation)::integer AS count FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='relation' AND database=$2::oid AND relation=ANY($1::oid[]) AND granted
      AND mode IN('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
),
observed_columns AS MATERIALIZED (
SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      a.attgenerated,a.attidentity,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE c.oid=ANY($1::oid[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname COLLATE "C",a.attname COLLATE "C" LIMIT 129
),
observed_triggers AS MATERIALIZED (
SELECT t.oid::bigint AS oid,c.relname,t.tgname,t.tgisinternal,t.tgenabled,t.tgtype,t.tgnargs,
      t.tgqual::text AS qualification,t.tgattr::text AS attributes,t.tgdeferrable,t.tginitdeferred,
      p.oid::bigint AS function_oid,p.proname,p.prosrc,p.prosecdef,p.proconfig,p.prokind,p.pronargs,p.pronamespace::bigint AS function_schema,
      p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger,l.lanname,n.nspname,
      f.contype,f.convalidated,f.conenforced,f.condeferrable,child.relnamespace::bigint AS child_schema,parent.relnamespace::bigint AS parent_schema
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid AND c.oid=ANY($1::oid[]) JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      LEFT JOIN pg_catalog.pg_constraint f ON f.oid=t.tgconstraint LEFT JOIN pg_catalog.pg_class child ON child.oid=f.conrelid
      LEFT JOIN pg_catalog.pg_class parent ON parent.oid=f.confrelid WHERE t.tgrelid=ANY($1::oid[]) ORDER BY t.oid::bigint LIMIT 129
),
observed_functions AS MATERIALIZED (
SELECT p.oid::bigint AS oid,p.proname,p.prosrc,p.prosecdef,p.proconfig,p.prokind,l.lanname
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.pronamespace=$3::oid AND p.proname=ANY($4::text[]) ORDER BY p.oid::bigint LIMIT 17
),
observed_constraints AS MATERIALIZED (
SELECT c.oid::bigint AS oid,c.conname,c.conrelid::bigint AS relation,c.contype,c.convalidated,c.conenforced,
      c.condeferrable,c.condeferred,pg_catalog.pg_get_constraintdef(c.oid,true) AS definition
      FROM pg_catalog.pg_constraint c WHERE c.conrelid=ANY($1::oid[]) ORDER BY c.oid::bigint LIMIT 129
),
storage_snapshot AS MATERIALIZED (
SELECT COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) ORDER BY q.relname COLLATE "C") FROM observed_relations q),'[]'::jsonb) AS relations,
(SELECT pg_catalog.to_jsonb(q) FROM observed_locks q) AS locks,
COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) ORDER BY q.relname COLLATE "C",q.attname COLLATE "C") FROM observed_columns q),'[]'::jsonb) AS columns,
COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) ORDER BY q.oid) FROM observed_triggers q),'[]'::jsonb) AS triggers,
COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) ORDER BY q.oid) FROM observed_functions q),'[]'::jsonb) AS functions,
COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q) ORDER BY q.oid) FROM observed_constraints q),'[]'::jsonb) AS constraints
)`;
  const inspect=async(initializing=false)=>{
    // One bounded catalogue snapshot preserves every existing storage assertion
    // without six separate round trips at each fixed Owner method boundary.
    const snapshot=await (database.getPrepared ?? database.get).call(database, `${snapshotSql}
SELECT ${initializing ? 's.*,' : ''} pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(s)::text, 'UTF8')), 'hex') AS fingerprint FROM storage_snapshot s`,
      [ids,source.databaseOid,source.schemaOid,[...functionSpecs.keys()]]) as {relations:Row[];locks:Row;columns:Row[];triggers:Row[];functions:Row[];constraints:Row[];fingerprint:string}|undefined;
    if(!snapshot||typeof snapshot.fingerprint!=='string'||!/^[a-f0-9]{64}$/u.test(snapshot.fingerprint))fail();
    // The same SHA-256 over every bounded snapshot fact avoids retransmitting
    // trigger/function bodies at each boundary. Initial validation stays full.
    if(!initializing)return snapshot.fingerprint;
    if(Object.keys(snapshot).length!==7||![snapshot.relations,snapshot.columns,snapshot.triggers,snapshot.functions,snapshot.constraints].every(Array.isArray)||!snapshot.locks)fail();
    const relations=snapshot.relations;
    // jsonb orders object keys and encodes bigint values as JSON numbers.
    // Compare all eight selected facts in one explicit canonical projection.
    if(relations.some(row=>Object.keys(row).length!==8)||JSON.stringify(relations.map(row=>({
      relname:row.relname,oid:Number(row.oid),schema:Number(row.schema),relkind:row.relkind,relpersistence:row.relpersistence,
      relrowsecurity:row.relrowsecurity,relforcerowsecurity:row.relforcerowsecurity,resolved:Number(row.resolved)})))!==JSON.stringify(initial.map(row=>({
      relname:row.relname,oid:Number(row.oid),schema:Number(row.schema),relkind:row.relkind,relpersistence:row.relpersistence,
      relrowsecurity:row.relrowsecurity,relforcerowsecurity:row.relforcerowsecurity,resolved:Number(row.resolved)}))))fail();
    const locks=snapshot.locks;
    if(locks?.count!==ids.length)fail();
    const columns=snapshot.columns;
    if(columns.length>128)fail();
    for(const [name,spec] of Object.entries(tables)) {
      const expected=spec.split(' ').map(field=>{const [column,type]=field.split(':');return {column,type:type.replace('?',''),notNull:!type.endsWith('?')};}).sort((a,b)=>a.column<b.column?-1:1);
      const actual=columns.filter(row=>row.relname===name);
      if(actual.length!==expected.length||actual.some((row,index)=>row.attname!==expected[index].column||row.type!==expected[index].type
        ||row.attnotnull!==expected[index].notNull||row.attgenerated!==''||row.attidentity!==''))fail();
    }
    const triggers=snapshot.triggers;
    if(triggers.length>128)fail();const found=new Set<string>();
    for(const row of triggers) {
      if(!['O','A'].includes(String(row.tgenabled))||row.prosecdef!==false||row.proconfig!==null||row.prokind!=='f'||Number(row.pronargs)!==0||row.returns_trigger!==true)fail();
      if(row.tgisinternal===true) {
        if(row.contype!=='f'||row.convalidated!==true||row.conenforced!==true||row.condeferrable!==false
          ||Number(row.child_schema)!==source.schemaOid||Number(row.parent_schema)!==source.schemaOid
          ||row.nspname!=='pg_catalog'||row.lanname!=='internal'||typeof row.proname!=='string'||!/^RI_FKey_/u.test(row.proname)||row.prosrc!==row.proname)fail();
      } else {
        const expected=triggerSpecs.find(spec=>spec[0]===row.relname&&spec[1]===row.tgname);
        if(!expected||found.has(String(row.tgname)))fail();
        if(row.proname!==expected[2]||row.prosrc!==functionSpecs.get(expected[2])||Number(row.function_schema)!==source.schemaOid||row.lanname!=='plpgsql'
          ||Number(row.tgtype)!==expected[3]||row.tgdeferrable!==expected[4]||row.tginitdeferred!==expected[4]||Number(row.tgnargs)!==0
          ||row.qualification!==null||row.attributes!=='')fail();found.add(String(row.tgname));
      }
    }
    if(found.size!==triggerSpecs.length)fail();
    // Pin helper-function bodies as well as their calling triggers.
    const functions=snapshot.functions;
    if(functions.length!==functionSpecs.size||functions.some(row=>typeof row.proname!=='string'||row.prosrc!==functionSpecs.get(row.proname)
      ||row.prosecdef!==false||row.proconfig!==null||row.prokind!=='f'||row.lanname!=='plpgsql'))fail();
    const constraints=snapshot.constraints;
    if(constraints.length>128||constraints.some(row=>row.convalidated!==true||row.conenforced!==true
      ||(row.contype==='t' ? !['native_file_receipt_endstate','native_file_side_effect_stage_complete','native_file_side_effect_receipt_guard'].includes(String(row.conname))
        ||row.condeferrable!==true||row.condeferred!==true : row.condeferrable!==false||row.condeferred!==false)))fail();
    return snapshot.fingerprint;
  };
  const pinned=await inspect(true);return Object.freeze({assertCurrent:async()=>{if(await inspect()!==pinned)fail();}});
}
