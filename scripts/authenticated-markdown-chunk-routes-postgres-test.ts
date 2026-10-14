import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client,types } from 'pg';
import { NextRequest } from 'next/server';
import { execFileSync } from 'node:child_process';
import { serializeSignedCookie } from 'better-call';
import fs from 'node:fs/promises';
import { loadOriginalMobileUploadConsumer, type NativeQueue } from './markdown-chunk-mobile-consumer';

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
  const schema = `authenticated_chunk_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^authenticated_chunk_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-authenticated-chunk-'));
  console.log('Chunk routes own fixture', {nodePid:process.pid,receipt:path.join(dataRoot,'live-owner-proof.json')});
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const originalQuery = Client.prototype.query;
  const childModule=createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'),originalSpawn=childModule.spawn;
  const trace: Array<Record<string, unknown>> = [];
  const transactions = new Map<Client, { begin: number; statements: number; settings: string | null }>();
  const runtimePids=new Set<number>();let monitor:ReturnType<typeof setInterval>|undefined,monitorPending:Promise<void>|undefined;
  let originalFailure:unknown,hasOriginalFailure=false;
  const ownClient = async (int8Strings=false) => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      ...(int8Strings?{types:{getTypeParser:(oid:number,format?:'text'|'binary')=>oid===types.builtins.INT8?(value:string)=>value:types.getTypeParser(oid,format)}}:{}),
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=request-principal-fixture` });
    client.on('error',()=>undefined); // transaction_timeout may terminate this owned fixture client.
    clients.add(client); await client.connect(); return client;
  };
  const workspaceId = `bootstrap-space-${crypto.randomUUID()}`;
  const selected=process.env.CANVAS_CHUNK_TEST_CASES?.split(',');
  if(selected)assert(selected.length>0&&new Set(selected).size===selected.length&&selected.every(value=>['second-observer-close-pending-dto','original-native-queue','gate-disabled-completed'].includes(value)));
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
    runtime.on('acquire',client=>{const backend=Number(Reflect.get(client,'processID'));runtimePids.add(backend);trace.push({stage,event:'acquire',backend,atMs:Math.round(performance.now())});});
    runtime.on('remove',client=>trace.push({stage,event:'remove',backend:Reflect.get(client,'processID'),atMs:Math.round(performance.now())}));
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!,process.env.CANVAS_INSTANCE_ID!)).ok,true);
    const license = await getLicenseStatus(); assert.equal(license.licensed,true); assert.equal(license.edition,'team'); assert.equal(license.seatLimit,2);
    const webCreate = await import('../app/api/files/uploads/route');
    const webFile = await import('../app/api/files/uploads/[id]/route');
    const webComplete = await import('../app/api/files/uploads/[id]/complete/route');
    const mobileCreate = await import('../app/api/mobile/v1/files/uploads/route');
    const mobileFile = await import('../app/api/mobile/v1/files/uploads/[id]/route');
    const mobileComplete = await import('../app/api/mobile/v1/files/uploads/[id]/complete/route');
    // Observe the actual driver promises only. No SQL, parameters, timeout or
    // permission is changed; bounded diagnostics contain no credentials/bytes.
    Client.prototype.query = (function(this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as {text?:unknown})?.text ?? '');
      const started = performance.now(), command = sql.trim();
      const tag = /^BEGIN/iu.test(command) ? 'begin' : /^COMMIT/iu.test(command) ? 'commit' : /^ROLLBACK/iu.test(command) ? 'rollback'
        : command.includes("SET LOCAL statement_timeout='5s'") ? 'principal_settings'
        : /(?:INSERT INTO|UPDATE) collaboration_markdown_create_births/iu.test(command) ? 'birth_write'
        : /(?:INSERT INTO|UPDATE) collaboration_(?:documents|yjs_states|markdown_file_import_receipts)/iu.test(command) ? 'native_write'
        : /^(?:INSERT|UPDATE|DELETE)/iu.test(command) ? 'write' : 'read';
      if(tag==='begin') transactions.set(this,{begin:started,statements:0,settings:null});
      const transaction = transactions.get(this);if(transaction){transaction.statements++;if(tag==='principal_settings')transaction.settings='statement5s/lock50ms/transaction5s';}
      const finish=(error?:unknown)=>{
        trace.push({stage,backend:Reflect.get(this,'processID'),tag,startedMs:Math.round(started),durationMs:Math.round(performance.now()-started),
          transactionMs:transaction?Math.round(performance.now()-transaction.begin):null,statements:transaction?.statements??null,settings:transaction?.settings??null,
          code:error&&typeof error==='object'?Reflect.get(error,'code')??'unknown':null});
        if(tag==='commit'||tag==='rollback')transactions.delete(this);
      };
      const callback=args.at(-1);
      if(typeof callback==='function')args[args.length-1]=(error:unknown,result:unknown)=>{finish(error);Reflect.apply(callback,this,[error,result]);};
      try{const value=Reflect.apply(originalQuery,this,args) as Promise<unknown>|undefined;
        return typeof value?.then==='function'?value.then(result=>{finish();return result;},error=>{finish(error);throw error;}):value;
      }catch(error){finish(error);throw error;}
    }) as typeof Client.prototype.query;
    monitor=setInterval(()=>{
      if(monitorPending||!runtimePids.size)return;
      monitorPending=control.query(`SELECT pid,extract(epoch FROM backend_start)::text AS backend_start,
        extract(epoch FROM xact_start)::text AS xact_start,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE pid=ANY($1::int[])`,[[...runtimePids]])
        .then(result=>{trace.push({stage,event:'activity',atMs:Math.round(performance.now()),backends:result.rows});})
        .catch(error=>{trace.push({stage,event:'activity_unconfirmed',code:error&&typeof error==='object'?Reflect.get(error,'code')??'unknown':'unknown'});})
        .finally(()=>{monitorPending=undefined;});
    },100);
    childModule.spawn=((...args:Parameters<typeof originalSpawn>)=>{
      const child=originalSpawn(...args),helper=Array.isArray(args[1])?path.basename(String(args[1][1])):'';
      if(/^workspace-(?:upload-live|markdown-upload)|^markdown-create-birth\.py$/u.test(helper)){
        trace.push({stage,event:'helper_spawn',helper,pid:child.pid,atMs:Math.round(performance.now())});
        child.once('close',(code,signal)=>trace.push({stage,event:'helper_close',helper,pid:child.pid,code,signal,atMs:Math.round(performance.now())}));
      }return child;
    }) as typeof originalSpawn;syncBuiltinESMExports();
    const root = path.join(dataRoot,'organizations/principal-org/shared'); await mkdir(root,{recursive:true});
    const request = async (pathname:string,method='POST',body?:string|Buffer,actor='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId, 'x-forwarded-for':'127.0.0.19' });
      if (cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[actor],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[actor]}`);
      if(typeof body==='string')headers.set('content-type','application/json');
      return new NextRequest('http://localhost'+pathname,{method,headers,...(body===undefined?{}:{body:body as BodyInit})});
    };
    type Entry = Awaited<ReturnType<typeof source>>;
    const source = async (filePath:string,content=Buffer.from('\uFEFF---\r\ntitle: Chunk\r\n---\r\n# Real route 🦊\r\n'),mobile=false,cookie=false) => {
      const base=mobile?'/api/mobile/v1/files/uploads':'/api/files/uploads';
      const createdResponse=await (mobile?mobileCreate:webCreate).POST(await request(base,'POST',JSON.stringify({targetDir:'.',files:[{path:filePath,size:content.length,mimeType:'text/markdown'}]}),'owner',cookie));
      const created=await createdResponse.json();assert.equal(createdResponse.status,201,JSON.stringify(created));
      const uploadId=created.upload.id as string,fileId=created.upload.files[0].id as string;
      const context={params:Promise.resolve({id:uploadId})};
      if(content.length){const response=await (mobile?mobileFile:webFile).PUT(await request(`${base}/${uploadId}?fileId=${fileId}&offset=0&expectedBytes=${content.length}`,'PUT',content,'owner',cookie),context);assert.equal(response.status,200,JSON.stringify(await response.json()));}
      return {uploadId,fileId,base,context,mobile,cookie,content,filePath,part:path.join(dataRoot,'.uploads/workspace',uploadId,fileId+'.part')};
    };
    const complete=async(entry:Entry,actor='owner')=>{
      const response=await(entry.mobile?mobileComplete:webComplete).POST(await request(`${entry.base}/${entry.uploadId}/complete`,'POST',JSON.stringify({fileId:entry.fileId} ),actor,entry.cookie),entry.context);
      const json=await response.json();
      if(json.completion)assert.deepEqual(Object.keys(json.completion).sort(),(json.completion.status==='completed'?['status','uploadId','fileId','targetPath']:['status','uploadId','fileId','targetPath','code']).sort());
      return{response,json};
    };
    const nativeCount=async(filePath:string)=>Number((await admin.query('SELECT count(*) AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',[workspaceId,filePath])).rows[0].n);
    const check=async(name:string,action:()=>Promise<void>,id?:string)=>{if(selected&&(!id||!selected.includes(id)))return;stage=name;await action();cases++;console.log('PASS '+name);};
    await check('central gate false: both real routes retain source, no native or target',async()=>{
      process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='0';
      for(const mobile of[false,true]){const entry=await source(`gate-${mobile}.md`,Buffer.from('# Gate'),mobile);const{response,json}=await complete(entry);assert.equal(response.status,mobile?409:202,JSON.stringify(json));assert.equal(json.completion.status,'unavailable');if(!mobile)assert.equal(json.file.status,'uploaded');else assert.equal(json.success,false);assert.equal(await nativeCount(entry.filePath),0);assert.equal(await fs.stat(path.join(root,entry.filePath)).catch(()=>null),null);assert.deepEqual(await readFile(entry.part),entry.content);}
    });
    await check('historical generic single Markdown completion is never adopted as native evidence',async()=>{
      const {requireRequestWorkspace}=await import('../app/lib/workspaces/request'),upload=await import('../app/lib/files/workspace-upload-service');
      for(const mobile of[false,true]){
        const entry=await source(`legacy-${mobile}.md`,Buffer.from('# Existing generic completion\n'),mobile);
        const resolved=await requireRequestWorkspace(await request(`${entry.base}/${entry.uploadId}/complete`),{workspaceId,permissions:'canWrite'});assert(!resolved.response);
        // Build an authentic old transport-completed record through the
        // unchanged request-less generic service contract, without native data.
        await upload.completeWorkspaceUploadFile({sessionId:entry.uploadId,fileId:entry.fileId,userId:'owner',workspace:resolved.workspace,
          commit:async({sourcePath,file})=>fs.copyFile(sourcePath,path.join(root,file.targetPath),1)});
        const read=await(mobile?mobileFile:webFile).GET(await request(`${entry.base}/${entry.uploadId}`,'GET'),entry.context);
        assert.equal(read.status,409);assert.equal((await read.json()).code,'MARKDOWN_UPLOAD_RECOVERY_REQUIRED');
        const retried=await complete(entry);assert.equal(retried.response.status,mobile?409:202,JSON.stringify(retried.json));assert.equal(retried.json.completion.status,'recovery_required');
        assert.equal(await nativeCount(entry.filePath),0);assert.deepEqual(await readFile(path.join(root,entry.filePath)),entry.content);
      }
    });
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='1';
    await check('real Web cookie and Mobile bearer publish and readonly completed retry',async()=>{
      for(const mobile of[false,true]){const entry=await source(`first-${mobile}.markdown`,undefined,mobile,!mobile);const{response,json}=await complete(entry);assert.equal(response.status,200,JSON.stringify(json));assert.equal(json.completion.status,'completed');assert.equal(json.file.status,'completed');assert.equal(await nativeCount(entry.filePath),1);assert.deepEqual(await readFile(path.join(root,entry.filePath)),entry.content);assert.equal((await stat(path.join(root,entry.filePath))).mode&0o777,0o644);assert.equal(await fs.stat(entry.part).catch(()=>null),null);const retry=await complete(entry);assert.equal(retry.response.status,200,JSON.stringify(retry.json));assert.equal(retry.json.alreadyCompleted,true);assert.equal(retry.json.completion.status,'completed');assert.equal(await nativeCount(entry.filePath),1);}
    });
    await check('empty, uppercase and plain fallback preserve source bytes and profile',async()=>{
      for(const [filePath,content] of [['empty.MD',Buffer.alloc(0)],['plain.md',Buffer.from('---\nkey: kept\n---\n<div>literal unknown block</div>\n')]] as const){
        const entry=await source(filePath,content);const completed=await complete(entry);assert.equal(completed.response.status,200,JSON.stringify(completed.json));
        assert.deepEqual(await readFile(path.join(root,filePath)),content);assert.equal(await nativeCount(filePath),1);
      }
    });
    await check('actual five MiB boundary before native mutation',async()=>{
      const entry=await source('too-large.md',Buffer.alloc(5*1024*1024+1,97));const result=await complete(entry);
      assert.equal(result.response.status,413,JSON.stringify(result.json));assert.equal(result.json.code,'MARKDOWN_UPLOAD_TOO_LARGE');assert.equal(await nativeCount(entry.filePath),0);
      assert.deepEqual(await readFile(entry.part),entry.content);assert.equal(await fs.stat(path.join(root,entry.filePath)).catch(()=>null),null);
    });
    await check('createOnly keeps both routes foreign destination bytes',async()=>{
      for(const mobile of[false,true]){const entry=await source(`collision-${mobile}.md`,Buffer.from('# import'),mobile),foreign=Buffer.from('Own synthetic foreign target');
        await fs.writeFile(path.join(root,entry.filePath),foreign);const result=await complete(entry);assert.equal(result.response.status,mobile?409:202,JSON.stringify(result.json));
        assert.notEqual(result.json.completion.status,'completed');assert.equal(await nativeCount(entry.filePath),0);assert.deepEqual(await readFile(path.join(root,entry.filePath)),foreign);assert.deepEqual(await readFile(entry.part),entry.content);}
    });
    await check('unsupported source before commit is not claimed as native pending',async()=>{
      const entry=await source('mixed.md',Buffer.from('# First\r\nSecond\n'));const result=await complete(entry);
      assert.equal(result.response.status,422,JSON.stringify(result.json));assert.equal(await nativeCount(entry.filePath),0);assert.deepEqual(await readFile(entry.part),entry.content);
    });
    await check('actual member denial retains original private source',async()=>{
      const entry=await source('denied.md');const result=await complete(entry,'member');assert.equal(result.response.status,403);assert.equal(await nativeCount(entry.filePath),0);assert.deepEqual(await readFile(entry.part),entry.content);
    });
    await check('B committed and actual preparation child killed: retained and same request resumes',async()=>{
      for(const mobile of[false,true]){
        const entry=await source(`pending-${mobile}.md`,Buffer.from('# Durable native\n'),mobile),spawn=childModule.spawn;let killed=false;
        childModule.spawn=((...args:Parameters<typeof childModule.spawn>)=>{
          const child=spawn(...args);if(String(args[1]?.[1]).endsWith('markdown-create-birth.py')){
            let output='';child.stdout?.on('data',chunk=>{output+=String(chunk);if(!killed&&output.includes('"stage": "before_link"')){killed=true;child.kill('SIGKILL');}});
          }return child;
        }) as typeof childModule.spawn;syncBuiltinESMExports();
        let result:Awaited<ReturnType<typeof complete>>;
        try{result=await complete(entry);}finally{childModule.spawn=spawn;syncBuiltinESMExports();}
        assert.equal(killed,true);assert.equal(result.response.status,mobile?409:202,JSON.stringify(result.json));assert.equal(result.json.completion.status,'projection_pending');
        assert.equal(await nativeCount(entry.filePath),1);assert.equal(await fs.stat(path.join(root,entry.filePath)).catch(()=>null),null);assert.deepEqual(await readFile(entry.part),entry.content);
        const retried=await complete(entry);assert.equal(retried.response.status,200,JSON.stringify(retried.json));assert.equal(retried.json.completion.status,'completed');assert.equal(await nativeCount(entry.filePath),1);assert.deepEqual(await readFile(path.join(root,entry.filePath)),entry.content);
      }
    });
    await check('route effects precede progress: rename failure retains source and retry is at least once',async()=>{
      const entry=await source('lost-response.md'),rename=fs.rename;let failed=false;
      fs.rename=(async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
        if(!failed&&String(to)===entry.part+'.json'&&String(from).includes('.tmp')){
          const raw=JSON.parse(await readFile(from,'utf8'));if(raw.status==='completed'){failed=true;throw new Error('Own progress-rename crash boundary');}
        }return rename(from,to);
      }) as typeof fs.rename;
      let result:Awaited<ReturnType<typeof complete>>;
      try{result=await complete(entry);}finally{fs.rename=rename;}
      assert.equal(failed,true);assert.equal(result.response.status,500,JSON.stringify(result.json));assert.equal(await nativeCount(entry.filePath),1);assert.deepEqual(await readFile(entry.part),entry.content);
      const auditCount=async()=>Number((await admin.query("SELECT count(*) AS n FROM audit_events WHERE workspace_id=$1 AND entity_id=$2 AND action='file.upload'",[workspaceId,entry.filePath])).rows[0].n);
      assert.equal(await auditCount(),1);
      const retried=await complete(entry);assert.equal(retried.response.status,200,JSON.stringify(retried.json));assert.equal(retried.json.alreadyCompleted,false);assert.equal(await fs.stat(entry.part).catch(()=>null),null);assert.equal(await nativeCount(entry.filePath),1);
      assert(retried.json.committed);assert.equal(await auditCount(),2);assert.equal((await complete(entry)).json.alreadyCompleted,true);assert.equal(await auditCount(),2);
    });
    await check('actual first Source Session-close failure retains uploaded progress before all route effects',async()=>{
      const entry=await source('source-close.md'),open=fs.open;let failed=false;
      fs.open=(async(...args:Parameters<typeof fs.open>)=>{
        const handle=await open(...args);
        if(path.basename(String(args[0]))===`session-${entry.uploadId}.lock`){
          const close=handle.close.bind(handle);handle.close=async()=>{
            await close();
            if(!failed&&await fs.stat(path.join(root,entry.filePath)).catch(()=>null)){
              const progress=JSON.parse(await readFile(entry.part+'.json','utf8'));
              if(progress.status==='uploaded'){failed=true;throw new Error('Own actual first Source Session-close failure');}
            }
          };
        }return handle;
      }) as typeof fs.open;
      let result:Awaited<ReturnType<typeof complete>>;try{result=await complete(entry);}finally{fs.open=open;}
      assert(failed);assert.equal(result.response.status,500,JSON.stringify(result.json));assert.equal(await nativeCount(entry.filePath),1);
      assert.equal(JSON.parse(await readFile(entry.part+'.json','utf8')).status,'uploaded');assert.deepEqual(await readFile(entry.part),entry.content);
      const auditCount=async()=>Number((await admin.query("SELECT count(*) AS n FROM audit_events WHERE workspace_id=$1 AND entity_id=$2 AND action='file.upload'",[workspaceId,entry.filePath])).rows[0].n);
      assert.equal(await auditCount(),0);const retry=await complete(entry);assert.equal(retry.response.status,200,JSON.stringify(retry.json));assert.equal(retry.json.alreadyCompleted,false);assert.equal(await auditCount(),1);
    });
    await check('actual transport Session-close after progress cannot omit prior route effects',async()=>{
      const entry=await source('transport-close.md'),open=fs.open;let failed=false;
      fs.open=(async(...args:Parameters<typeof fs.open>)=>{
        const handle=await open(...args);
        if(path.basename(String(args[0]))===`session-${entry.uploadId}.lock`){
          const close=handle.close.bind(handle);handle.close=async()=>{
            await close();if(!failed){const progress=JSON.parse(await readFile(entry.part+'.json','utf8'));if(progress.status==='completed'){failed=true;throw new Error('Own actual transport Session-close failure');}}
          };
        }return handle;
      }) as typeof fs.open;
      let result:Awaited<ReturnType<typeof complete>>;try{result=await complete(entry);}finally{fs.open=open;}
      assert(failed);assert.equal(result.response.status,500,JSON.stringify(result.json));assert.equal(await nativeCount(entry.filePath),1);
      assert.equal(JSON.parse(await readFile(entry.part+'.json','utf8')).status,'completed');assert.equal(await fs.stat(entry.part).catch(()=>null),null);
      const auditCount=async()=>Number((await admin.query("SELECT count(*) AS n FROM audit_events WHERE workspace_id=$1 AND entity_id=$2 AND action='file.upload'",[workspaceId,entry.filePath])).rows[0].n);
      assert.equal(await auditCount(),1);const read=await webFile.GET(await request(`${entry.base}/${entry.uploadId}`,'GET'),entry.context);assert.equal(read.status,200,JSON.stringify(await read.json()));
      const retry=await complete(entry);assert.equal(retry.response.status,200,JSON.stringify(retry.json));assert.equal(retry.json.alreadyCompleted,true);assert.equal(await auditCount(),1);
    });
    await check('readonly completed observer requires actual Dedicated owner closure',async()=>{
      const entry=await source('observe-close.md');assert.equal((await complete(entry)).response.status,200);
      const {openDb}=await import('../app/lib/db'),{observeAuthenticatedMarkdownUploadCompletion:observe}=await import('../app/lib/collaboration/markdown-file-import-persistence');
      const operationId=`upload:${entry.uploadId}:${entry.fileId}`,selection={uploadSessionId:entry.uploadId,fileId:entry.fileId,workspaceId,targetPath:entry.filePath,
        actorUserId:'owner',actorSessionId:'session-owner',requestId:operationId,operationId};
      let opened=0,closed=0;const ownFailure=new Error('Own Dedicated-close confirmation failure');
      await assert.rejects(observe(await request(`${entry.base}/${entry.uploadId}/complete`),selection,entry.content.length,{openConnection:async()=>{
        const actual=await openDb(),ordinal=++opened;return{...actual,close:async(error?:Error)=>{await actual.close(error);closed++;if(ordinal===1)throw ownFailure;}};
      }}),error=>error===ownFailure);
      assert.equal(opened,2);assert.equal(closed,2);assert.deepEqual(await readFile(path.join(root,entry.filePath)),entry.content);assert.equal(await nativeCount(entry.filePath),1);
    });
    await check('second actual observer Dedicated close failure retains pending without committed DTO',async()=>{
      const entry=await source('second-observer-close.md'),query=Client.prototype.query,connect=runtime.connect;let callbackDone=false,failed=false;
      const ownFailure=new Error('Own second observer Dedicated-close failure');
      Client.prototype.query=(function(this:Client,...args:unknown[]){
        const sql=typeof args[0]==='string'?args[0]:String((args[0]as{text?:unknown})?.text??'');
        const matches=/insert into "?audit_events"?/iu.test(sql)&&Array.isArray(args[1])&&args[1].includes(entry.filePath);
        const callback=args.at(-1);if(matches&&typeof callback==='function')args[args.length-1]=(error:unknown,value:unknown)=>{if(!error)callbackDone=true;Reflect.apply(callback,this,[error,value]);};
        const result=Reflect.apply(query,this,args)as Promise<unknown>|undefined;
        return matches&&typeof result?.then==='function'?result.then(value=>{callbackDone=true;return value;}):result;
      })as typeof query;
      runtime.connect=(function(this:typeof runtime,...args:unknown[]){
        const callback=args[0];if(typeof callback!=='function')return Reflect.apply(connect,this,args);
        return Reflect.apply(connect,this,[(error:unknown,client:import('pg').PoolClient|undefined,release:unknown)=>{
          if(client&&callbackDone){const releaseActual=client.release.bind(client);client.release=(discard?:Error|boolean)=>{
            releaseActual(discard);if(!failed&&discard instanceof Error&&discard.message==='Discarding dedicated file lifecycle guard session.'){
              failed=true;throw ownFailure;
            }
          };}
          Reflect.apply(callback,this,[error,client,release]);
        }]);
      })as typeof connect;
      let result:Awaited<ReturnType<typeof complete>>;
      try{result=await complete(entry);}finally{Client.prototype.query=query;runtime.connect=connect;}
      assert(callbackDone);assert(failed);assert.equal(result.response.status,202,JSON.stringify(result.json));assert.equal(result.json.completion.status,'recovery_required');assert(!('committed'in result.json));
      assert.equal(JSON.parse(await readFile(entry.part+'.json','utf8')).status,'uploaded');assert.deepEqual(await readFile(entry.part),entry.content);assert.equal(await nativeCount(entry.filePath),1);
      assert.equal(Number((await admin.query("SELECT count(*) AS n FROM audit_events WHERE workspace_id=$1 AND entity_id=$2 AND action='file.upload'",[workspaceId,entry.filePath])).rows[0].n),1);
    },'second-observer-close-pending-dto');
    await check('readonly completed rejects missing, byte-equal replacement, parent replacement and changed physical content',async()=>{
      for(const variant of['missing','same-bytes','parent','changed-content']){
        const entry=await source(variant==='parent'?'confirmed-parent/child.md':`observe-${variant}.md`,Buffer.from('# Own initial birth\n'));
        assert.equal((await complete(entry)).response.status,200);const target=path.join(root,entry.filePath);
        if(variant==='missing')await fs.unlink(target);
        else if(variant==='parent'){await fs.rename(path.dirname(target),path.dirname(target)+'-retained');await fs.mkdir(path.dirname(target));await fs.writeFile(target,entry.content,{mode:0o644});}
        else{await fs.rename(target,target+'.retained');await fs.writeFile(target,variant==='same-bytes'?entry.content:Buffer.from('# Later projected content\n'),{mode:0o644});}
        const before=await fs.readFile(target).catch(()=>null);
        const read=await webFile.GET(await request(`${entry.base}/${entry.uploadId}`,'GET'),entry.context);assert.equal(read.status,409);
        const retried=await complete(entry);assert.equal(retried.response.status,202,JSON.stringify(retried.json));assert.equal(retried.json.completion.status,'recovery_required');
        assert.deepEqual(await fs.readFile(target).catch(()=>null),before);assert.equal(await nativeCount(entry.filePath),1);
      }
    });
    await check('original Native Queue keeps source on 409 and revalidates completed GET before removal',async()=>{
      stage='native_queue:load_original_modules';
      const mobileRoot=process.env.CANVAS_NATIVE_FILES_SOURCE_ROOT;assert(mobileRoot,'Set CANVAS_NATIVE_FILES_SOURCE_ROOT to the reviewed native source checkout.');
      assert.equal(execFileSync('git',['-C',mobileRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),'acfa5061956824775e1dd2444a6828e0d164e468');
      assert.equal(execFileSync('git',['-C',mobileRoot,'status','--porcelain'],{encoding:'utf8'}).trim(),'');
      const native=loadOriginalMobileUploadConsumer(mobileRoot),entry=await source('native-queue.md',Buffer.from('# Queue\n'),true);
      const before=await mobileFile.GET(await request(`${entry.base}/${entry.uploadId}`,'GET'),entry.context),beforeJson=await before.json();assert.equal(before.status,200,JSON.stringify(beforeJson));const publicSession=beforeJson.upload;
      const local={uri:'file:///documents/canvas-notebook-mobile/pending-uploads/own-native-queue.md',name:entry.filePath,size:entry.content.length,mimeType:'text/markdown'};
      native.files.set(local.uri,entry.content);const scope={instanceId:'own-fixture',userId:'owner',workspaceId};
      let queue:NativeQueue={id:crypto.randomUUID(),targetDir:'.',sources:[local],nextIndex:0,pending:{source:local,session:publicSession,
        limits:{chunkBytes:8*1024*1024,maxFiles:1,maxFileBytes:5*1024*1024*1024,maxTotalBytes:10*1024*1024*1024}},skippedCount:0};
      await native.service.persistFileUploadQueue(scope,queue);const calls:string[]=[];
      const api=async(pathname:string,init?:RequestInit)=>{
        const method=init?.method??'GET';calls.push(`${method} ${pathname}`);
        assert(!['DELETE','PUT'].includes(method));assert(pathname===`${entry.base}/${entry.uploadId}`||pathname===`${entry.base}/${entry.uploadId}/complete`);
        return method==='GET'?mobileFile.GET(await request(pathname,'GET'),entry.context):mobileComplete.POST(await request(pathname,'POST',String(init?.body)),entry.context);
      };
      const run=async()=>{try{return await native.service.runFileUploadQueue({scope,queue,api,prepareRequest:()=>assert.fail('No native chunk should be prepared.'),onQueueChange:value=>{queue=value;},onProgress:()=>undefined});}
        catch(error){trace.push({stage,event:'native_consumer_error',name:error instanceof Error?error.name:'unknown',status:error&&typeof error==='object'?Reflect.get(error,'status')??null:null,code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null});throw error;}};
      stage='native_queue:unavailable_complete';
      process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='0';await assert.rejects(run,error=>Boolean(error&&typeof error==='object'&&Reflect.get(error,'status')===409&&Reflect.get(error,'code')==='MARKDOWN_UPLOAD_NATIVE_UNAVAILABLE'));
      assert.equal(queue.nextIndex,0);assert.equal(queue.pending?.session.id,entry.uploadId);assert(native.files.has(local.uri));
      queue=(await native.service.loadFileUploadQueue(scope))!;assert.equal(queue.nextIndex,0);
      stage='native_queue:server_native_complete';
      process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='1';const completed=await complete(entry);assert.equal(completed.response.status,200,JSON.stringify(completed.json));
      await admin.query(`UPDATE file_collaboration_lineages SET status='archived',archived_at=$3 WHERE workspace_id=$1 AND path=$2`,[workspaceId,entry.filePath,Date.now()]);
      stage='native_queue:archived_completed_get';
      await assert.rejects(run,error=>Boolean(error&&typeof error==='object'&&Reflect.get(error,'status')===409&&Reflect.get(error,'code')==='MARKDOWN_UPLOAD_RECOVERY_REQUIRED'));
      assert.equal(queue.nextIndex,0);assert(native.files.has(local.uri));
      await admin.query(`UPDATE file_collaboration_lineages SET status='active',archived_at=NULL WHERE workspace_id=$1 AND path=$2`,[workspaceId,entry.filePath]);
      stage='native_queue:verified_completed_get';
      const finished=await run();assert.equal(finished.nextIndex,1);assert.equal(finished.pending,null);assert(!native.files.has(local.uri));assert.equal(await nativeCount(entry.filePath),1);
      assert.equal(calls.filter(value=>value.startsWith('POST')).length,1,'Only unavailable first Complete is sent by the queue; completed retries use the checked GET.');
      console.log('Original native consumer sources',JSON.stringify(native.hashes));
    },'original-native-queue');
    await check('gate disabled again still permits only readonly own completed observation',async()=>{
      const entry=await source('already-before-gate.md');assert.equal((await complete(entry)).response.status,200);process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='0';
      const retried=await complete(entry);assert.equal(retried.response.status,200,JSON.stringify(retried.json));assert.equal(retried.json.alreadyCompleted,true);assert.equal(await nativeCount(entry.filePath),1);process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='1';
    },'gate-disabled-completed');
    if(selected)assert.equal(cases,selected.length);
    assert.equal(fetches,0);console.log(`Authenticated chunk routes PG18: ${cases} genuine exported-handler/Auth/SQL/FS families; no app/browser/host activation.`);
  } catch(error){hasOriginalFailure=true;originalFailure=error;throw error;} finally {
    if(monitor)clearInterval(monitor);await monitorPending;
    Client.prototype.query=originalQuery;
    childModule.spawn=originalSpawn;syncBuiltinESMExports();
    globalThis.fetch=originalFetch;
    try {try{if(pool)await pool.end();
      if(runtimePids.size){
        // pg's end/remove confirms local socket closure. Independently await
        // server disappearance too; this never alters a product timeout/lock.
        const closeDeadline=performance.now()+5_000;
        for(;;){const remaining=(await control.query('SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::int[])',[[...runtimePids]])).rows;
          trace.push({stage,event:'server_closure_observation',atMs:Math.round(performance.now()),remaining:remaining.map(row=>row.pid)});
          if(!remaining.length)break;
          if(performance.now()>=closeDeadline)assert.equal(remaining.length,0,'Owned PostgreSQL backend closure was not confirmed.');
          await new Promise(resolve=>setTimeout(resolve,25));
        }
      }
      trace.push({stage,event:'runtime_closed',backends:[...runtimePids],atMs:Math.round(performance.now())});
      }catch(error){if(hasOriginalFailure)throw new AggregateError([originalFailure,error],'Own fixture result and runtime closure failed.');throw error;}
      finally{const evidence = process.env.CANVAS_CHUNK_TEST_EVIDENCE_DIR;
        if(evidence){assert.equal((await stat(evidence)).mode&0o077,0);await fs.writeFile(path.join(evidence,`query-trace-${process.pid}.json`),JSON.stringify(trace,null,2),{mode:0o600});}}
    }
    finally {try{for(const client of clients)await client.end();}
      finally {try{if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);}}
        finally{await control.end();await rm(dataRoot,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}}}
  }
}
main().catch(error=>{const trace=(value:unknown):unknown=>({name:value instanceof Error?value.name:typeof value,code:value&&typeof value==='object'?Reflect.get(value,'code')??null:null,children:value instanceof AggregateError?value.errors.map(trace):[],cause:value instanceof Error&&value.cause!==undefined?trace(value.cause):null}); console.error('Chunk routes failure classification',JSON.stringify(trace(error)));console.error('Owned authenticated staging fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',detail:error instanceof assert.AssertionError?error.message:undefined,code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  frames:error instanceof Error?error.stack?.split('\n').slice(1).filter(line=>line.includes('/app/lib/')||line.includes('/scripts/')):undefined});process.exitCode=1;});
