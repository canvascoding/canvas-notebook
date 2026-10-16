import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client,types } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
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
  const schema = `authenticated_birth_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^authenticated_birth_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-authenticated-birth-'));
  console.log('First projection own fixture', {nodePid:process.pid,receipt:path.join(dataRoot,'live-owner-proof.json')});
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
      if (sql.trim().startsWith('DO $main_agent_id_migration$')) {
        assert.equal(sql.split('table_schema = current_schema()').length - 1, 2);
        assert.equal(sql.includes("table_schema = 'public'"), false);
      }
      const result = await admin.query(sql,values); await own(admin); return result;
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
    const { persistAndProjectAuthenticatedMarkdownUploadFile: persist, persistAuthenticatedMarkdownUploadFile: importOnly } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { openDb: actualOpenDb } = await import('../app/lib/db');
    const upload = await import('../app/lib/files/workspace-upload-service');
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { loadCollaborationStateOnConnection, serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
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
    type Fault = {commit?:'before'|'after';commitOrdinal?:number;afterBirth?:(database:SqlConnection)=>Promise<void>;afterFinalize?:(database:SqlConnection)=>Promise<void>;afterReceipt?:(database:SqlConnection)=>Promise<void>;afterCommit?:()=>Promise<void>;
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
        await fs.writeFile(path.join(dataRoot,'live-owner-proof.json'),JSON.stringify({version:1,nodePid:process.pid,schema,dataRoot,phaseOrdinal:ordinal,ownerPid,phasePid:start.pid,observedAt:new Date().toISOString()}),{mode:0o600});
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
            :/^INSERT INTO collaboration_markdown_create_births\b/u.test(command)?'birth':/^UPDATE collaboration_markdown_create_births SET finalized=1/u.test(command)?'finalize':/^SELECT \* FROM collaboration_markdown_file_import_receipts\b/u.test(command)?'retry'
            :/^BEGIN\b/iu.test(command)?'begin':/^COMMIT$/iu.test(command)?'commit':/^ROLLBACK$/iu.test(command)?'rollback':undefined;
          const identity=step==='rollback'?start:step?await inspect():undefined;
          if(step&&ordinal>1)await ownerHeld();
          if(step==='commit'&&(fault.commitOrdinal?ordinal===fault.commitOrdinal:inserted)&&fault.commit==='before'){fault.commit=undefined;events.push({...identity!,ordinal,step:'commit-failed'});throw new Error('Owned pre-COMMIT fault');}
          const rows=await actual.all(sql,args);
          if(step)events.push({...identity!,ordinal,step});
          if(step==='receipt'){inserted=true;await fault.afterReceipt?.(actual);}
          if(step==='lineage')await fault.afterLineage?.(actual);
          if(step==='birth')await fault.afterBirth?.(actual);
          if(step==='finalize')await fault.afterFinalize?.(actual);
          if(step==='commit'&&(fault.commitOrdinal?ordinal===fault.commitOrdinal:inserted)&&fault.commit==='after'){fault.commit=undefined;await fault.afterCommit?.();events.push({...identity!,ordinal,step:'commit-failed'});throw new Error('Owned lost COMMIT acknowledgement');}
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
    const check = async (name:string, action:()=>Promise<void>) => { if(process.env.CANVAS_FIRST_PROJECTION_CASE&&!name.includes(process.env.CANVAS_FIRST_PROJECTION_CASE))return;stage=name; await action(); cases++; console.log('PASS '+name); };
    const direct:SqlConnection={ get:async(sql,args)=>(await admin.query(sql,args)).rows[0], all:async(sql,args)=>(await admin.query(sql,args)).rows,
      run:async(sql,args)=>({changes:(await admin.query(sql,args)).rowCount??0}), close:()=>assert.fail('Fixture observer remains owned.') };
    const native=async(result:MarkdownFileImportResult)=>{ const value=await loadCollaborationStateOnConnection(direct,result.receipt.target.documentId); assert(value); return value; };
    const sqlCount=async(entry:Entry,table:string,field='operation_id')=>Number((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1 AND ${field}=$2`,[workspaceId,field==='operation_id'?entry.selection.operationId:entry.selection.targetPath])).rows[0].n);
    const noTarget=async(entry:Entry)=>assert.equal(await fs.lstat(path.join(root,entry.selection.targetPath)).catch(()=>null),null);
    const sourceStillLive=async(entry:Entry)=>{const live=await upload.getWorkspaceUploadSession(entry.scope);assert.equal(live.status,'receiving');assert.equal(live.files[0].status,'uploaded');};
    const claimPath=async(entry:Entry)=>{
      const anchor=JSON.parse(await fs.readFile(path.join(dataRoot,'canvas-markdown-create-births-anchor.json'),'utf8'));
      const storeName=anchor.version===1?'canvas-markdown-create-births':anchor.storeName;
      assert(anchor.version===1||anchor.version===2);assert.match(storeName,/^canvas-markdown-create-births(?:-[a-f0-9]{32})?$/u);
      return path.join(dataRoot,storeName,crypto.createHash('sha256').update(JSON.stringify(['canvas-markdown-first-birth-v1',workspaceId,entry.selection.operationId])).digest('hex'));
    };
    const causeCode=(value:unknown,expected:string):boolean=>!!value&&typeof value==='object'&&(Reflect.get(value,'code')===expected||value instanceof AggregateError&&value.errors.some(item=>causeCode(item,expected))||value instanceof Error&&causeCode(value.cause,expected));
    type Boundary={stage:string;child:import('node:child_process').ChildProcessWithoutNullStreams;ack:()=>void};
    const atBoundary=async<T>(wanted:string,action:(boundary:Boundary)=>Promise<boolean>,operation:()=>Promise<T>):Promise<T>=>{
      const childModule=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
      const baseSpawn=childModule.spawn;let hit=false;const pending:Promise<void>[]=[];const failures:unknown[]=[];
      childModule.spawn=((...args:Parameters<typeof baseSpawn>)=>{
        const child=baseSpawn(...args);
        if(Array.isArray(args[1])&&args[1].some(value=>String(value).endsWith('/markdown-create-birth.py'))){
          let buffer='',stageName='';const stream=child.stdin!;const write=stream.write.bind(stream);
          child.stdout!.on('data',chunk=>{buffer+=String(chunk);for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const parsed=JSON.parse(line);if(typeof parsed.stage==='string')stageName=parsed.stage;}});
          stream.write=((chunk:unknown,...rest:unknown[])=>{
            if(String(chunk)==='continue\n'&&stageName===wanted&&!hit){
              hit=true;let acknowledged=false;const ack=()=>{assert.equal(acknowledged,false);acknowledged=true;Reflect.apply(write,stream,[chunk,...rest]);};
              const task=action({stage:stageName,child:child as import('node:child_process').ChildProcessWithoutNullStreams,ack}).then(allow=>{if(allow){if(!acknowledged)ack();}else child.kill('SIGKILL');},error=>{failures.push(error);child.kill('SIGKILL');});pending.push(task);return true;
            }
            return Reflect.apply(write,stream,[chunk,...rest]);
          }) as typeof stream.write;
        }
        return child;
      }) as typeof baseSpawn;syncBuiltinESMExports();
      let value:T|undefined;let failed=false,primary:unknown;
      try{value=await operation();}catch(error){failed=true;primary=error;}
      finally{childModule.spawn=baseSpawn;syncBuiltinESMExports();await Promise.allSettled(pending);}
      if(!hit)failures.push(new Error('Actual helper boundary was not reached'));
      if(failed&&failures.length)throw new AggregateError([primary,...failures],'Counter and actual closure failed');
      if(failed)throw primary;if(failures.length)throw new AggregateError(failures,'Counter failed');return value as T;
    };
    await check('own early global initializer crash cannot block a later independent authenticated import',async()=>{
      const crashed=await source('initializer-crashed.md'),later=await source('initializer-independent.md'),owned=factory();
      const childModule=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
      const python=childModule.execFileSync(process.env.CANVAS_PYTHON_PATH?.trim()||'python3',['-I','-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
      assert(path.isAbsolute(python));assert(!/[\r\n]/u.test(python));
      const launcher=path.join(dataRoot,'own-initializer-crash.py');
      await fs.writeFile(launcher,'#!'+python+' -I\n'+
        'import os, re, runpy, sys\nhelper=sys.argv[-1]\noriginal=os.mkdir\n'+
        'def mkdir(name,*args,**kwargs):\n result=original(name,*args,**kwargs)\n'+
        ' if helper.endswith("/markdown-create-birth.py") and kwargs.get("dir_fd")==3 and re.fullmatch("canvas-markdown-create-births-[a-f0-9]{32}",str(name)): os._exit(81)\n return result\n'+
        'os.mkdir=mkdir\nrunpy.run_path(helper,run_name="__main__")\n',{mode:0o700,flag:'wx'});
      const previousPython=process.env.CANVAS_PYTHON_PATH;process.env.CANVAS_PYTHON_PATH=launcher;
      try{await assert.rejects(persist(crashed.original,crashed.selection,owned));}
      finally{if(previousPython===undefined)delete process.env.CANVAS_PYTHON_PATH;else process.env.CANVAS_PYTHON_PATH=previousPython;}
      await noTarget(crashed);assert.equal(await sqlCount(crashed,'collaboration_yjs_states','path'),0);
      assert.equal(await fs.lstat(path.join(dataRoot,'canvas-markdown-create-births-anchor.json')).catch(()=>null),null);
      const orphanNames=(await fs.readdir(dataRoot)).filter(name=>/^canvas-markdown-create-births-[a-f0-9]{32}$/u.test(name));assert.equal(orphanNames.length,1);
      const orphan=path.join(dataRoot,orphanNames[0]),before=await fs.stat(orphan);assert.deepEqual(await fs.readdir(orphan),[]);
      const result=await persist(later.original,later.selection,factory());assert.equal(result.projection.status,'projected');
      const pointer=JSON.parse(await fs.readFile(path.join(dataRoot,'canvas-markdown-create-births-anchor.json'),'utf8'));
      assert.equal(pointer.version,2);assert.notEqual(pointer.storeName,orphanNames[0]);
      assert.equal((await fs.stat(orphan)).ino,before.ino);assert.deepEqual(await fs.readdir(orphan),[]);
      await noTarget(crashed);await sourceStillLive(crashed);await sourceStillLive(later);
    });
    await check('real bearer and cookie create birth projects native bytes with all closures under A',async()=>{
      for (const cookie of [false,true]) {
        const entry=await source(`created-${cookie}.md`), owned=factory();
        const result=await persist(cookie?await request('owner',true):entry.original,entry.selection,owned);
        assert.equal(result.projection.status,'projected'); assert.equal(result.disposition,'applied');
        const stored=await native(result), physical=await fs.readFile(path.join(root,entry.selection.targetPath));
        const canonical=inspectPersistedNativeCollaborationSnapshot(stored,(doc,snapshot)=>snapshot.content.kind==='plain_text'?snapshot.content.text:richMarkdownFromYDoc(doc));
        assert.equal(physical.toString('utf8'),serializeCanonicalText(canonical,stored)); assert.deepEqual(physical,entry.content);
        assert.equal((await fs.stat(path.join(root,entry.selection.targetPath))).nlink,1);
        assert.equal(stored.documentSequence,0);assert.equal(stored.checkpointSequence,0);assert(stored.checkpointedAt);
        const binding=(await admin.query('SELECT * FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,entry.selection.operationId])).rows[0];
        assert.equal(binding.finalized,1);assert.equal(binding.claim_id,result.projection.claimId);assert.equal(binding.revision_id,result.projection.revisionId);
        assert.equal(binding.serialized_hash,result.projection.serializedHash);
        const projection=(await admin.query('SELECT * FROM collaboration_file_projections WHERE document_id=$1',[stored.documentId])).rows[0];
        assert.equal(projection.finalized,1);assert.equal(projection.revision_id,binding.revision_id);
        const live=await upload.getWorkspaceUploadSession(entry.scope);assert.equal(live.status,'receiving');assert.equal(live.files[0].status,'uploaded');
        assert.equal(owned.events.filter(e=>e.step==='receipt').length,1);assert.equal(owned.events.filter(e=>e.step==='close').length,3);
        const firstInode=(await fs.stat(path.join(root,entry.selection.targetPath))).ino;
        const retry=await persist(entry.original,entry.selection,factory());assert.equal(retry.disposition,'already-applied');assert.equal(retry.projection.revisionId,result.projection.revisionId);
        assert.equal((await fs.stat(path.join(root,entry.selection.targetPath))).ino,firstInode);
      }
    });
    await check('normal and leading-space Markdown imports keep distinct native births lineages and first revisions',async()=>{
      const records:Array<{entry:Entry;result:Awaited<ReturnType<typeof persist>>;state:Awaited<ReturnType<typeof native>>;
        inode:number;metadata:Record<string,unknown>}> = [];
      const readIdentity = async(entry:Entry,documentId:string) => (await admin.query(`SELECT
        d.id AS document_id,d.path AS registry_path,d.lineage_id,l.path AS lineage_path,s.path AS state_path,
        r.private_result->'target'->>'path' AS receipt_path,r.private_result->'target'->>'documentId' AS receipt_document_id,
        r.private_result->'target'->>'lineageId' AS receipt_lineage_id,b.document_id AS birth_document_id,
        b.finalized AS birth_finalized,b.revision_id AS birth_revision_id,b.claim_id,
        p.finalized AS projection_finalized,p.revision_id AS projection_revision_id,
        v.id AS revision_id,v.path AS revision_path,v.lineage_id AS revision_lineage_id
        FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
        JOIN collaboration_yjs_states s ON s.document_id=d.id
        JOIN collaboration_markdown_file_import_receipts r ON r.workspace_id=d.workspace_id AND r.operation_id=$2
        JOIN collaboration_markdown_create_births b ON b.workspace_id=r.workspace_id AND b.operation_id=r.operation_id
        JOIN collaboration_file_projections p ON p.document_id=d.id JOIN file_revisions v ON v.id=b.revision_id
        WHERE d.workspace_id=$3 AND d.id=$1`,[documentId,entry.selection.operationId,workspaceId])).rows[0] as Record<string,unknown>|undefined;
      for(const [name,content] of [['name.md',Buffer.from('# Normal birth\n\nOriginal exact name.\n')],
        [' name.md',Buffer.from('# Spaced birth\n\nDistinct leading filename.\n')]] as const){
        const entry=await source(name,'owner',content),manifest=await upload.getWorkspaceUploadSession(entry.scope);
        assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].relativePath,name);
        assert.equal(manifest.files[0].targetPath,name);assert.equal(entry.selection.targetPath,manifest.files[0].targetPath);
        const result=await persist(entry.original,entry.selection,factory());
        assert.equal(result.disposition,'applied');assert.equal(result.projection.status,'projected');
        const state=await native(result);assert.equal(state.path,name);assert.equal(result.receipt.target.path,name);
        assert.deepEqual(await fs.readFile(path.join(root,name)),content);
        const physical=await fs.stat(path.join(root,name));assert.equal(physical.nlink,1);
        const metadata=await readIdentity(entry,state.documentId);assert(metadata);
        for(const field of ['registry_path','lineage_path','state_path','receipt_path','revision_path'])assert.equal(metadata[field],name);
        for(const field of ['document_id','receipt_document_id','birth_document_id'])assert.equal(metadata[field],state.documentId);
        for(const field of ['lineage_id','receipt_lineage_id','revision_lineage_id'])assert.equal(metadata[field],result.receipt.target.lineageId);
        for(const field of ['birth_revision_id','projection_revision_id','revision_id'])assert.equal(metadata[field],result.projection.revisionId);
        assert.equal(metadata.birth_finalized,1);assert.equal(metadata.projection_finalized,1);assert.equal(metadata.claim_id,result.projection.claimId);
        records.push({entry,result,state,inode:physical.ino,metadata});
      }
      assert.equal(new Set(records.map(record=>record.state.documentId)).size,2);
      assert.equal(new Set(records.map(record=>record.result.receipt.target.lineageId)).size,2);
      assert.equal(new Set(records.map(record=>record.result.projection.revisionId)).size,2);
      assert.equal(new Set(records.map(record=>record.inode)).size,2);
      for(const record of records){
        const retry=await persist(record.entry.original,record.entry.selection,factory());
        assert.equal(retry.disposition,'already-applied');assert.equal(retry.projection.status,'projected');
        assert.deepEqual(retry.receipt,record.result.receipt);assert.deepEqual(retry.projection,record.result.projection);
        assert.deepEqual(await native(retry),record.state);assert.deepEqual(await readIdentity(record.entry,record.state.documentId),record.metadata);
        assert.equal((await fs.stat(path.join(root,record.entry.selection.targetPath))).ino,record.inode);
        assert.deepEqual(await fs.readFile(path.join(root,record.entry.selection.targetPath)),record.entry.content);
      }
      const paths=['name.md',' name.md'];
      for(const table of ['collaboration_documents','collaboration_yjs_states','file_collaboration_lineages','file_revisions']){
        assert.equal(Number((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1 AND path=ANY($2::text[])`,[workspaceId,paths])).rows[0].n),2);
      }
    });
    await check('nested new parents and empty canonical native source have durable own birth',async()=>{
      for(const [name,content]of [['new/nested/file.md',Buffer.from('Nested native')],['empty-canonical.md',Buffer.from('\uFEFF')]] as const){
        const entry=await source(name,'owner',content),result=await persist(entry.original,entry.selection,factory());
        assert.equal(result.projection.status,'projected');assert.deepEqual(await fs.readFile(path.join(root,name)),content);
        assert.equal((await fs.stat(path.join(root,name))).nlink,1);await sourceStillLive(entry);
      }
    });
    await check('actual preparation child closes before parent target publication',async()=>{
      const entry=await source('actual-child-close.md');let preparationClosed=false;
      const result=await atBoundary('before_link',async({child,ack})=>{
        await noTarget(entry);
        const closure=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
        ack();const ended=await closure;assert.equal(ended.code,0);assert.equal(ended.signal,null);preparationClosed=true;
        // The child's actual close precedes the awaited fresh Parent checks.
        await noTarget(entry);return true;
      },()=>persist(entry.original,entry.selection,factory()));
      assert.equal(preparationClosed,true);assert.equal(result.projection.status,'projected');
      assert.equal((await fs.stat(path.join(root,entry.selection.targetPath))).mode & 0o7777,0o644);
      assert.equal(await fs.lstat(path.join(await claimPath(entry),'content.tmp')).catch(()=>null),null);await sourceStillLive(entry);
    });
    await check('missing FD backend rejects project before native DML and import-only still works',async()=>{
      const entry=await source('backend-unavailable.md'),owned=factory(),imported=await source('backend-import-only.md');
      const unavailableRoot=path.join(dataRoot,'unavailable-fd-app');await fs.mkdir(unavailableRoot,{mode:0o700});
      await fs.symlink(path.join(process.cwd(),'scripts'),path.join(unavailableRoot,'scripts'),'dir');
      const appRoot=process.env.CANVAS_APP_ROOT;process.env.CANVAS_APP_ROOT=unavailableRoot;
      try{
        await assert.rejects(persist(entry.original,entry.selection,owned),error=>causeCode(error,'ENOENT'));
        assert.equal(owned.events.some(event=>['native','birth','receipt','registry','lineage'].includes(event.step)),false);
        assert.equal(await sqlCount(entry,'collaboration_yjs_states','path'),0);assert.equal(await sqlCount(entry,'collaboration_markdown_create_births'),0);await noTarget(entry);
        const isolated=factory(),result=await importOnly(imported.original,imported.selection,isolated);
        assert.equal(result.disposition,'applied');assert.equal(isolated.events.filter(event=>event.step==='native').length,1);
        assert.equal(await sqlCount(imported,'collaboration_markdown_create_births'),0);await noTarget(imported);
      }finally{if(appRoot===undefined)delete process.env.CANVAS_APP_ROOT;else process.env.CANVAS_APP_ROOT=appRoot;}
      await sourceStillLive(entry);await sourceStillLive(imported);
    });
    await check('parent final rejects an upload directory detached during its own synchronous read',async()=>{
      const entry=await source('parent-source-namespace.md');
      const syncModule=createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
      const readSync=syncModule.readSync,manifestInode=(await fs.stat(entry.manifest,{bigint:true})).ino;
      const uploads=path.join(dataRoot,'.uploads'),retained=path.join(dataRoot,'owned-detached-uploads-'+crypto.randomUUID());let detached=false;
      syncModule.readSync=((...args:Parameters<typeof readSync>)=>{
        const count=Reflect.apply(readSync,syncModule,args) as number;
        if(!detached&&count===0&&syncModule.fstatSync(args[0],{bigint:true}).ino===manifestInode){
          detached=true;syncModule.renameSync(uploads,retained);syncModule.mkdirSync(uploads,{mode:0o700});
        }
        return count;
      }) as typeof readSync;syncBuiltinESMExports();
      try{
        await assert.rejects(persist(entry.original,entry.selection,factory()),error=>causeCode(error,'MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED'));
        assert.equal(detached,true);await noTarget(entry);
        assert.equal(await sqlCount(entry,'collaboration_yjs_states','path'),1);
        assert.equal((await admin.query('SELECT finalized FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,entry.selection.operationId])).rows[0].finalized,0);
      }finally{
        syncModule.readSync=readSync;syncBuiltinESMExports();
        if(detached){syncModule.rmdirSync(uploads);syncModule.renameSync(retained,uploads);}
      }
      await sourceStillLive(entry);
      const retry=await persist(entry.original,entry.selection,factory());assert.equal(retry.disposition,'already-applied');assert.equal(retry.projection.status,'projected');
    });
    await check('foreign existing empty and equal-byte inodes never acquire birth or native state',async()=>{
      for(const content of [Buffer.alloc(0),Buffer.from('Foreign bytes')]){
        const entry=await source(`foreign-${content.byteLength}.md`,'owner',content.byteLength?content:Buffer.from('Owned native source'));await fs.writeFile(path.join(root,entry.selection.targetPath),content);
        const before=await fs.stat(path.join(root,entry.selection.targetPath));await assert.rejects(persist(entry.original,entry.selection,factory()));
        assert.equal(await sqlCount(entry,'collaboration_yjs_states','path'),0);assert.equal(await sqlCount(entry,'collaboration_markdown_create_births'),0);
        assert.equal((await fs.stat(path.join(root,entry.selection.targetPath))).ino,before.ino);assert.deepEqual(await fs.readFile(path.join(root,entry.selection.targetPath)),content);await sourceStillLive(entry);
      }
    });
    await check('native lost COMMIT proves same immutable birth on fresh C before publication without replay',async()=>{
      const entry=await source('native-lost.md'),owned=factory({commit:'after'}),result=await persist(entry.original,entry.selection,owned);
      assert.equal(result.disposition,'commit-recovered');assert.equal(result.projection.status,'projected');assert.equal(owned.events.filter(e=>e.step==='native').length,1);
      assert.equal(owned.events.filter(e=>e.step==='birth').length,1);const disposed=owned.events.findIndex(e=>e.ordinal===2&&e.step==='disposed'),fresh=owned.events.findIndex(e=>e.ordinal===3&&e.step==='open');assert(disposed>=0&&fresh>disposed);
      assert.equal(await sqlCount(entry,'collaboration_markdown_create_births'),1);assert.equal(await sqlCount(entry,'collaboration_markdown_file_import_receipts'),1);
      const rejected=await source('native-rejected.md'),bad=factory({commit:'before'});await assert.rejects(persist(rejected.original,rejected.selection,bad));
      assert.equal(await sqlCount(rejected,'collaboration_yjs_states','path'),0);assert.equal(await sqlCount(rejected,'collaboration_markdown_create_births'),0);await noTarget(rejected);
    });
    await check('actual helper kill before attribution never adopts temp and known prepared or linked inode resumes',async()=>{
      for(const point of ['temp_synced','prepared_durable','target_linked','born_durable']){
        const entry=await source(`crash-${point}.md`),owned=factory();
        await assert.rejects(atBoundary(point,async()=>false,()=>persist(entry.original,entry.selection,owned)));
        assert.equal(await sqlCount(entry,'collaboration_yjs_states','path'),1);assert.equal(await sqlCount(entry,'collaboration_markdown_create_births'),1);
        const document=(await admin.query('SELECT document_id FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,entry.selection.operationId])).rows[0].document_id;
        const state=await loadCollaborationStateOnConnection(direct,document);assert(state);
        const {materializeCollaborationCheckpoint}=await import('../app/lib/collaboration/checkpoint');
        const {loadCollaborationProjectionWorkspace}=await import('../app/lib/collaboration/projection-repository');const workspace=await loadCollaborationProjectionWorkspace(state);assert(workspace);
        await assert.rejects(materializeCollaborationCheckpoint({state,workspace}),error=>causeCode(error,'MARKDOWN_IMPORT_LIFECYCLE_REQUIRED'));
        assert.equal((await admin.query('SELECT degraded FROM collaboration_yjs_states WHERE document_id=$1',[document])).rows[0].degraded,0);
        if(point==='prepared_durable'){
          await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1',[document]);
          try{const advanced=await loadCollaborationStateOnConnection(direct,document);assert(advanced);await assert.rejects(materializeCollaborationCheckpoint({state:advanced,workspace}),error=>causeCode(error,'MARKDOWN_IMPORT_LIFECYCLE_REQUIRED'));await noTarget(entry);}
          finally{await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=1 WHERE document_id=$1',[document]);}
        }
        if(point==='temp_synced'){
          const temp=await fs.stat(path.join(await claimPath(entry),'content.tmp'));await assert.rejects(persist(entry.original,entry.selection,factory()));
          assert.equal((await fs.stat(path.join(await claimPath(entry),'content.tmp'))).ino,temp.ino);await noTarget(entry);
        }else{
          const before=await fs.lstat(path.join(root,entry.selection.targetPath)).catch(()=>null);const retry=factory(),result=await persist(entry.original,entry.selection,retry);
          assert.equal(result.disposition,'already-applied');assert.equal(result.projection.status,'projected');assert.equal(retry.events.filter(e=>['native','birth','receipt'].includes(e.step)).length,0);
          if(before)assert.equal((await fs.stat(path.join(root,entry.selection.targetPath))).ino,before.ino);assert.deepEqual(await fs.readFile(path.join(root,entry.selection.targetPath)),entry.content);
        }
        await sourceStillLive(entry);
      }
    });
    await check('equal bytes in a peer inode after link and parent ABA remain foreign',async()=>{
      const entry=await source('peer-after-link.md');let peerInode=0;
      await assert.rejects(atBoundary('target_linked',async()=>{const filename=path.join(root,entry.selection.targetPath);await fs.unlink(filename);await fs.writeFile(filename,entry.content);peerInode=(await fs.stat(filename)).ino;return true;},()=>persist(entry.original,entry.selection,factory())));
      assert.equal((await fs.stat(path.join(root,entry.selection.targetPath))).ino,peerInode);assert.deepEqual(await fs.readFile(path.join(root,entry.selection.targetPath)),entry.content);
      await assert.rejects(persist(entry.original,entry.selection,factory()));assert.equal((await fs.stat(path.join(root,entry.selection.targetPath))).ino,peerInode);
      await fs.mkdir(path.join(root,'aba'));const alias=await source('aba/file.md');
      await assert.rejects(atBoundary('before_link',async()=>{await fs.rename(path.join(root,'aba'),path.join(root,'aba-old'));await fs.mkdir(path.join(root,'aba'));return true;},()=>persist(alias.original,alias.selection,factory())));
      await noTarget(alias);assert.equal(await fs.lstat(path.join(root,'aba-old/file.md')).catch(()=>null),null);
    });
    await check('original token root and source TTL drift before publication cannot publish',async()=>{
      const token=await source('token-revoked.md'),tokenFactory=factory({beforePhase:async ordinal=>{if(ordinal===3)await admin.query('UPDATE "session" SET expires_at=$1 WHERE id=$2',[Date.now()-1,'session-owner']);}});
      await assert.rejects(persist(token.original,token.selection,tokenFactory));await noTarget(token);await seedSession();
      const drift=await source('root-drift.md'),rootFactory=factory({beforePhase:async ordinal=>{if(ordinal===3)await admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2',['organizations/principal-org/other',workspaceId]);}});
      try{await assert.rejects(persist(drift.original,drift.selection,rootFactory));await noTarget(drift);}finally{await admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2',['organizations/principal-org/shared',workspaceId]);}
      const expired=await source('source-expired.md');await assert.rejects(atBoundary('before_link',async()=>{const manifest=JSON.parse(await fs.readFile(expired.manifest,'utf8'));manifest.expiresAt=new Date(Date.now()-1).toISOString();await fs.writeFile(expired.manifest,JSON.stringify(manifest));return true;},()=>persist(expired.original,expired.selection,factory())));await noTarget(expired);
    });
    await check('actual publication D holds Auth while native metadata and path probes plus real auxiliary closes succeed',async()=>{
      const {setFileCollaborationConnectionFactoryForTests}=await import('../app/lib/files/collaboration-repository/transaction');
      const entry=await source('aux-locks.md'),active=new Set<SqlConnection>();let tested=false;const owned=factory({beforeClose:async ordinal=>{if(ordinal===3)assert.equal(active.size,0,'all actual projector auxiliary leases closed before D close');}});
      setFileCollaborationConnectionFactoryForTests(async()=>{
        const actual=await actualOpenDb();active.add(actual);
        if(!tested){
          tested=true;const probe=await ownClient();await probe.query('BEGIN');
          try{
            const current=(await probe.query('SELECT document_id FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,entry.selection.operationId])).rows[0].document_id;
            await probe.query('SELECT document_id FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE NOWAIT',[current]);
            await probe.query('SELECT id FROM collaboration_documents WHERE id=$1 FOR UPDATE NOWAIT',[current]);
            await probe.query('SELECT id FROM file_collaboration_lineages WHERE workspace_id=$1 AND path=$2 FOR UPDATE NOWAIT',[workspaceId,entry.selection.targetPath]);
            assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS held',[workspaceId,entry.selection.targetPath])).rows[0].held,true);
            await assert.rejects(probe.query('SELECT organization_id FROM canvas_organization_settings FOR UPDATE NOWAIT'),error=>causeCode(error,'55P03'));
          }finally{await probe.query('ROLLBACK');await probe.end();clients.delete(probe);}
        }
        return {...actual,close:async error=>{try{await actual.close(error);}finally{active.delete(actual);}}};
      });
      try{const result=await persist(entry.original,entry.selection,owned);assert.equal(result.projection.status,'projected');assert.equal(tested,true);assert.equal(active.size,0);}finally{setFileCollaborationConnectionFactoryForTests(null);}
    });
    await check('real auxiliary close failure leaves native birth pending and never reports publication success',async()=>{
      const {setFileCollaborationConnectionFactoryForTests}=await import('../app/lib/files/collaboration-repository/transaction');
      const entry=await source('aux-close.md');let hit=false;const active=new Set<SqlConnection>();
      setFileCollaborationConnectionFactoryForTests(async()=>{
        const actual=await actualOpenDb();active.add(actual);
        return {...actual,close:async error=>{try{await actual.close(error);}finally{active.delete(actual);}if(!hit){hit=true;throw new Error('Actual auxiliary released before reported close failure');}}};
      });
      try{await assert.rejects(persist(entry.original,entry.selection,factory()));assert.equal(hit,true);assert.equal(active.size,0);
        assert.equal((await admin.query('SELECT finalized FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,entry.selection.operationId])).rows[0].finalized,0);
      }finally{setFileCollaborationConnectionFactoryForTests(null);}
      const before=(await fs.stat(path.join(root,entry.selection.targetPath))).ino;const recovered=await persist(entry.original,entry.selection,factory());
      assert.equal(recovered.projection.status,'projected');assert.equal(recovered.disposition,'already-applied');assert.equal((await fs.stat(path.join(root,entry.selection.targetPath))).ino,before);
    });
    await check('publication final after receipt DML and D COMMIT or close faults never falsely succeed',async()=>{
      const final=await source('final-auth.md'),finalFactory=factory({afterFinalize:async database=>{await database.run('UPDATE "session" SET expires_at=$1 WHERE id=$2',[Date.now()-1,'session-owner']);}});
      await assert.rejects(persist(final.original,final.selection,finalFactory));assert.equal((await admin.query('SELECT finalized FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,final.selection.operationId])).rows[0].finalized,0);await seedSession();
      const lost=await source('publication-lost.md'),lostFactory=factory({commit:'after',commitOrdinal:3}),recovered=await persist(lost.original,lost.selection,lostFactory);
      assert.equal(recovered.projection.status,'projected');const discarded=lostFactory.events.findIndex(e=>e.ordinal===3&&e.step==='disposed'),fresh=lostFactory.events.findIndex(e=>e.ordinal===4&&e.step==='open');assert(discarded>=0&&fresh>discarded);
      for(const ordinal of [1,3]){
        const entry=await source(`close-undefined-${ordinal}.md`),owned=factory({undefinedClose:ordinal});let rejected=false;
        try{await persist(entry.original,entry.selection,owned);}catch{rejected=true;}assert.equal(rejected,true);assert(owned.events.some(e=>e.ordinal===ordinal&&e.step==='undefined-close-fault'));
        const result=await persist(entry.original,entry.selection,factory());assert.equal(result.disposition,'already-applied');assert.equal(result.projection.status,'projected');
      }
      const expired=await source('publication-D-expired.md'),expiredFactory=factory();
      const evidenceRoot=await mkdtemp(path.join(tmpdir(),'canvas-first-projection-D-counter-'));
      const evidence:Record<string,unknown>={version:1,nodePid:process.pid,case:'actual D timeout and session revocation after before_link ACK',evidenceRoot};
      let reached=false,rejected=false;
      try{await atBoundary('before_link',async({child,ack})=>{
        const publication=expiredFactory.events.find(event=>event.ordinal===3&&event.step==='open');assert(publication);assert(child.pid);
        assert.equal(child.kill('SIGSTOP'),true);
        const childModule=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
        let stopped=false;for(let poll=0;poll<50;poll++){const status=childModule.execFileSync('ps',['-p',String(child.pid),'-o','stat='],{encoding:'utf8'}).trim();if(status.startsWith('T')){stopped=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(stopped,true);
        ack();evidence.childPid=child.pid;evidence.publicationPid=publication.pid;evidence.ackIssuedWhileActualChildStopped=true;
        let ended=false;for(let poll=0;poll<120;poll++){const count=Number((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()',[publication.pid])).rows[0].n);if(count===0){ended=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(ended,true,'real five-second Publication D must have ended before revocation');evidence.publicationBackendAbsent=true;
        const revoked=await admin.query('UPDATE "session" SET expires_at=$1 WHERE id=$2',[Date.now()-1,'session-owner']);assert.equal(revoked.rowCount,1);evidence.actualSessionRevoked=true;
        reached=true;assert.equal(child.kill('SIGCONT'),true);return true;
      },()=>persist(expired.original,expired.selection,expiredFactory));}catch{rejected=true;}
      assert.equal(reached,true);assert.equal(rejected,true);
      const target=await fs.lstat(path.join(root,expired.selection.targetPath)).catch(()=>null);
      evidence.targetPublished=target!==null;evidence.apiRejected=rejected;evidence.events=expiredFactory.events.map(({ordinal,pid,step,discard})=>({ordinal,pid,step,discard}));
      evidence.finalized=(await admin.query('SELECT finalized FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,expired.selection.operationId])).rows[0]?.finalized;
      await fs.writeFile(path.join(evidenceRoot,'result.json'),JSON.stringify(evidence,null,2),{mode:0o600});console.log('Actual D timeout counter evidence',path.join(evidenceRoot,'result.json'));
      assert.equal(target,null,'a child resumed after actual D end and genuine revocation must not publish a target');await seedSession();
    });
    if(!process.env.CANVAS_FIRST_PROJECTION_CASE)assert.equal(cases,15);
    assert.equal(fetches,0);console.log(`Authenticated First Projection PG18: ${cases} genuine Auth/SQL/FS matrix families; no route, upload completion or host activation.`);
  } finally {
    globalThis.fetch=originalFetch;
    try {if(pool)await pool.end();}
    finally {try{for(const client of clients)await client.end();}
      finally {try{if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);}}
        finally{await control.end();await rm(dataRoot,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}}}
  }
}
main().catch(error=>{const trace=(value:unknown):unknown=>({name:value instanceof Error?value.name:typeof value,code:value&&typeof value==='object'?Reflect.get(value,'code')??null:null,children:value instanceof AggregateError?value.errors.map(trace):[],cause:value instanceof Error&&value.cause!==undefined?trace(value.cause):null}); console.error('First projection failure classification',JSON.stringify(trace(error)));console.error('Owned authenticated staging fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  frames:error instanceof Error?error.stack?.split('\n').slice(1).filter(line=>line.includes('/app/lib/')||line.includes('/scripts/')):undefined});process.exitCode=1;});
