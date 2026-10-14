import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client,types } from 'pg';
import { NextRequest } from 'next/server';
import { spawn, execFileSync } from 'node:child_process';
import { serializeSignedCookie } from 'better-call';
import fs from 'node:fs/promises';
import { signalOwnChild, ownedGroupEmpty } from './run-yjs-authority-e2e';
import { waitForFileCreateBudget } from '../tests/helpers/create-request-budget';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  const selected=process.env.CANVAS_MANUAL_CREATE_TEST_CASES?.split(',');
  const selectable=['scope','raw','observer-close','effects-close','gatefalse'];
  if(selected)assert(selected.length>0&&new Set(selected).size===selected.length&&selected.every(value=>selectable.includes(value)),'Use only exact pending-family selectors.');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost','127.0.0.1'].includes(url.hostname));
  assert.equal(url.port,'55433'); assert.equal(url.pathname,'/canvas_notebook'); assert.equal(url.search,'');
  const schema = `authenticated_manual_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^authenticated_manual_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-authenticated-manual-'));
  console.log('Manual Create own fixture', {nodePid:process.pid,schema,dataRoot});
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const originalQuery = Client.prototype.query;
  const childModule=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'),originalSpawn=childModule.spawn;
  const runtimePids=new Set<number>();
  const awaitBackendsGone=async(pids:readonly number[])=>{
    assert(pids.every(pid=>Number.isSafeInteger(pid)&&pid>0));const deadline=performance.now()+5000;
    for(;;){const rows=(await control.query('SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::int[])',[pids])).rows;
      if(!rows.length)return;
      if(performance.now()>=deadline)assert.equal(rows.length,0,'Own PostgreSQL backend closure was not confirmed within five seconds.');
      await new Promise(resolve=>setTimeout(resolve,25));}
  };
  type GuardedChild=Parameters<typeof signalOwnChild>[0];
  const ownedChildren:Array<{entry:GuardedChild;applicationName:string;closed:Promise<void>;stop:(error:unknown)=>Promise<void>}>=[];
  const awaitGroupGone=async(entry:GuardedChild)=>{
    const deadline=performance.now()+5000;
    for(;;){if(ownedGroupEmpty(entry))return;
      if(performance.now()>=deadline)assert(ownedGroupEmpty(entry),'Own detached Create child group did not close within five seconds.');
      await new Promise(resolve=>setTimeout(resolve,25));}
  };
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
      FILE_VERSION_CENTER_MODE:'full',
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
    runtime.on('acquire',client=>runtimePids.add(Number(Reflect.get(client,'processID'))));
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!,process.env.CANVAS_INSTANCE_ID!)).ok,true);
    const license = await getLicenseStatus(); assert.equal(license.licensed,true); assert.equal(license.edition,'team'); assert.equal(license.seatLimit,2);
    const web = await import('../app/api/files/create/route');
    const mobile = await import('../app/api/mobile/v1/files/create/route');
    const persistence = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const birth = await import('../app/lib/files/markdown-create-birth');
    const { fileVersionHistoryService } = await import('../app/lib/file-version-center/history-service');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { authoritativeCollaborationSnapshot } = await import('../app/lib/collaboration/checkpoint');
    const { loadCollaborationState } = await import('../app/lib/collaboration/persistence');
    const root = path.join(dataRoot,'organizations/principal-org/shared'); await mkdir(root,{recursive:true});
    const request = async (body:object, actor='owner', useMobile=false) => {
      const headers = new Headers({'x-canvas-workspace-id':workspaceId,'content-type':'application/json'});
      if(useMobile)headers.set('authorization',`Bearer ${tokens[actor]}`);
      else headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[actor],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      return new NextRequest(`http://localhost${useMobile?'/api/mobile/v1/files/create':'/api/files/create'}`,{method:'POST',headers,body:JSON.stringify(body)});
    };
    let parentPosts=0;
    const post=async(body:object,actor='owner',useMobile=false)=>{
      const before=Date.now();await waitForFileCreateBudget();parentPosts++;
      if(Date.now()-before>100)console.log('Honored real Create request budget',{stage,parentPosts,waitedMs:Date.now()-before});
      return(useMobile?mobile:web).POST(await request(body,actor,useMobile));
    };
    const create = async(filePath:string,requestId:string|undefined=crypto.randomUUID(),useMobile=false,extra:Record<string,unknown>={},actor='owner')=>{
      const response=await post({path:filePath,type:'file',...(requestId===undefined?{}:{requestId}),...extra},actor,useMobile);
      const json=await response.json();
      if(json.completion)assert.deepEqual(Object.keys(json.completion).sort(),(json.completion.status==='completed'?['status','requestId','workspaceId','targetPath']:['status','requestId','workspaceId','targetPath','code']).sort());
      return{response,json};
    };
    type ChildResult={status:number;body:{success:boolean;code?:string;completion?:{status:string;requestId:string;workspaceId:string;targetPath:string;code?:string}};backends:number[]};
    const startChild=async(filePath:string,requestId:string)=>{
      const nonce=crypto.randomUUID().replaceAll('-',''),applicationName=`manual-create-child-${nonce}`;
      const descriptor=path.join(dataRoot,`own-create-child-${nonce}.json`),childRequest=await request({path:filePath,type:'file',requestId});
      await fs.writeFile(descriptor,JSON.stringify({url:childRequest.url,headers:Object.fromEntries(childRequest.headers),body:await childRequest.text()}),{mode:0o600});
      const child=spawn(process.execPath,['--conditions=react-server','--import','tsx','scripts/manual-markdown-create-process-child.ts'],{
        cwd:process.cwd(),env:{...process.env,PGOPTIONS:`${process.env.PGOPTIONS} -c application_name=${applicationName}`,CANVAS_MANUAL_CREATE_CHILD:descriptor},
        detached:true,stdio:['ignore','pipe','pipe','ipc']});
      const group=child.pid;assert(Number.isSafeInteger(group)&&group! > 0);
      let output='',failure:unknown,closed=false,started=false,readyResolve!:()=>void,readyReject!:(error:unknown)=>void,closedResolve!:()=>void;
      const closedPromise=new Promise<void>(resolve=>{closedResolve=resolve;});
      const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      void ready.catch(()=>undefined);
      let deadlineReject!:(error:unknown)=>void;
      const deadline=new Promise<never>((_,reject)=>{deadlineReject=reject;});
      void deadline.catch(()=>undefined);
      const entry:GuardedChild={process:child,pid:group!,started:'',cwd:process.cwd(),ended:false,closed:closedPromise,logPath:descriptor+'.log'};
      const stop=async(error:unknown)=>{failure??=error;await signalOwnChild(entry,'SIGKILL');};
      const owner={entry,applicationName,closed:closedPromise,stop};ownedChildren.push(owner);
      // The timer owns this exact detached group, never a shared process. Close
      // includes stdout/stderr drain; group/DB barriers precede fixture cleanup.
      const rejectDeadline=(error:unknown)=>{failure??=error;readyReject(error);deadlineReject(error);void stop(error).catch(closeError=>{failure??=closeError;});};
      const timer=setTimeout(()=>rejectDeadline(new Error('Own manual Create child exceeded its 120s wall budget.')),120000);
      child.stdout!.on('data',chunk=>{output+=String(chunk);if(output.length>65536)rejectDeadline(new Error('Own manual Create child output exceeded its finite limit.'));});
      child.stderr!.resume();
      child.once('error',error=>{failure??=error;readyReject(error);});
      child.on('message',message=>{if(message==='manual_create_ready')readyResolve();});
      const actualResult=new Promise<ChildResult>((resolve,reject)=>child.once('close',(code,signal)=>{
        closed=true;entry.ended=true;clearTimeout(timer);closedResolve();
        try{if(failure)throw failure;assert.equal(code,0,`Own Create child failed (${signal??'no signal'}).`);
          const lines=output.split('\n').filter(line=>line.startsWith('MANUAL_CHILD_RESULT '));assert.equal(lines.length,1);
          const value=JSON.parse(lines[0].slice('MANUAL_CHILD_RESULT '.length)) as ChildResult;
          assert([200,409].includes(value.status));assert(Array.isArray(value.backends));assert.equal(typeof value.body.success,'boolean');
          if(value.body.completion){assert.equal(value.body.completion.requestId,requestId);assert.equal(value.body.completion.workspaceId,workspaceId);assert.equal(value.body.completion.targetPath,filePath);}
          resolve(value);
        }catch(error){readyReject(error);reject(error);}
      }));
      const result=Promise.race([actualResult,deadline]);
      void result.catch(()=>undefined);
      for(let attempt=0;attempt<40&&!closed;attempt++){try{entry.started=execFileSync('ps',['-p',String(entry.pid),'-o','lstart='],{encoding:'utf8'}).trim();if(entry.started)break;}catch{/* Bounded actual-child start observation. */}await new Promise(resolve=>setTimeout(resolve,25));}
      assert(entry.started||closed,'Own child start identity was not observed.');
      return{owner,ready,result,begin:()=>{assert(!started);assert(!closed);started=true;child.send!('manual_create_go');}};
    };
    const confirmChildGone=async(owner:typeof ownedChildren[number],pids:readonly number[]=[])=>{
      let closeTimer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([owner.closed,new Promise<never>((_,reject)=>{closeTimer=setTimeout(()=>reject(new Error('Own child close/drain remained unconfirmed.')),5000);})]);}
      finally{if(closeTimer)clearTimeout(closeTimer);}
      await awaitGroupGone(owner.entry);
      const named=(await control.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[owner.applicationName])).rows.map(row=>Number(row.pid));
      await awaitBackendsGone([...new Set([...pids,...named])]);
      assert.equal((await control.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1',[owner.applicationName])).rows[0].n,0);
    };
    const runChild=async(filePath:string,requestId:string)=>{
      const child=await startChild(filePath,requestId);
      try{await child.ready;child.begin();const result=await child.result;await confirmChildGone(child.owner,result.backends);return result;}
      catch(error){await child.owner.stop(error);await Promise.allSettled([child.result]);await confirmChildGone(child.owner);throw error;}
    };
    const runPair=async(filePath:string,requestIds:readonly[string,string])=>{
      const children=await Promise.all(requestIds.map(requestId=>startChild(filePath,requestId)));
      try{
        await Promise.all(children.map(child=>child.ready));for(const child of children)child.begin();
        const results=await Promise.allSettled(children.map(child=>child.result));
        for(let index=0;index<results.length;index++){const result=results[index];await confirmChildGone(children[index].owner,result.status==='fulfilled'?result.value.backends:[]);}
        const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
        return results.map(result=>{assert.equal(result.status,'fulfilled');return(result as PromiseFulfilledResult<ChildResult>).value;});
      }catch(error){await Promise.allSettled(children.map(child=>child.owner.stop(error)));await Promise.allSettled(children.map(child=>child.result));for(const child of children)await confirmChildGone(child.owner);throw error;}
    };
    const count=async(table:string,filePath:string)=>{
      assert(['collaboration_documents','file_revisions','audit_events'].includes(table));
      return Number((await admin.query(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=$1 AND ${table==='audit_events'?'entity_id':'path'}=$2`,[workspaceId,filePath])).rows[0].n);
    };
    const exists=async(filePath:string)=>fs.lstat(path.join(root,filePath)).catch(()=>null);
    const check=async(name:string,run:()=>Promise<void>,id?:string)=>{
      if(selected&&(!id||!selected.includes(id)))return;
      stage=name;await run();cases++;console.log(`PASS ${cases}: ${name}`);
    };
    // One observer makes several receipt reads. Count only a confirmed COMMIT
    // of the actual BEGIN transaction containing this exact operation lookup.
    const receiptObservers=(operationId:string)=>{
      const transactions=new WeakMap<Client,{matched:boolean}>();let completed=0,queries=0;
      return{
        before(client:Client,sql:string,values:unknown){
          if(/^BEGIN\b/iu.test(sql.trim()))transactions.set(client,{matched:false});
          const transaction=transactions.get(client);
          if(transaction&&sql.includes('SELECT * FROM collaboration_markdown_file_import_receipts')&&Array.isArray(values)&&values.includes(operationId)){transaction.matched=true;queries++;}
        },
        after(client:Client,sql:string){
          if(/^COMMIT\b/iu.test(sql.trim())){const own=transactions.get(client);transactions.delete(client);if(own?.matched)return++completed;}
          if(/^ROLLBACK\b/iu.test(sql.trim()))transactions.delete(client);
          return undefined;
        },
        active:(client:Client)=>transactions.has(client),count:()=>completed,queries:()=>queries,
      };
    };
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='0';
    await check('missing/invalid UUID, false gate and contradictory template never create',async()=>{
      const missing=await post({path:'missing.md',type:'file'});assert.equal(missing.status,400);
      assert.equal((await create('invalid.md','not-a-uuid')).response.status,400);
      for(const useMobile of[false,true]){const filePath=`gate-${useMobile}.md`,value=await create(filePath,crypto.randomUUID(),useMobile);
        assert.equal(value.response.status,409,JSON.stringify(value.json));assert.equal(value.json.success,false);assert.equal(value.json.completion.status,'unavailable');assert.equal(await exists(filePath),null);assert.equal(await count('collaboration_documents',filePath),0);}
      assert.equal((await create('drawing-bypass.md',crypto.randomUUID(),false,{template:'excalidraw'})).response.status,400);
      assert.equal(await exists('drawing-bypass.md'),null);
    });
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='1';
    await check('real Web Cookie and reexported Mobile Bearer direct200, Empty native and Initialhistory',async()=>{
      for(const useMobile of[false,true]){
        const filePath=`native-empty-${useMobile}.markdown`,requestId=crypto.randomUUID(),value=await create(filePath,requestId,useMobile);
        assert.equal(value.response.status,200,JSON.stringify(value.json));assert.deepEqual(value.json,{success:true,completion:{status:'completed',requestId,workspaceId,targetPath:filePath}});
        assert.deepEqual(await fs.readFile(path.join(root,filePath)),Buffer.alloc(0));assert.equal((await exists(filePath))!.mode&0o777,0o644);
        const document=(await admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',[workspaceId,filePath])).rows[0];
        const state=await loadCollaborationState(document.id);assert(state);assert.equal(state.representation,'tiptap_blocks');assert.equal(state.schemaVersion,1);assert.equal(state.documentSequence,0);assert.equal(state.newlineStyle,'lf');assert.equal(state.hasBom,false);
        const snapshot=authoritativeNativeCollaborationSnapshot(state);assert.equal(snapshot.content.kind,'rich_text');assert.equal(authoritativeCollaborationSnapshot(state).canonicalContent,'');assert.equal(await count('file_revisions',filePath),1);
        assert.equal(Number((await admin.query("SELECT count(*) AS n FROM file_revision_contents WHERE workspace_id=$1 AND revision_id IN (SELECT id FROM file_revisions WHERE workspace_id=$1 AND path=$2) AND source='initial'",[workspaceId,filePath])).rows[0].n),1);
        const retry=await create(filePath,requestId,useMobile);assert.equal(retry.response.status,200,JSON.stringify(retry.json));assert.deepEqual(retry.json.completion,value.json.completion);assert.equal(await count('collaboration_documents',filePath),1);assert.equal(await count('file_revisions',filePath),1);
      }
    });
    await check('known new target collision is PATH_EXISTS, old own target replacement remains Recovery',async()=>{
      const foreign=Buffer.from('Own synthetic existing target');await fs.writeFile(path.join(root,'collision.md'),foreign);
      const collision=await create('collision.md');assert.equal(collision.response.status,409);assert.equal(collision.json.code,'PATH_EXISTS');assert(!collision.json.completion);assert.deepEqual(await fs.readFile(path.join(root,'collision.md')),foreign);assert.equal(await count('collaboration_documents','collision.md'),0);
      const requestId=crypto.randomUUID();assert.equal((await create('same-bytes.md',requestId)).response.status,200);
      await fs.rename(path.join(root,'same-bytes.md'),path.join(root,'same-bytes.retained'));await fs.writeFile(path.join(root,'same-bytes.md'),'');
      const replaced=await create('same-bytes.md',requestId);assert.equal(replaced.response.status,409);assert.equal(replaced.json.completion.status,'recovery_required');assert.equal(await count('collaboration_documents','same-bytes.md'),1);
    });
    await check('request path, authenticated session and member conflicts never adopt original birth',async()=>{
      const requestId=crypto.randomUUID();assert.equal((await create('bound.md',requestId)).response.status,200);
      const changed=await create('changed.md',requestId);assert.equal(changed.response.status,409);assert.equal(await exists('changed.md'),null);
      const denied=await create('denied.md',crypto.randomUUID(),true,{},'member');assert.equal(denied.response.status,403);assert.equal(await exists('denied.md'),null);
      await admin.query('UPDATE "session" SET id=$1 WHERE id=$2',['session-owner-next','session-owner']);
      try{const other=await create('bound.md',requestId);assert.equal(other.response.status,409);assert.equal(other.json.completion.status,'recovery_required');}
      finally{await admin.query('UPDATE "session" SET id=$1 WHERE id=$2',['session-owner','session-owner-next']);}
    });
    await check('B native commit and actual killed preparation helper keep pending; same request resumes',async()=>{
      const filePath='native-before-projection.md',requestId=crypto.randomUUID(),actual=childModule.spawn;let killed=false;
      childModule.spawn=((...args:Parameters<typeof actual>)=>{const child=actual(...args);
        if(String(args[1]?.[1]).endsWith('markdown-create-birth.py')){let output='';child.stdout?.on('data',chunk=>{output+=String(chunk);if(!killed&&output.includes('"stage": "before_link"')){killed=true;child.kill('SIGKILL');}});}return child;
      })as typeof actual;syncBuiltinESMExports();
      let value:Awaited<ReturnType<typeof create>>;try{value=await create(filePath,requestId);}finally{childModule.spawn=actual;syncBuiltinESMExports();}
      assert(killed);assert.equal(value.response.status,409,JSON.stringify(value.json));assert.equal(value.json.completion.status,'projection_pending');assert.equal(await count('collaboration_documents',filePath),1);assert.equal(await exists(filePath),null);
      assert.equal((await create(filePath,requestId)).response.status,200);assert.equal(await count('collaboration_documents',filePath),1);
    });
    await check('separate actual source process loses its response and durable retry confirms same native document',async()=>{
      const filePath='process-response-lost.md',requestId=crypto.randomUUID(),own=await runChild(filePath,requestId);assert.equal(own.status,200);
      // Deliberately discard the child's HTTP body. This fresh caller only has
      // the original public tuple and must confirm durable storage after close.
      assert.equal((await create(filePath,requestId)).response.status,200);assert.equal(await count('collaboration_documents',filePath),1);assert.equal(await count('file_revisions',filePath),1);
    });
    await check('two ready actual processes with different UUIDs contend for exactly one new path',async()=>{
      const filePath='parallel-different.md',requestIds:[string,string]=[crypto.randomUUID(),crypto.randomUUID()],results=await runPair(filePath,requestIds);
      assert.equal(results.filter(result=>result.status===200&&result.body.completion?.status==='completed').length,1,JSON.stringify(results));
      const loser=results.find(result=>result.status!==200);assert(loser);assert.equal(loser.status,409);
      assert(loser.body.code==='PATH_EXISTS'||['projection_pending','recovery_required'].includes(loser.body.completion?.status??''));
      assert.equal(await count('collaboration_documents',filePath),1);assert.equal(await count('file_revisions',filePath),1);assert.deepEqual(await fs.readFile(path.join(root,filePath)),Buffer.alloc(0));
      for(let index=0;index<results.length;index++){
        const operationId=`manual-create:${requestIds[index]}`,expected=results[index].status===200?1:0;
        const receipts=(await admin.query('SELECT private_result FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,operationId])).rows;
        const births=(await admin.query('SELECT document_id FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,operationId])).rows;
        assert.equal(receipts.length,expected);assert.equal(births.length,expected);
        if(expected){const native=(await admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',[workspaceId,filePath])).rows[0];assert.equal(receipts[0].private_result.target.documentId,native.id);assert.equal(births[0].document_id,native.id);}
      }
    });
    await check('two ready actual processes reuse the same UUID and confirm one native document',async()=>{
      const filePath='parallel-same.md',requestId=crypto.randomUUID(),results=await runPair(filePath,[requestId,requestId]);
      for(const initial of results){
        if(initial.status===200){assert.equal(initial.body.completion?.status,'completed');continue;}
        assert.equal(initial.status,409);assert(['projection_pending','recovery_required'].includes(initial.body.completion?.status??''));
        // One explicitly named recovery check for this retained tuple, after
        // both original children and their PostgreSQL backends are closed.
        const explicitRetry=await create(filePath,requestId);assert.equal(explicitRetry.response.status,200,JSON.stringify(explicitRetry.json));assert.equal(explicitRetry.json.completion.requestId,requestId);
      }
      assert.equal(await count('collaboration_documents',filePath),1);assert.equal(await count('file_revisions',filePath),1);
      assert.equal(Number((await admin.query('SELECT count(*) AS n FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,`manual-create:${requestId}`])).rows[0].n),1);
      assert.equal(Number((await admin.query('SELECT count(*) AS n FROM collaboration_markdown_create_births WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,`manual-create:${requestId}`])).rows[0].n),1);
    });
    await check('direct free manual Birth, accessor flip and same-tuple reentrant entry are refused before new store writes',async()=>{
      const filePath='entry-reservation.md',requestId=crypto.randomUUID(),actual=childModule.spawn;let attempted=false,refused=false,nested:Promise<void>|undefined;
      const original=await request({path:filePath,type:'file',requestId});const origin=await persistence.captureAuthenticatedManualMarkdownCreateScope(original,workspaceId);
      const operationId=`manual-create:${requestId}`,input={workspaceRoot:root,targetPath:filePath,origin,operationId,source:{kind:'manual-empty-v1',workspaceId,targetPath:filePath,actorUserId:'owner',actorSessionId:'session-owner',requestId:operationId,operationId,sourceHash:crypto.createHash('sha256').update('').digest('hex'),sourceBytes:0}};
      await assert.rejects(birth.withMarkdownCreateBirthClaim(input,async()=>undefined,async()=>undefined));
      childModule.spawn=((...args:Parameters<typeof actual>)=>{const child=actual(...args);
        if(!attempted&&String(args[1]?.[1]).endsWith('markdown-create-birth.py')){attempted=true;nested=birth.withMarkdownCreateBirthClaim(input,async()=>undefined,async()=>undefined).then(()=>{refused=false;},()=>{refused=true;});}
        return child;
      })as typeof actual;syncBuiltinESMExports();
      try{const value=await create(filePath,requestId);assert.equal(value.response.status,200,JSON.stringify(value.json));}finally{childModule.spawn=actual;syncBuiltinESMExports();}
      await nested;assert(attempted);assert(refused);assert.equal(await count('collaboration_documents',filePath),1);
    });
    await check('full original scope is checked before final History/Audit effects',async()=>{
      const filePath='final-scope.md',requestId=crypto.randomUUID();assert.equal((await create(filePath,requestId)).response.status,200);
      const query=Client.prototype.query,capture=fileVersionHistoryService.capture,observers=receiptObservers(`manual-create:${requestId}`);
      let changed=false,captures=0,changedAfterObserver:number|undefined;
      fileVersionHistoryService.capture=async input=>{captures++;return capture(input);};
      Client.prototype.query=(function(this:Client,...args:unknown[]){const sql=typeof args[0]==='string'?args[0]:String((args[0]as{text?:unknown})?.text??'');
        observers.before(this,sql,args[1]);const value=Reflect.apply(query,this,args)as Promise<unknown>|undefined;
        return typeof value?.then==='function'?value.then(async result=>{
          const completed=observers.after(this,sql);
          if(completed===2&&!changed){
            await admin.query('UPDATE canvas_workspaces SET customer_id=$1 WHERE id=$2',['drifted-customer',workspaceId]);
            assert.equal((await admin.query('SELECT customer_id FROM canvas_workspaces WHERE id=$1',[workspaceId])).rows[0].customer_id,'drifted-customer');
            changedAfterObserver=completed;changed=true;
          }
          return result;
        }):value;
      })as typeof query;
      const auditBefore=await count('audit_events',filePath);
      try{const value=await create(filePath,requestId),detail=JSON.stringify({status:value.response.status,code:value.json.code??null,observers:observers.count(),receiptQueries:observers.queries(),changed,changedAfterObserver,parentPosts});
        assert.equal(value.response.status,409,detail);assert(changed,detail);assert.equal(changedAfterObserver,2,detail);assert.equal(captures,0);assert.equal(await count('audit_events',filePath),auditBefore);}
      finally{Client.prototype.query=query;fileVersionHistoryService.capture=capture;await admin.query('UPDATE canvas_workspaces SET customer_id=NULL WHERE id=$1',[workspaceId]);}
    },'scope');
    await check('actual raw Final-B checkout search_path is rejected before normalization and route effects',async()=>{
      const filePath='raw-final-checkout.md',requestId=crypto.randomUUID();assert.equal((await create(filePath,requestId)).response.status,200);
      const query=Client.prototype.query,capture=fileVersionHistoryService.capture,observers=receiptObservers(`manual-create:${requestId}`);
      const rawSql=`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
        (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,current_setting('search_path') AS search_path`;
      const normalized=(sql:string)=>sql.replace(/\s+/gu,' ').trim();
      let armed=false,injected=false,rawVerified=false,captures=0,normalizingSets=0,badPid:number|undefined,injectionFailure:unknown,armedAfterObserver:number|undefined;
      fileVersionHistoryService.capture=async input=>{captures++;return capture(input);};
      Client.prototype.query=(function(this:Client,...args:unknown[]){const sql=typeof args[0]==='string'?args[0]:String((args[0]as{text?:unknown})?.text??'');
        const pid=Number(Reflect.get(this,'processID'));
        if(badPid===pid&&sql.includes("set_config('search_path'"))normalizingSets++;
        if(armed&&!injected&&runtimePids.has(pid)&&!observers.active(this)&&normalized(sql)===normalized(rawSql)){
          injected=true;badPid=pid;
          // This is the actual raw guard SELECT delivered to a checked-out
          // runtime connection before BEGIN/normalization, after observer2.
          return(async()=>{
            try{
              const before=(await Reflect.apply(query,this,[rawSql])).rows[0];
              const ownRealm=(await admin.query(rawSql)).rows[0];
              assert.equal(before.schema,ownRealm.schema);assert.equal(Number(before.schema_oid),Number(ownRealm.schema_oid));assert.equal(Number(before.database_oid),Number(ownRealm.database_oid));assert.equal(before.search_path,ownRealm.search_path);
              await Reflect.apply(query,this,[`SET search_path TO "${schema}", pg_catalog, pg_temp`]);
              const after=(await Reflect.apply(query,this,[rawSql])).rows[0];
              assert.equal(after.schema,before.schema);assert.equal(Number(after.schema_oid),Number(before.schema_oid));assert.equal(Number(after.database_oid),Number(before.database_oid));assert.notEqual(after.search_path,before.search_path);
              rawVerified=true;
              return await Reflect.apply(query,this,args);
            }catch(failure){injectionFailure=failure;throw failure;}
          })();
        }
        observers.before(this,sql,args[1]);const value=Reflect.apply(query,this,args)as Promise<unknown>|undefined;
        return typeof value?.then==='function'?value.then(result=>{const completed=observers.after(this,sql);if(completed===2){armedAfterObserver=completed;armed=true;}return result;}):value;
      })as typeof query;
      const auditBefore=await count('audit_events',filePath);
      try{const value=await create(filePath,requestId),detail=JSON.stringify({status:value.response.status,code:value.json.code??null,observers:observers.count(),receiptQueries:observers.queries(),armed,armedAfterObserver,injected,rawVerified,badPid,parentPosts});
        assert.equal(value.response.status,409,detail);assert(armed,detail);assert.equal(armedAfterObserver,2,detail);assert(injected,detail);assert(rawVerified,detail);assert.equal(injectionFailure,undefined);
        assert.equal(value.json.completion.status,'recovery_required');
        assert.equal(normalizingSets,0,'A changed raw checkout cannot be repaired before its comparison.');assert.equal(captures,0);assert.equal(await count('audit_events',filePath),auditBefore);assert(badPid);await awaitBackendsGone([badPid]);
      }finally{Client.prototype.query=query;fileVersionHistoryService.capture=capture;}
    },'raw');
    await check('real completed-observer owner closure and final owner disposal stay unconfirmed',async()=>{
      const filePath='owner-close.md',requestId=crypto.randomUUID();assert.equal((await create(filePath,requestId)).response.status,200);
      const {openDb}=await import('../app/lib/db');let ordinal=0,closed=0;const ownFailure=new Error('Own actual-close fault');
      await assert.rejects(persistence.observeAuthenticatedMarkdownManualCreateCompletion(await request({path:filePath,type:'file',requestId}),{workspaceId,path:filePath,requestId},{openConnection:async()=>{const connection=await openDb(),index=++ordinal;return{...connection,close:async error=>{await connection.close(error);closed++;if(index===1)throw ownFailure;}};}}),error=>error===ownFailure);
      assert.equal(ordinal,2);assert.equal(closed,2);assert.equal(await count('collaboration_documents',filePath),1);
    },'observer-close');
    await check('actual dedicated close fault after route effects returns409 and never Completed',async()=>{
      const filePath='effects-close.md',requestId=crypto.randomUUID();assert.equal((await create(filePath,requestId)).response.status,200);
      const connect=runtime.connect,capture=fileVersionHistoryService.capture;let effects=false,failed=false;
      fileVersionHistoryService.capture=async input=>{const result=await capture(input);effects=true;return result;};
      runtime.connect=(function(this:typeof runtime,...args:unknown[]){const callback=args[0];if(typeof callback!=='function')return Reflect.apply(connect,this,args);
        return Reflect.apply(connect,this,[(error:unknown,client:import('pg').PoolClient|undefined,release:unknown)=>{
          if(client){const actual=client.release.bind(client);client.release=(discard?:Error|boolean)=>{actual(discard);if(effects&&!failed&&discard instanceof Error&&discard.message==='Discarding dedicated file lifecycle guard session.'){failed=true;throw new Error('Own post-effects dedicated-close fault');}};}
          Reflect.apply(callback,this,[error,client,release]);
        }]);})as typeof connect;
      try{const value=await create(filePath,requestId);assert(effects);assert(failed);assert.equal(value.response.status,409,JSON.stringify(value.json));assert.equal(value.json.success,false);assert.equal(value.json.completion.status,'recovery_required');}
      finally{runtime.connect=connect;fileVersionHistoryService.capture=capture;}
    },'effects-close');
    await check('false gate only observes an own native birth and performs no route effects',async()=>{
      const filePath='confirmed-before-gate.md',requestId=crypto.randomUUID();assert.equal((await create(filePath,requestId)).response.status,200);
      const audits=await count('audit_events',filePath),revisions=await count('file_revisions',filePath),capture=fileVersionHistoryService.capture;let captures=0;
      fileVersionHistoryService.capture=async input=>{captures++;return capture(input);};process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='0';
      try{const retry=await create(filePath,requestId);assert.equal(retry.response.status,409,JSON.stringify(retry.json));assert.equal(retry.json.completion.status,'recovery_required');
        assert.equal(captures,0);assert.equal(await count('audit_events',filePath),audits);assert.equal(await count('file_revisions',filePath),revisions);assert.deepEqual(await fs.readFile(path.join(root,filePath)),Buffer.alloc(0));}
      finally{fileVersionHistoryService.capture=capture;process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='1';}
    },'gatefalse');
    assert.equal(cases,selected?.length??14);assert.equal(fetches,0);
    console.log(`Authenticated manual Markdown Create PG18: ${cases} genuine route/Auth/SQL/FS/process families; no app/browser/host activation.`,{mode:selected?'selected':'full',selected:selected??null,selectedCount:cases,requestedCount:selected?.length??14});
  } finally {
    Client.prototype.query=originalQuery;childModule.spawn=originalSpawn;syncBuiltinESMExports();globalThis.fetch=originalFetch;
    const closureErrors:unknown[]=[];
    for(const owner of ownedChildren){
      try{
        if(!owner.entry.ended||!ownedGroupEmpty(owner.entry))await owner.stop(new Error('Own fixture is closing its held Create child.'));
        let closeTimer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([owner.closed,new Promise<never>((_,reject)=>{closeTimer=setTimeout(()=>reject(new Error('Own Create child close/drain remained unconfirmed.')),5000);})]);}
        finally{if(closeTimer)clearTimeout(closeTimer);}
        await awaitGroupGone(owner.entry);
        const ownPids=(await control.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[owner.applicationName])).rows.map(row=>Number(row.pid));
        await awaitBackendsGone(ownPids);
      }catch(error){closureErrors.push(error);}
    }
    try{if(pool)await pool.end();}catch(error){closureErrors.push(error);}
    const ownClientPids:number[]=[];
    for(const client of clients){const pid=Number(Reflect.get(client,'processID'));if(Number.isSafeInteger(pid)&&pid>0)ownClientPids.push(pid);
      try{await client.end();}catch(error){closureErrors.push(error);}}
    try{await awaitBackendsGone([...new Set([...runtimePids,...ownClientPids])]);}catch(error){closureErrors.push(error);}
    try{
      if(closureErrors.length){
        // Unknown process/FD/DB lifetime is not permission to erase its fixture.
        console.error('Own manual Create fixture retained for unconfirmed closure',{schema,dataRoot});
        throw new AggregateError(closureErrors,'Own manual Create closure was not confirmed; schema and DATA are retained.');
      }
      if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS gone',[schema])).rows[0].gone,true);}
      await rm(dataRoot,{recursive:true,force:true});
    }finally{await control.end();for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}
  }
}
main().catch(error=>{console.error('Manual Create fixture failed',{stage,name:error instanceof Error?error.name:typeof error,code:error&&typeof error==='object'?Reflect.get(error,'code'):undefined,detail:error instanceof assert.AssertionError?error.message:undefined});process.exitCode=1;});
