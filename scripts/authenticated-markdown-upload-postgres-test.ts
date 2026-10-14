import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client,types } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import type { MarkdownUploadAttemptSelection } from '../app/lib/files/workspace-markdown-upload-attempt';
import type { SqlConnection } from '../app/lib/db';
import type { MarkdownFileImportResult } from '../app/lib/collaboration/markdown-file-import-persistence';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost','127.0.0.1'].includes(url.hostname));
  assert.equal(url.port,'55433'); assert.equal(url.pathname,'/canvas_notebook'); assert.equal(url.search,'');
  const schema = `authenticated_staging_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^authenticated_staging_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-authenticated-staging-'));
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async (int8Strings=false) => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      ...(int8Strings?{types:{getTypeParser:(oid:number,format?:'text'|'binary')=>oid===types.builtins.INT8?(value:string)=>value:types.getTypeParser(oid,format)}}:{}),
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=request-principal-fixture` });
    client.on('error',()=>undefined); // transaction_timeout may terminate this owned fixture client.
    clients.add(client); await client.connect(); return client;
  };
  const workspaceId = `bootstrap-space-${crypto.randomUUID()}`;
  let cases = 0;
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version)/10000),18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    // Set node-postgres PGOPTIONS BEFORE importing any runtime DB/Auth module.
    // No public fallback, no public-qualified epoch conversion/extension path.
    Object.assign(process.env,{ DATABASE_URL:connectionString,PGOPTIONS:`-c search_path=${schema},pg_catalog -c statement_timeout=15000`,
      CANVAS_DATABASE_PROVIDER:'postgres',DATA:dataRoot,CANVAS_DATA_ROOT:dataRoot,CANVAS_INSTANCE_ID:`fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET:crypto.randomBytes(32).toString('hex'),BETTER_AUTH_BASE_URL:'http://localhost',AUTH_COOKIE_SECURE:'false',
      CANVAS_MCP_DIRECT_ENABLED:'false',CANVAS_ORGANIZATION_ID:'principal-org',CANVAS_DEPLOYMENT_MODE:'team',CANVAS_TEAM_FEATURES_ENABLED:'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT:'production',CANVAS_LICENSE_CONTROL_PLANE_URL:'https://control.example.test' });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS; delete process.env.NEXT_PHASE;
    const keys = crypto.generateKeyPairSync('rsa',{ modulusLength:2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type:'spki',format:'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type:'spki',format:'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now()/1000);
    const claims = { protocolVersion:'canvas-team-seat-protocol-v1',licenseId:'principal-license',sub:process.env.CANVAS_INSTANCE_ID,
      instanceId:process.env.CANVAS_INSTANCE_ID,iss:'canvas-control-plane',aud:'canvas-notebook',plan:'community',status:'active',
      hostingMode:'community',edition:'team',licenseClass:'commercial',licenseEnvironment:'production',nonBillable:false,
      seatLimit:2,quotas:{ users:2 },entitlementsVersion:6,iat:seconds-60,exp:seconds+3600 };
    const header = Buffer.from(JSON.stringify({ alg:'RS256',typ:'JWT',kid:fingerprint.slice(0,16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256',Buffer.from(`${header}.${body}`),keys.privateKey).toString('base64url')}`;
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('No network/issuer is permitted in this isolated fixture.'); };
    stage = 'actual owned-schema global DDL';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    const own = async (client:Client) => {
      const row = (await client.query("SELECT current_schema() AS schema,current_setting('search_path') AS path")).rows[0];
      assert.equal(row.schema,schema); assert.deepEqual(row.path.split(',').map((s:string)=>s.trim()),[schema,'pg_catalog']);
    };
    await runPostgresMigrations({ query:async (sql:string,values?:unknown[]) => {
      await own(admin);
      let scoped = sql;
      if (sql.trim().startsWith('DO $main_agent_id_migration$')) {
        assert.equal(sql.split("table_schema = 'public'").length - 1, 2);
        scoped = sql.replaceAll("table_schema = 'public'", `table_schema = '${schema}'`);
        assert.equal(scoped.replaceAll(`table_schema = '${schema}'`, "table_schema = 'public'"), sql);
      }
      const result = await admin.query(scoped,values); await own(admin); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    stage = 'real users, memberships and auth sessions';
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@principal.test',1,'admin',0,$1,$1),
      ('member','Member','member@principal.test',1,'user',0,$1,$1),
      ('inactive','Inactive','inactive@principal.test',1,'user',0,$1,$1)`,[now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('principal-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES('principal-org','owner','owner','active',1,100,100),('principal-org','member','member','active',0,100,100),
      ('principal-org','inactive','member','disabled',0,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','principal-org','owner@principal.test','owner','owner','active',100,100,100,100),
      ('member-seat','principal-org','member@principal.test','member','member','active',100,200,100,100),
      ('inactive-seat','principal-org','inactive@principal.test','inactive','admin','suspended',100,50,100,100)`);
    await admin.query(`INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('principal-org',100,100)`);
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('${workspaceId}','principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`);
    for (const userId of ['owner','member','inactive']) {
      await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
        VALUES($1,'principal-org','personal',$2,$2,$3,'active',100,100)`,[`personal-${userId}`,userId,`users/${userId}/workspace`]);
    }
    await admin.query(`INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at)
      VALUES('drifted-customer','principal-org','Own Customer','own-customer','active',100,100)`);
    const tokens:Record<string,string> = {};
    const seedSession = async (userId='owner') => {
      const token = crypto.randomBytes(32).toString('hex'); tokens[userId]=token;
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`,
      [`session-${userId}`,token,userId,Date.now()+3600000,now]);
    };
    await seedSession(); await seedSession('member');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!,process.env.CANVAS_INSTANCE_ID!)).ok,true);
    const license = await getLicenseStatus(); assert.equal(license.licensed,true); assert.equal(license.edition,'team'); assert.equal(license.seatLimit,2);
    const { persistAuthenticatedMarkdownUploadFile: persist } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { openDb: actualOpenDb } = await import('../app/lib/db');
    const upload = await import('../app/lib/files/workspace-upload-service');
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { loadCollaborationStateOnConnection, serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { withWorkspaceFileLifecycleLeases } = await import('../app/lib/collaboration/file-lifecycle-admission-context');
    const root = path.join(dataRoot,'organizations/principal-org/shared'); await mkdir(root,{recursive:true});
    const request = async (actor='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if (cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[actor],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[actor]}`);
      return new NextRequest('http://localhost/api/files/upload',{headers});
    };
    type Entry = Awaited<ReturnType<typeof source>>;
    const source = async (filePath:string, actor='owner', content=Buffer.from('\uFEFF---\r\ntitle: Staged\r\n---\r\n# Actual source 🦊\r\n')) => {
      const original=await request(actor), resolved=await requireRequestWorkspace(original,{workspaceId,permissions:'canRead'}); assert(!resolved.response);
      const session=await upload.createWorkspaceUploadSession({userId:actor,workspace:resolved.workspace,targetDir:'.',files:[{path:filePath,size:content.byteLength,mimeType:'text/markdown'}]});
      const scope={sessionId:session.id,userId:actor,workspace:resolved.workspace};
      await upload.writeWorkspaceUploadChunk({...scope,fileId:session.files[0].id,offset:0,expectedBytes:content.byteLength,body:new Blob([content]).stream()});
      const selection:MarkdownUploadAttemptSelection={uploadSessionId:session.id,fileId:session.files[0].id,workspaceId,targetPath:filePath,
        actorUserId:actor,actorSessionId:`session-${actor}`,requestId:crypto.randomUUID(),operationId:crypto.randomUUID()};
      return {original,selection,scope,content,manifest:path.join(dataRoot,'.uploads/workspace',session.id,'session.json')};
    };
    type Event = {step:string;ordinal:number;pid:number;xid:string|null;isolation:string;readOnly:string;lockTimeout:string;transactionTimeout:string;searchPath:string;discard?:boolean};
    type Fault = {commit?:'before'|'after';afterReceipt?:(database:SqlConnection)=>Promise<void>;afterCommit?:()=>Promise<void>;
      afterLineage?:(database:SqlConnection)=>Promise<void>;beforePhase?:(ordinal:number)=>Promise<void>;beforeClose?:(ordinal:number,error?:Error)=>Promise<void>;closeFailure?:boolean;undefinedClose?:number;discardFailure?:boolean;wrongSearchPath?:boolean};
    const factory = (fault:Fault={}) => {
      const events:Event[]=[]; let opened=0,ownerPid=0;
      const openConnection=async():Promise<SqlConnection>=>{
        const ordinal=++opened; if(ordinal>1)await fault.beforePhase?.(ordinal);
        const actual=await actualOpenDb();let closed=false,inserted=false;
        if(ordinal===2&&fault.wrongSearchPath)await actual.run('SET search_path=pg_catalog');
        const inspect=async()=>await actual.get(`SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid,
          current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS "readOnly",
          current_setting('lock_timeout') AS "lockTimeout",current_setting('transaction_timeout') AS "transactionTimeout",current_setting('search_path') AS "searchPath"`) as Omit<Event,'step'|'ordinal'>;
        const start=await inspect();if(ordinal===1)ownerPid=start.pid;events.push({...start,ordinal,step:'open'});
        const ownerHeld=async()=>{
          const key=BigInt.asUintN(64,BigInt(collaborationAdmissionLockKey(workspaceId)));
          const row=(await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND granted
            AND mode='ExclusiveLock' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND classid::bigint=$2 AND objid::bigint=$3 AND objsubid=1) AS held`,[ownerPid,Number(key>>BigInt(32)),Number(key&BigInt('0xffffffff'))])).rows[0];
          assert.equal(row.held,true,'actual A must remain exclusive across every B/C DML and close');
        };
        const query=async(sql:string,args?:unknown[])=>{
          assert(!closed);const command=sql.trimStart();
          const step=/^(?:INSERT INTO|UPDATE) file_collaboration_lineages\b/u.test(command)?'lineage'
            :/^(?:INSERT INTO|UPDATE) collaboration_documents\b/u.test(command)?'registry'
            :/^INSERT INTO collaboration_yjs_states\b/u.test(command)?'native'
            :/^INSERT INTO collaboration_markdown_file_import_receipts\b/u.test(command)?'receipt'
            :/^SELECT \* FROM collaboration_markdown_file_import_receipts\b/u.test(command)?'retry'
            :/^BEGIN\b/iu.test(command)?'begin':/^COMMIT$/iu.test(command)?'commit':/^ROLLBACK$/iu.test(command)?'rollback':undefined;
          const identity=step==='rollback'?start:step?await inspect():undefined;
          if(step&&ordinal>1)await ownerHeld();
          if(step==='commit'&&inserted&&fault.commit==='before'){fault.commit=undefined;events.push({...identity!,ordinal,step:'commit-failed'});throw new Error('Owned pre-COMMIT fault');}
          const rows=await actual.all(sql,args);
          if(step)events.push({...identity!,ordinal,step});
          if(step==='receipt'){inserted=true;await fault.afterReceipt?.(actual);}
          if(step==='lineage')await fault.afterLineage?.(actual);
          if(step==='commit'&&inserted&&fault.commit==='after'){fault.commit=undefined;await fault.afterCommit?.();events.push({...identity!,ordinal,step:'commit-failed'});throw new Error('Owned lost COMMIT acknowledgement');}
          return rows;
        };
        return {all:query,get:async(sql,args)=>(await query(sql,args))[0],run:query,close:async error=>{
          if(closed)return;closed=true;if(ordinal>1)await ownerHeld();
          events.push({...start,ordinal,step:'close',discard:!!error});await fault.beforeClose?.(ordinal,error);
          if(ordinal===2&&error&&fault.discardFailure){await actual.close(error);events.push({...start,ordinal,step:'disposed'});throw new Error('Owned reported discard failure');}
          await actual.close(error);events.push({...start,ordinal,step:error?'disposed':'released'});
          if(ordinal===2&&!error&&fault.closeFailure)throw new Error('Owned post-COMMIT close failure');
          if(ordinal===fault.undefinedClose){events.push({...start,ordinal,step:'undefined-close-fault'});throw undefined;}
        }};
      };
      return {openConnection,events};
    };
    const direct:SqlConnection={get:async(sql,args)=>(await admin.query(sql,args)).rows[0],all:async(sql,args)=>(await admin.query(sql,args)).rows,
      run:async(sql,args)=>({changes:(await admin.query(sql,args)).rowCount??0}),close:()=>assert.fail('Fixture observer must remain owned.')};
    const check=async(name:string,action:()=>Promise<void>)=>{if(process.env.CANVAS_STAGING_TEST_CASE&&name!==process.env.CANVAS_STAGING_TEST_CASE)return;stage=name;await action();cases++;console.log('PASS '+name);};
    const count=async(entry:Entry,table:string)=>Number((await admin.query(`SELECT count(*)::int AS n FROM ${table}
      WHERE workspace_id=$1 AND ${table==='collaboration_markdown_file_import_receipts'?'operation_id':'path'}=$2`,[workspaceId,table==='collaboration_markdown_file_import_receipts'?entry.selection.operationId:entry.selection.targetPath])).rows[0].n);
    const empty=async(entry:Entry)=>{for(const table of ['collaboration_yjs_states','file_collaboration_lineages','collaboration_markdown_file_import_receipts'])assert.equal(await count(entry,table),0,table);};
    const code=(...codes:string[])=>(error:unknown)=>!!error&&typeof error==='object'&&codes.includes(String(Reflect.get(error,'code')));
    const permission=async(write:boolean)=>admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=$1 WHERE user_id='member'",[write?1:0]);
    const invoke=async(entry:Entry,fault:Fault={},cookie=false)=>{const owned=factory(fault);const result=await persist(cookie?await request(entry.selection.actorUserId,true):entry.original,entry.selection,owned);return {result,events:owned.events};};
    const native=async(result:MarkdownFileImportResult)=>{const value=await loadCollaborationStateOnConnection(direct,result.receipt.target.documentId,true);assert(value);return value;};
    const unchangedUpload=async(entry:Entry)=>{
      const value=await upload.getWorkspaceUploadSession(entry.scope);assert.equal(value.status,'receiving');assert.equal(value.files[0].status,'uploaded');
      assert.equal(await fs.lstat(path.join(root,entry.selection.targetPath)).catch(()=>null),null);
    };
    const phaseWrites=(events:Event[])=>events.filter(e=>['lineage','registry','native','receipt'].includes(e.step));
    await check('genuine bearer and cookie staging create preserve byte profile without target publication',async()=>{
      for(const cookie of [false,true]){
        const entry=await source(`created-${cookie}.md`),{result,events}=await invoke(entry,{},cookie),stored=await native(result);
        assert.equal(result.disposition,'applied');assert.equal(stored.lifecycleGeneration,1);assert.equal(stored.documentSequence,0);
        const canonical=inspectPersistedNativeCollaborationSnapshot(stored,(doc,snapshot)=>snapshot.content.kind==='plain_text'?snapshot.content.text:richMarkdownFromYDoc(doc));
        assert.equal(serializeCanonicalText(canonical,stored),entry.content.toString('utf8'));assert.equal(result.receipt.sourceHash,crypto.createHash('sha256').update(entry.content).digest('hex'));
        for(const event of phaseWrites(events)){assert.equal(event.ordinal,2);assert.equal(event.isolation,'read committed');assert.equal(event.readOnly,'off');assert.equal(event.lockTimeout,'50ms');assert.equal(event.transactionTimeout,'5s');}
        assert.equal(stored.checkpointedAt,null);assert.equal(result.receipt.checkpointRequired,true);await unchangedUpload(entry);
        const reordered={...entry,selection:Object.fromEntries(Object.entries(entry.selection).reverse()) as MarkdownUploadAttemptSelection};
        const retry=await invoke(reordered);assert.equal(retry.result.disposition,'already-applied');assert.equal(phaseWrites(retry.events).length,0);
        assert.equal(retry.result.receipt.requestFingerprint,result.receipt.requestFingerprint);await unchangedUpload(entry);
      }
    });
    await check('fixed canWrite and original actor session refuse read-only or caller-crafted authority',async()=>{
      const entry=await source('read-only.md','member'),owned=factory();
      await assert.rejects(persist(entry.original,entry.selection,owned),error=>Reflect.get(error as object,'status')===403);assert.equal(owned.events.length,0);await empty(entry);
      const wrong={...entry.selection,actorUserId:'owner',actorSessionId:'session-owner'};await permission(true);
      await assert.rejects(persist(entry.original,wrong,factory()),code('MARKDOWN_IMPORT_REQUEST_CONFLICT'));await empty(entry);
      const shaped={...entry.selection,bytes:Buffer.from('fake'),validateAuthority:async()=>undefined};
      await assert.rejects(persist(entry.original,shaped,factory()),code('MARKDOWN_IMPORT_INVALID_INPUT'));await permission(false);
    });
    await check('physical existing targets including empty bytes and aliases are never createOnly imports',async()=>{
      for(const kind of ['empty','link','directory']){
        const entry=await source(`foreign-${kind}.md`);const target=path.join(root,entry.selection.targetPath);
        if(kind==='empty')await writeFile(target,'');else if(kind==='link')await fs.symlink('created-false.md',target);else await mkdir(target);
        await assert.rejects(persist(entry.original,entry.selection,factory()),code('MARKDOWN_IMPORT_TARGET_CHANGED'));await empty(entry);
        assert(await fs.lstat(target));
      }
      await mkdir(path.join(root,'alias-parent'));await fs.symlink('alias-parent',path.join(root,'alias'));
      const entry=await source('alias/new.md');await assert.rejects(persist(entry.original,entry.selection,factory()),code('MARKDOWN_IMPORT_TARGET_CHANGED'));await empty(entry);
    });
    await check('pristine registry CAS and strict lineage refuse history or foreign scope without upserts',async()=>{
      const entry=await source('pristine.md'),id=`collab-${crypto.randomUUID()}`;
      await admin.query(`INSERT INTO collaboration_documents(id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
        VALUES($1,'principal-org',$2,'organization',$3,'yjs','active',0,1,1,'never_initialized')`,[id,workspaceId,entry.selection.targetPath]);
      const result=await invoke(entry);assert.equal(result.result.receipt.target.documentId,id);await unchangedUpload(entry);
      const drifted=await source('foreign-registry.md'),wrongId=`collab-${crypto.randomUUID()}`;
      await admin.query(`INSERT INTO collaboration_documents(id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle,customer_id)
        VALUES($1,'principal-org',$2,'organization',$3,'yjs','active',0,1,1,'never_initialized','drifted-customer')`,[wrongId,workspaceId,drifted.selection.targetPath]);
      const rejected=await persist(drifted.original,drifted.selection,factory()).then(()=>false,()=>true);
      if(!rejected)console.error('RED pristine registry scope',{unexpectedAccepted:true,native:await count(drifted,'collaboration_yjs_states'),receipt:await count(drifted,'collaboration_markdown_file_import_receipts')});
      assert.equal(rejected,true,'foreign pristine registry customer cannot receive an actual native import');
      assert.equal(await count(drifted,'collaboration_yjs_states'),0);assert.equal(await count(drifted,'collaboration_markdown_file_import_receipts'),0);
      const cas=await source('pristine-cas.md'),casId=`collab-${crypto.randomUUID()}`;
      await admin.query(`INSERT INTO collaboration_documents(id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
        VALUES($1,'principal-org',$2,'organization',$3,'yjs','active',0,1,1,'never_initialized')`,[casId,workspaceId,cas.selection.targetPath]);
      let changed=false;const compare=factory({afterLineage:async database=>{await database.run('UPDATE collaboration_documents SET state_version=1 WHERE id=$1',[casId]);changed=true;}});
      await assert.rejects(persist(cas.original,cas.selection,compare),code('MARKDOWN_IMPORT_TARGET_CHANGED'));assert.equal(changed,true);await empty(cas);
      const foreign=await source('foreign-lineage.md');await admin.query(`INSERT INTO file_collaboration_lineages(id,organization_id,workspace_id,workspace_type,path,status,created_at,customer_id)
        VALUES($1,'principal-org',$2,'organization',$3,'active',1,'foreign-customer')`,[`lineage-${crypto.randomUUID()}`,workspaceId,foreign.selection.targetPath]);
      await assert.rejects(persist(foreign.original,foreign.selection,factory()),code('MARKDOWN_IMPORT_TARGET_CHANGED'));assert.equal(await count(foreign,'collaboration_yjs_states'),0);assert.equal(await count(foreign,'collaboration_markdown_file_import_receipts'),0);
    });
    await check('foreign initialized target is never replaced by a new attempt',async()=>{
      const first=await source('existing-native.md');const created=await invoke(first);const before=await native(created.result),second=await source('existing-native.md');
      await assert.rejects(persist(second.original,second.selection,factory()),code('MARKDOWN_IMPORT_TARGET_CHANGED'));
      assert.deepEqual((await native(created.result)).yjsState,before.yjsState);assert.equal(await count(second,'collaboration_markdown_file_import_receipts'),0);
    });
    await check('private ALS-shaped lease cannot substitute for actual Owner A',async()=>{
      const entry=await source('shaped-owner.md');
      await assert.rejects(withWorkspaceFileLifecycleLeases(new Map([[workspaceId,{active:true,verify:async()=>true}]]),()=>persist(entry.original,entry.selection,factory())),code('MARKDOWN_IMPORT_BUSY'));await empty(entry);
    });
    await check('same-B final after receipt DML rolls back real ACL token and full workspace drift',async()=>{
      await permission(true);
      for(const drift of ['acl','token','root','customer','searchPath']){
        let patched=false;
        const entry=await source(`final-${drift}.md`,'member'),owned=factory({afterReceipt:async database=>{
          if(drift==='acl')await database.run("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
          if(drift==='token')await database.run("UPDATE session SET token='revoked-in-this-B' WHERE id='session-member'");
          if(drift==='root')await database.run("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/drifted' WHERE id=$1",[workspaceId]);
          if(drift==='customer')await database.run("UPDATE canvas_workspaces SET customer_id='drifted-customer' WHERE id=$1",[workspaceId]);
          if(drift==='searchPath')await database.run('SET LOCAL search_path=pg_catalog');
          patched=true;
        }});
        await assert.rejects(persist(entry.original,entry.selection,owned));assert.equal(patched,true,'actual same-B scope DML must succeed before final guard');assert.equal(owned.events.filter(e=>e.step==='receipt').length,1);await empty(entry);await unchangedUpload(entry);
      }
      await permission(false);
    });
    await check('target creation and upload TTL expiry after receipt reject and roll back before COMMIT',async()=>{
      for(const kind of ['target','ttl']){
        const entry=await source(`late-${kind}.md`),owned=factory({afterReceipt:async()=>{
          if(kind==='target')await writeFile(path.join(root,entry.selection.targetPath),'foreign\n');
          else {const manifest=JSON.parse(await readFile(entry.manifest,'utf8'));manifest.expiresAt='2000-01-01T00:00:00.000Z';await writeFile(entry.manifest,JSON.stringify(manifest));}
        }});
        await assert.rejects(persist(entry.original,entry.selection,owned));await empty(entry);assert.equal(owned.events.filter(e=>e.step==='receipt').length,1);
      }
    });
    await check('actual shared source and file fences remain held through B close and fresh C close',async()=>{
      const entry=await source('held-through-close.md');let observed=0;
      const probe=async()=>{
        const name=crypto.createHash('sha256').update(JSON.stringify([entry.selection.uploadSessionId,entry.selection.fileId])).digest('hex');
        for(const filename of [`session-${entry.selection.uploadSessionId}.lock`,`file-${name}.lock`]){
          const script='import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:\n sys.exit(7)\nfinally:\n os.close(f)\n';
          await assert.rejects(promisify(execFile)('python3',['-I','-c',script,path.join(dataRoot,'canvas-upload-live',filename)]),error=>Reflect.get(error as object,'code')===7);
        }
        observed++;
      };
      const owned=factory({commit:'after',beforeClose:async ordinal=>{if(ordinal>1)await probe();}}),result=await persist(entry.original,entry.selection,owned);
      assert.equal(result.disposition,'commit-recovered');assert.equal(observed,2);assert.equal(phaseWrites(owned.events).filter(e=>e.step==='native').length,1);
      const disposed=owned.events.findIndex(e=>e.ordinal===2&&e.step==='disposed'),recovery=owned.events.findIndex(e=>e.ordinal===3&&e.step==='retry');assert(disposed>=0&&recovery>disposed);
      assert.notEqual(owned.events.find(e=>e.ordinal===2&&e.step==='open')!.pid,owned.events.find(e=>e.ordinal===3&&e.step==='open')!.pid);
      for(const event of owned.events.filter(e=>e.ordinal===3&&e.step==='retry')){assert.equal(event.isolation,'read committed');assert.equal(event.readOnly,'off');assert.equal(event.lockTimeout,'50ms');}
      assert.equal(phaseWrites(owned.events).filter(e=>e.ordinal===3).length,0);await unchangedUpload(entry);
    });
    await check('rejected COMMIT and failed discarded B are never replayed or treated as successful',async()=>{
      for(const discardFailure of [false,true]){
        const entry=await source(`reject-${discardFailure}.md`),owned=factory({commit:'before',discardFailure});
        await assert.rejects(persist(entry.original,entry.selection,owned));await empty(entry);assert.equal(owned.events.filter(e=>e.step==='native').length,1);
        if(discardFailure)assert.equal(owned.events.filter(e=>e.ordinal===3).length,0);
      }
    });
    await check('fresh recovery C requires original current auth and full origin after actual committed drift',async()=>{
      await permission(true);
      for(const drift of ['write','token','root','customer']){
        stage='fresh recovery C '+drift;
        const entry=await source(`recovery-${drift}.md`,'member'),owned=factory({commit:'after',afterCommit:async()=>{
          if(drift==='write')await permission(false);
          if(drift==='token')await admin.query("UPDATE session SET token='actual-revoked-after-commit' WHERE id='session-member'");
          if(drift==='root')await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/drifted' WHERE id=$1",[workspaceId]);
          // Inject the FK-valid customer drift after the fresh Auth factory.
          // This counter observes the actual full-origin C guard itself.
        },beforePhase:async ordinal=>{
          if(ordinal===3&&drift==='customer')await admin.query("UPDATE canvas_workspaces SET customer_id='drifted-customer' WHERE id=$1",[workspaceId]);
        }});
        try {
          await assert.rejects(persist(entry.original,entry.selection,owned));
          stage='fresh recovery C '+drift+' receipt';
          assert.equal(await count(entry,'collaboration_markdown_file_import_receipts'),1);
          assert.equal(await count(entry,'collaboration_yjs_states'),1);
          assert.equal(owned.events.filter(e=>e.step==='native').length,1);
        }
        finally {await permission(true);await seedSession('member');await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared',customer_id=NULL WHERE id=$1",[workspaceId]);}
      }
      await permission(false);
    });
    await check('current raw corrupt quarantine or vector cannot validate a committed receipt',async()=>{
      const entry=await source('raw-retry.md'),created=await invoke(entry),id=created.result.receipt.target.documentId;
      for(const corrupt of ['degraded','orphan','future','vector']){
        const before=(await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1',[id])).rows[0];
        try {
          if(corrupt==='degraded')await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1',[id]);
          if(corrupt==='orphan')await admin.query('UPDATE collaboration_yjs_states SET projection_error_permanent=1 WHERE document_id=$1',[id]);
          if(corrupt==='future')await admin.query("UPDATE collaboration_yjs_states SET projection_error_code='future',projection_error_sequence=0,projection_error_generation=2 WHERE document_id=$1",[id]);
          if(corrupt==='vector')await admin.query('UPDATE collaboration_yjs_states SET state_vector=$2 WHERE document_id=$1',[id,Buffer.from([0])]);
          const owned=factory();await assert.rejects(persist(entry.original,entry.selection,owned));assert.equal(phaseWrites(owned.events).length,0);
        } finally {await admin.query(`UPDATE collaboration_yjs_states SET degraded=$2,projection_error_permanent=$3,projection_error_code=$4,projection_error_sequence=$5,
          projection_error_generation=$6,projection_error_phase=$7,state_vector=$8 WHERE document_id=$1`,[id,before.degraded,before.projection_error_permanent,before.projection_error_code,before.projection_error_sequence,before.projection_error_generation,before.projection_error_phase,before.state_vector]);}
      }
    });
    await check('ordinary B close failure after confirmed COMMIT yields no claimed success or recovery replay',async()=>{
      const entry=await source('close-failed.md'),owned=factory({closeFailure:true});await assert.rejects(persist(entry.original,entry.selection,owned));
      assert.equal(await count(entry,'collaboration_markdown_file_import_receipts'),1);assert.equal(owned.events.filter(e=>e.ordinal===3).length,0);await unchangedUpload(entry);
      for(const ordinal of [1,2,3]){
        stage='undefined actual close '+ordinal;
        const value=await source(`undefined-close-${ordinal}.md`),actual=factory({undefinedClose:ordinal,...(ordinal===3?{commit:'after' as const}:{})});
        const outcome=await persist(value.original,value.selection,actual).then(result=>({rejected:false,result}),error=>({rejected:true,error}));
        const own=actual.events.find(event=>event.ordinal===1&&event.step==='open')!;
        assert.equal(actual.events.filter(event=>event.step==='undefined-close-fault').length,1);
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[own.pid])).rows[0].n,0,'actual Owner A backend must be gone before the undefined closure assertion');
        const key=crypto.createHash('sha256').update(JSON.stringify([value.selection.uploadSessionId,value.selection.fileId])).digest('hex');
        for(const filename of [`session-${value.selection.uploadSessionId}.lock`,`file-${key}.lock`]){
          const probe='import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nfinally:\n os.close(f)\n';
          await promisify(execFile)('python3',['-I','-c',probe,path.join(dataRoot,'canvas-upload-live',filename)]);
        }
        await unchangedUpload(value);
        if(!outcome.rejected)console.error('RED undefined closure sentinel',{ordinal,unexpectedResolved:true,disposition:'result' in outcome?outcome.result.disposition:null,
          ownerActuallyDisposed:true,native:await count(value,'collaboration_yjs_states'),receipt:await count(value,'collaboration_markdown_file_import_receipts')});
        assert.equal(outcome.rejected,true,'undefined rejection after actual A/B/C close must never resolve an import result');
        assert.equal(await count(value,'collaboration_markdown_file_import_receipts'),1);
        assert.equal(phaseWrites(actual.events).filter(event=>event.step==='native').length,1);
        if(ordinal<3)assert.equal(actual.events.filter(event=>event.ordinal===3).length,0);
      }
      stage='undefined genuine B execution after actual receipt DML';
      const execution=await source('undefined-execution.md');let actualFault=false;
      const actual=factory({afterReceipt:async()=>{actualFault=true;throw undefined;}});
      await assert.rejects(persist(execution.original,execution.selection,actual));assert.equal(actualFault,true);
      assert.equal(actual.events.filter(event=>event.step==='receipt').length,1);await empty(execution);await unchangedUpload(execution);
    });
    await check('actual B raw search_path mismatch is rejected before native DML',async()=>{
      const entry=await source('wrong-realm.md'),owned=factory({wrongSearchPath:true});await assert.rejects(persist(entry.original,entry.selection,owned));await empty(entry);assert.equal(phaseWrites(owned.events).length,0);
    });
    await check('cancelled missing and completed original uploads never resurrect retained source bytes',async()=>{
      for(const kind of ['cancel','missing','completed']){
        const entry=await source(`dead-source-${kind}.md`);const first=await invoke(entry);const before=await native(first.result);
        if(kind==='cancel')await upload.cancelWorkspaceUploadSession(entry.scope);
        if(kind==='missing')await fs.unlink(entry.manifest);
        if(kind==='completed'){
          const progressPath=path.join(path.dirname(entry.manifest),`${entry.selection.fileId}.part.json`),progress=JSON.parse(await readFile(progressPath,'utf8'));progress.status='completed';await writeFile(progressPath,JSON.stringify(progress));
        }
        const owned=factory();await assert.rejects(persist(entry.original,entry.selection,owned));assert.equal(phaseWrites(owned.events).length,0);assert.deepEqual((await native(first.result)).yjsState,before.yjsState);
      }
    });
    assert.equal(fetches,0);console.log(`Authenticated Staging PG18: ${cases} genuine Auth/SQL/FS matrix families; no route, upload completion or publication activation.`);
  } finally {
    globalThis.fetch=originalFetch;
    try {if(pool)await pool.end();}
    finally {try{for(const client of clients)await client.end();}
      finally {try{if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);}}
        finally{await control.end();await rm(dataRoot,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}}}
  }
}
main().catch(error=>{console.error('Owned authenticated staging fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  frames:error instanceof Error?error.stack?.split('\n').slice(1).filter(line=>line.includes('/app/lib/')||line.includes('/scripts/')):undefined});process.exitCode=1;});
