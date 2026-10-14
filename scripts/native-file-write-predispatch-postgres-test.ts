import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, type Pool, type PoolClient } from 'pg';
import { spawn } from 'node:child_process';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';

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
  const schema = `write_predispatch_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^write_predispatch_[a-f0-9]{32}$/u);
  const workspaceId = `write-predispatch-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-write-predispatch-'));
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=request-principal-fixture` });
    client.on('error',()=>undefined); // transaction_timeout may terminate this owned fixture client.
    clients.add(client); await client.connect(); return client;
  };
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
      await own(admin); const result = await admin.query(sql,values); await own(admin); return result;
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
      VALUES($1,'principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`,[workspaceId]);
    for (const userId of ['owner','member','inactive']) {
      await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
        VALUES($1,'principal-org','personal',$2,$2,$3,'active',100,100)`,[`personal-${userId}`,userId,`users/${userId}/workspace`]);
    }
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
    const request = async (userId='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if (cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[userId],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/collaboration/session?path=note.md',{ headers });
    };
    const { POST } = await import('../app/api/files/write/route');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { createEmptyDocx } = await import('../app/lib/office/empty-docx');
    const { writeWorkspaceFileContent } = await import('../app/lib/files/write-service');
    const { assertNoInitializedNativeFileWriteBeforeDispatch: preflight } = await import('../app/lib/files/native-file-write-authority');
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { collaborationAdmissionActionDigest } = await import('../app/lib/collaboration/room-admission-contract');
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { openDb } = await import('../app/lib/db');
    const { withWorkspaceFileLifecycleGuard } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { withWorkspaceFileLifecycleLeases } = await import('../app/lib/collaboration/file-lifecycle-admission-context');
    const { acquireFileLock } = await import('../app/lib/files/collaboration-policy');
    const root=path.join(dataRoot,'organizations/principal-org/shared');await mkdir(root,{recursive:true});
    const selected=await requireRequestWorkspace(await request(),{permissions:'canWrite'});assert(!selected.response);
    const workspace=selected.workspace;
    const post=async(filePath:string,content:string,extra:Record<string,unknown>={},user='owner',cookie=false)=>{
      const actual=await request(user,cookie),headers=new Headers(actual.headers);headers.set('content-type','application/json');
      const http=new NextRequest('http://localhost/api/files/write',{method:'POST',headers,body:JSON.stringify({path:filePath,content,...extra})});
      const response=await POST(http);return{status:response.status,body:await response.json() as Record<string,unknown>};
    };
    const seed=async(filePath:string,kind:'initialized'|'pristine'|'missing'|'orphan'='initialized')=>{
      const id=`doc-${crypto.randomUUID()}`,lineage=`lineage-${crypto.randomUUID()}`,doc=createPlainTextYDoc('# Native body\n');
      const update=Buffer.from(Y.encodeStateAsUpdate(doc)),vector=Buffer.from(Y.encodeStateVector(doc));doc.destroy();
      if(kind!=='orphan'){
        await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
          VALUES($1,$2,'organization','principal-org',$3,'active',100)`,[lineage,workspaceId,filePath]);
        await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,status,state_version,yjs_state_lifecycle,created_at,updated_at)
          VALUES($1,$2,$3,'organization','principal-org',$4,'yjs','active',$5,$6,100,100)`,
        [id,lineage,workspaceId,filePath,kind==='pristine'?0:1,kind==='pristine'?'never_initialized':'initialized']);
      }
      if(kind==='initialized'||kind==='orphan')await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
        schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,has_bom,degraded,status)
        VALUES($1,$2,'principal-org',$3,'plain_text',1,1,$4,$5,0,100,0,0,0,'active')`,[id,workspaceId,filePath,update,vector]);
      return{id,lineage,path:filePath};
    };
    const ledger=async()=>JSON.stringify((await admin.query(`SELECT
      (SELECT count(*) FROM file_revisions WHERE workspace_id=$1) AS revisions,
      (SELECT count(*) FROM file_collaboration_lineages WHERE workspace_id=$1) AS lineages,
      (SELECT count(*) FROM collaboration_documents WHERE workspace_id=$1) AS documents,
      (SELECT count(*) FROM collaboration_yjs_states WHERE workspace_id=$1) AS states,
      (SELECT count(*) FROM file_locks WHERE workspace_id=$1) AS locks`,[workspaceId])).rows[0]);
    const native=async(id:string)=>JSON.stringify((await admin.query(`SELECT representation,lifecycle_generation,document_sequence,
      encode(yjs_state,'hex') AS binary,encode(state_vector,'hex') AS vector FROM collaboration_yjs_states WHERE document_id=$1`,[id])).rows);
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Native write predispatch passed: ${name}`);};
    const actualPool=runtime as unknown as Pool,originalConnect=actualPool.connect.bind(actualPool),wrapped=new WeakSet<PoolClient>();
    let before:((client:PoolClient,sql:string,values:unknown[])=>Promise<void>)|undefined;
    let after:((client:PoolClient,sql:string,values:unknown[])=>Promise<void>)|undefined;
    const patchClient=(client:PoolClient)=>{
      if(wrapped.has(client))return client;wrapped.add(client);const query=client.query.bind(client);
      client.query=(async(...args:unknown[])=>{
        const sql=typeof args[0]==='string'?args[0]:String((args[0] as {text?:unknown})?.text??''),values=Array.isArray(args[1])?args[1]:[];
        if(before)await before(client,sql,values);const result=await (query as(...args:unknown[])=>Promise<unknown>)(...args);if(after)await after(client,sql,values);return result;
      }) as PoolClient['query'];return client;
    };
    actualPool.connect=((callback?:(error:Error|undefined,client:PoolClient|undefined,release:()=>void)=>void)=>callback
      ?originalConnect((error,client,release)=>callback(error,client&&patchClient(client),release)):originalConnect().then(patchClient)) as Pool['connect'];
    try{
      for(const extension of ['md','txt','json','docx'])for(const projection of ['absent','empty','stale'] as const)await check(`real POST denies initialized .${extension} with ${projection} projection before dispatch`,async()=>{
        const target=await seed(`native-${crypto.randomUUID()}.${extension}`),file=path.join(root,target.path);
        if(projection!=='absent')await writeFile(file,projection==='empty'?'':'stale physical bytes');
        const beforeLedger=await ledger(),beforeNative=await native(target.id);
        const result=await post(target.path,'this is not a DOCX',{createOnly:true},'owner',projection==='stale');
        assert.equal(result.status,409);assert.equal(result.body.code,'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED');
        assert.equal(await ledger(),beforeLedger);assert.equal(await native(target.id),beforeNative);
        if(projection==='absent')await assert.rejects(stat(file),{code:'ENOENT'});else assert.equal(await readFile(file,'utf8'),projection==='empty'?'':'stale physical bytes');
        assert(!JSON.stringify(result.body).includes(target.id));assert(!JSON.stringify(result.body).includes(target.lineage));
      });
      for(const kind of ['missing','orphan'] as const)await check(`real POST denies ${kind} native authority without physical fallback`,async()=>{
        const target=await seed(`${kind}-${crypto.randomUUID()}.docx`,kind),beforeLedger=await ledger();
        const result=await post(target.path,'not a ZIP',{createOnly:true});assert.equal(result.status,409);
        assert.equal(result.body.code,kind==='orphan'?'NATIVE_FILE_WRITE_AUTHORITY_CONFLICT':'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED');
        assert.equal(await ledger(),beforeLedger);await assert.rejects(stat(path.join(root,target.path)),{code:'ENOENT'});
        assert(!JSON.stringify(result.body).includes(target.id));
      });
      await check('registry-only native descendants cannot be replaced by a file at their parent path',async()=>{
        const directory=`native-parent-${crypto.randomUUID()}.docx`;await seed(`${directory}/child.md`,'pristine');const beforeLedger=await ledger();
        const result=await post(directory,'invalid DOCX');assert.equal(result.status,409);assert.equal(result.body.code,'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED');
        assert.equal(await ledger(),beforeLedger);await assert.rejects(stat(path.join(root,directory)),{code:'ENOENT'});
      });
      await check('real DOCX pristine and physical publication retains bytes, locks, idempotent journal and revision guards',async()=>{
        const file=`office-${crypto.randomUUID()}.docx`;await seed(file,'pristine');const bytes=await createEmptyDocx();
        const creation=await post(file,`base64:${bytes.toString('base64')}`,{createOnly:true,idempotencyKey:crypto.randomUUID(),sessionId:'office-fixture'});
        assert.equal(creation.status,200,JSON.stringify(creation.body));assert((await readFile(path.join(root,file))).equals(bytes));
        const data=creation.body.data as {revision:{id:string};stats:{sha256:string};collaboration:{lineageId:string}};
        const session='office-edit-fixture',lock=await acquireFileLock({workspace,path:file,lockedByUserId:'owner',lockedBySessionId:session,baseRevisionId:data.revision.id});
        const command={expectedSha256:data.stats.sha256,baseRevisionId:data.revision.id,sessionId:session,lockId:lock.lock.id,idempotencyKey:crypto.randomUUID()};
        const saved=await post(file,`base64:${bytes.toString('base64')}`,command);assert.equal(saved.status,200,JSON.stringify(saved.body));
        const repeated=await post(file,`base64:${bytes.toString('base64')}`,command);assert.equal(repeated.status,200);assert.deepEqual(repeated.body.data,saved.body.data);
        const locked=await post(file,`base64:${bytes.toString('base64')}`,{...command,sessionId:'foreign'});assert.equal(locked.status,423);assert.equal(locked.body.code,'FILE_LOCKED');
        const invalid=await post(file,'invalid DOCX',command);assert.equal(invalid.status,422);assert.equal(invalid.body.code,'DOCX_INVALID_PACKAGE');
        const stale=await post(file,`base64:${bytes.toString('base64')}`,{...command,expectedSha256:'f'.repeat(64),idempotencyKey:crypto.randomUUID()});assert.equal(stale.status,409);assert.equal(stale.body.code,'FILE_REVISION_CONFLICT');
        assert((await readFile(path.join(root,file))).equals(bytes));
      });
      await check('real unregistered ordinary file and manual empty Markdown creation preserve existing positive behavior',async()=>{
        for(const extension of ['log','md']){const file=`physical-${crypto.randomUUID()}.${extension}`,body=extension==='md'?'':'ordinary text';
          const result=await post(file,body,{createOnly:true});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(await readFile(path.join(root,file),'utf8'),body);}
      });
      await check('real missing schema, read-only user and root file target cannot fall back to raw writes',async()=>{
        const native=await seed(`no-rights-${crypto.randomUUID()}.md`);const denied=await post(native.path,'replace',{},'member');assert.equal(denied.status,403);
        assert.equal((await post('.','replace')).status,400);const beforeLedger=await ledger();
        await admin.query('ALTER TABLE collaboration_documents RENAME COLUMN yjs_state_lifecycle TO fixture_missing_lifecycle');
        try{const unavailable=await post(`schema-${crypto.randomUUID()}.docx`,'invalid DOCX');assert.equal(unavailable.status,500);assert.equal(await ledger(),beforeLedger);}
        finally{await admin.query('ALTER TABLE collaboration_documents RENAME COLUMN fixture_missing_lifecycle TO yjs_state_lifecycle');}
      });
      await check('real kernel precedes a bounded shared read and prevents exclusive admission during catalogue inspection',async()=>{
        const file=`probe-${crypto.randomUUID()}.docx`,target=await seed(file);let fired=false;
        const foreign=await ownClient();
        before=async(client,sql,values)=>{if(sql.includes('FROM collaboration_documents d LEFT JOIN')&&values[0]===workspaceId){
          before=undefined;fired=true;assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
          assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout,'5s');assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout,'50ms');
          await foreign.query('BEGIN');assert.equal((await foreign.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',[collaborationAdmissionLockKey(workspaceId)])).rows[0].locked,false);await foreign.query('ROLLBACK');
          const lockfile=path.join(dataRoot,'canvas-file-locks',`${crypto.createHash('sha256').update(workspaceId).digest('hex')}.lock`);
          const probe=spawn('python3',['-I','-c','import fcntl,sys; f=open(sys.argv[1],"r"); fcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)',lockfile],{stdio:['ignore','ignore','pipe']});
          let output='';probe.stderr.on('data',data=>{output+=String(data);});const code=await new Promise<number|null>((resolve,reject)=>{probe.once('error',reject);probe.once('close',resolve);});
          assert.notEqual(code,0);assert.match(output,/BlockingIOError/u,'actual cross-process kernel lock is held before the catalogue read');
        }};
        try{const result=await post(file,'invalid DOCX');assert.equal(result.status,409);assert(fired);assert.equal((await native(target.id)).length>0,true);}
        finally{before=undefined;await foreign.end();clients.delete(foreign);}
      });
      await check('real foreign exclusive and active reservation yield finite Busy with no dispatch',async()=>{
        const foreign=await ownClient();try{await foreign.query('SELECT pg_advisory_lock($1::bigint)',[collaborationAdmissionLockKey(workspaceId)]);
          const result=await post(`foreign-${crypto.randomUUID()}.docx`,'invalid DOCX');assert.equal(result.status,409);assert.equal(result.body.code,'NATIVE_FILE_WRITE_BUSY');
        }finally{await foreign.end();clients.delete(foreign);}
        const target=`reserved-${crypto.randomUUID()}.docx`,requestId=crypto.randomUUID(),actionPayloadText=JSON.stringify({fixture:'predispatch'});
        const admission=createCollaborationAdmissionService({openConnection:openDb});
        await admission.reserve({requestId,actorId:'owner',action:'move',actionPayloadText,
          actionDigest:collaborationAdmissionActionDigest('move',actionPayloadText),
          scopes:[{workspaceId,organizationId:'principal-org',path:target,kind:'exact'}],expectedDocuments:[]});
        const result=await post(target,'invalid DOCX');assert.equal(result.status,409);assert.equal(result.body.code,'NATIVE_FILE_WRITE_BUSY');
      });
      await check('public shaped ALS lease is only a refusal and old owned internal DOCX caller retains its separate contract',async()=>{
        await assert.rejects(withWorkspaceFileLifecycleLeases(new Map([[workspaceId,{active:true,verify:async()=>true}]]),()=>preflight({workspace,path:'anything.docx'})),{code:'NATIVE_FILE_WRITE_BUSY'});
        const bytes=await createEmptyDocx(),file=`owned-${crypto.randomUUID()}.docx`;
        await withWorkspaceFileLifecycleGuard({workspaceId,paths:[file]},async()=>{
          const result=await writeWorkspaceFileContent({workspace,fileOptions:{workspace},actorUserId:'owner',actorSessionId:'owned-fixture',path:file,content:bytes,createOnly:true,idempotencyKey:crypto.randomUUID()});
          assert.equal(result.stats.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert((await readFile(path.join(root,file))).equals(bytes));
        });
      });
      await check('actual successful preflight COMMIT answer loss disposes B and forbids file publication without replay',async()=>{
        const file=`read-loss-${crypto.randomUUID()}.docx`;let backend=0,fired=false,laterQueries=0;
        before=async()=>{if(fired)laterQueries++;};
        after=async(client,sql)=>{if(sql==='SET TRANSACTION READ ONLY')backend=Number(Reflect.get(client,'processID'));
          if(sql==='COMMIT'&&backend===Number(Reflect.get(client,'processID'))){after=undefined;fired=true;throw new Error('Owned lost actual preflight COMMIT reply');}};
        try{const result=await post(file,'invalid DOCX');assert.equal(result.status,503);assert.equal(result.body.code,'NATIVE_FILE_WRITE_READ_UNCONFIRMED');
          assert(fired);assert.equal(laterQueries,0,'no recovery grants cached preflight success');await assert.rejects(stat(path.join(root,file)),{code:'ENOENT'});
          let remaining=1;for(let i=0;i<40&&remaining;i++){remaining=Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE pid=$1',[backend])).rows[0].n);if(remaining)await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(remaining,0);
        }finally{before=undefined;after=undefined;}
      });
      assert.equal(fetches,0);console.log(`Native write predispatch PG18: ${cases} genuine POST/native/Office/kernel/COMMIT families passed.`);
    }finally{before=undefined;after=undefined;actualPool.connect=originalConnect;}
  } finally {
    globalThis.fetch=originalFetch;
    try { if(pool) await pool.end(); }
    finally {
      try { for(const client of clients) await client.end(); }
      finally {
        try { if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);} }
        finally {await control.end();await rm(dataRoot,{recursive:true,force:true});
          for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}
      }
    }
  }
}
main().catch(error=>{console.error('Owned native write predispatch fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,message:error instanceof Error?error.message:'unknown'});process.exitCode=1;});
