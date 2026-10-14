import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { AuthenticatedNativeSessionTransport } from '../app/lib/collaboration/authenticated-native-session-transport';
import type { ExistingNativeCollaborationSession, ExistingNativeSessionIdentity, ExistingNativeSessionRequestAccess } from '../app/lib/collaboration/native-session-state-reader';

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
  const schema = `native_transport_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_transport_[a-f0-9]{32}$/u);
  const workspaceId = `native-transport-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-transport-access-'));
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=request-principal-fixture` });
    client.on('error',()=>undefined); // transaction_timeout may terminate this owned fixture client.
    clients.add(client); await client.connect(); return client;
  };
  const connection = (client: Client): SqlConnection => ({
    get: async (sql,values) => (await client.query(sql,values)).rows[0],
    all: async (sql,values) => (await client.query(sql,values)).rows,
    run: async (sql,values) => ({ changes:(await client.query(sql,values)).rowCount ?? 0 }),
    close: () => { throw new Error('Principal must never close caller-owned connection.'); },
  });
  const endClient = async (client:Client) => { await client.end(); clients.delete(client); };
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
        VALUES($1,'principal-org','personal',$2,$2,$3,'active',100,100)`,[`personal-${userId}-${workspaceId}`,userId,`users/${userId}/workspace`]);
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
    const { auth } = await import('../app/lib/auth');
    const { captureAuthenticatedNativeSessionTransportOnConnection:enroll, withAuthenticatedNativeSessionTransportOnConnection:phase,
      disposeAuthenticatedNativeSessionTransport:dispose } = await import('../app/lib/collaboration/authenticated-native-session-transport');
    const { assertExistingNativeCollaborationSessionCurrentOnConnection:current,
      inspectExistingNativeCollaborationSessionOnConnection:inspect } = await import('../app/lib/collaboration/native-session-state-reader');
    const { createPlainTextYDoc,createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const request = async (userId='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if(cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[userId],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/collaboration/session',{method:'POST',headers});
    };
    const transaction = async <T>(operation:(db:SqlConnection,client:Client)=>Promise<T>,begin='BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') => {
      const client=await ownClient();await client.query(begin);
      try{return await operation(connection(client),client);}
      finally{await client.query('ROLLBACK').catch(()=>undefined);await endClient(client);}
    };
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Native transport passed: ${name}`);};
    const code=(expected:string)=>(error:unknown)=>{
      const actual=error&&typeof error==='object'?Reflect.get(error,'code'):undefined;
      if(actual!==expected)console.log('Expected fixture error code differed:',{expected,actualCode:typeof actual==='string'?actual.slice(0,128):null});
      return actual===expected;
    };
    const seed=async(label:string,representation:ExistingNativeSessionIdentity['representation']='plain_text',options:{empty?:boolean;doc?:InstanceType<typeof Y.Doc>;profile?:boolean}={})=>{
      const documentId=`doc-${crypto.randomUUID()}`,lineageId=`lineage-${crypto.randomUUID()}`,filePath=`${label}.md`;
      const doc=options.doc??(representation==='plain_text'?createPlainTextYDoc(options.empty?'':'ABC'):createRichMarkdownYDoc(options.empty?'':'# Rich native\n',representation));
      const update=Buffer.from(Y.encodeStateAsUpdate(doc)),vector=Buffer.from(Y.encodeStateVector(doc)),proof=collaborationStateProof(doc,Y);
      if(!options.doc) doc.destroy();
      const sequence=options.empty?0:7;
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','principal-org',$3,'active',100)`,[lineageId,workspaceId,filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization','principal-org',$4,'yjs',$5,'initialized','active',100,100)`,[documentId,lineageId,workspaceId,filePath,sequence]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,'principal-org',$3,$4,1,1,$5,$6,$7,100,0,NULL,NULL,NULL,$8,$9,0,'active')`,
      [documentId,workspaceId,filePath,representation,update,vector,sequence,options.profile?'crlf':'lf',options.profile?1:0]);
      const identity:ExistingNativeSessionIdentity={documentId,lineageId,workspaceId,organizationId:'principal-org',path:filePath,lifecycleGeneration:1,representation,schemaVersion:1};
      return{identity,update,vector,proof};
    };
    const stored=async(identity:ExistingNativeSessionIdentity)=>(await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1',[identity.documentId])).rows[0];
    const input=(identity:ExistingNativeSessionIdentity)=>({path:identity.path,expectedIdentity:identity});
    const native=await seed(' transport native .md');
    const permissionRow=async(client:Client=admin)=>(await client.query("SELECT can_write_team_workspace FROM organization_user_permissions WHERE user_id='member'")).rows[0].can_write_team_workspace;
    const withWriter=async(operation:()=>Promise<void>)=>{
      await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
      try{await operation();}finally{await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");}
    };
    const captured=async(userId='owner',permission:'canRead'|'canWrite'='canWrite',cookie=false)=>
      transaction(db=>request(userId,cookie).then(actual=>enroll(db,actual,{workspaceId,maxPermission:permission})));
    const read=async<T>(transport:AuthenticatedNativeSessionTransport,consumer:(native:ExistingNativeCollaborationSession,access:ExistingNativeSessionRequestAccess)=>Promise<T>,
      permission:'canRead'|'canWrite'='canRead')=>transaction(db=>phase(db,transport,{permission,...input(native.identity)},consumer));
    const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
    const bounded=async(promise:Promise<void>)=>{let timer!:ReturnType<typeof setTimeout>;try{
      await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture phase did not enter within eight seconds.')),8000);})]);
    }finally{clearTimeout(timer);}};
    await check('actual Cookie/Bearer Team enrollment and fresh native sole-B read/write phases',async()=>{
      for(const cookie of [true,false])for(const userId of ['owner','member']){
        assert.equal((await auth.api.getSession({headers:(await request(userId,cookie)).headers}))?.session.id,`session-${userId}`);
        const cap=await captured(userId,userId==='owner'?'canWrite':'canRead',cookie);
        assert(Object.isFrozen(cap));assert.deepEqual(Reflect.ownKeys(cap),[]);assert.equal(JSON.stringify(cap),'{}');
        for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const){
          const target=await seed(`format-${crypto.randomUUID()}`,representation,{empty:true,profile:true}),before=await stored(target.identity);
          await transaction(db=>phase(db,cap,{permission:userId==='owner'?'canWrite':'canRead',...input(target.identity)},async(doc,access)=>{
            assert.equal(access.userId,userId);assert.equal(access.sessionId,`session-${userId}`);assert.equal(access.workspace.workspaceId,workspaceId);
            assert.equal(access.workspace.permissions.canWrite,userId==='owner');assert.equal(doc.snapshot.stateProof,target.proof);
            assert(doc.snapshot.hasBom);assert.equal(doc.snapshot.newlineStyle,'crlf');await access.assertCurrent();
            assert.equal(inspect(db,doc,s=>s.content.kind),representation==='plain_text'?'plain_text':'rich_text');
          }));assert.deepEqual(await stored(target.identity),before);
        }
        await dispose(cap);
      }
    });
    await check('request Headers/options and phase identity are captured before first await',async()=>{
      const actual=await request('owner',true),options={workspaceId,maxPermission:'canWrite' as 'canRead'|'canWrite'};
      actual.headers.set('x-preserved-unused','original');actual.headers.set('origin','http://localhost');
      const cap=await transaction(db=>{const pending=enroll(db,actual,options);actual.headers.set('cookie','invalid');
        actual.headers.set('x-canvas-workspace-id','invalid');options.workspaceId='invalid';options.maxPermission='canRead';return pending;});
      await transaction(db=>{const original={permission:'canWrite' as 'canRead'|'canWrite',...input({...native.identity})};
        const pending=phase(db,cap,original,async(doc,access)=>{assert.equal(doc.snapshot.documentId,native.identity.documentId);await access.assertCurrent();});
        original.path='changed.md';original.permission='canRead';assert(Reflect.set(original.expectedIdentity,'documentId','changed'));return pending;});await dispose(cap);
    });
    await check('bounded original URL/header bytes/count and own-data options reject before SQL',async()=>{
      for(const kind of ['url','bytes','count','getter','actor','prototype'])await transaction(async(db)=>{
        let calls=0;const observed:SqlConnection={...db,get:async(sql,args)=>{calls++;return db.get(sql,args);}};
        const actual=await request();const options:unknown=kind==='getter'?{workspaceId,get maxPermission(){assert.fail('getter invoked');return 'canWrite';}}
          :kind==='actor'?{workspaceId,maxPermission:'canWrite',actorId:'owner'}:kind==='prototype'?Object.create({workspaceId,maxPermission:'canWrite'}):{workspaceId,maxPermission:'canWrite'};
        if(kind==='bytes')actual.headers.set('x-big','x'.repeat(65536));if(kind==='count')for(let i=0;i<128;i++)actual.headers.set(`x-header-${i}`,'v');
        const selected=kind==='url'?new NextRequest(`http://localhost/${'x'.repeat(8193)}`,{headers:actual.headers}):actual;
        await assert.rejects(enroll(observed,selected,options as Parameters<typeof enroll>[2]),code(['url','bytes','count'].includes(kind)?'NATIVE_TRANSPORT_TOO_LARGE':'NATIVE_TRANSPORT_INVALID'));
        assert.equal(calls,0);
      });
      const actual=await request();actual.headers.set('x-boundary','x'.repeat(65000));
      const cap=await transaction(db=>enroll(db,actual,{workspaceId,maxPermission:'canWrite'}));await dispose(cap);
    });
    await check('read maximum cannot be upgraded by canWrite entry flags or later actual ACL improvement',async()=>{
      const cap=await captured('member','canRead');assert.equal(await permissionRow(),0);
      await withWriter(async()=>{
        await read(cap,async(_doc,access)=>{assert.equal(access.workspace.permissions.canWrite,true);await access.assertCurrent();});
        let visits=0;await assert.rejects(read(cap,async()=>{visits++;},'canWrite'),code('NATIVE_TRANSPORT_ACCESS_DENIED'));assert.equal(visits,0);
      });await dispose(cap);
    });
    await check('actual fresh write permission and pure write-loss final authorization',async()=>withWriter(async()=>{
      const cap=await captured('member','canWrite');const before=await stored(native.identity);
      await assert.rejects(transaction(db=>phase(db,cap,{permission:'canWrite',...input(native.identity)},async()=>{
        await db.run("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");return 'unpublishable';
      })),code('PRINCIPAL_ACCESS_DENIED'));assert.equal(await permissionRow(),1);assert.deepEqual(await stored(native.identity),before);await dispose(cap);
      const cap2=await captured('member','canWrite');await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
      let visits=0;await assert.rejects(read(cap2,async()=>{visits++;},'canWrite'),code('PRINCIPAL_ACCESS_DENIED'));assert.equal(visits,0);await dispose(cap2);
    }));
    await check('canRead diagnosis remains read-only proof after pure write loss',async()=>withWriter(async()=>{
      const cap=await captured('member','canRead');await transaction(db=>phase(db,cap,{permission:'canRead',...input(native.identity)},async(_doc,access)=>{
        assert.equal(access.workspace.permissions.canWrite,true);await db.run("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        await access.assertCurrent();assert.equal(access.workspace.permissions.canWrite,true);
      }));await dispose(cap);
    }));
    await check('actual token rotation with same user/session rejects both original Cookie and Bearer',async()=>{
      for(const cookie of [true,false]){
        const cap=await captured('owner','canWrite',cookie),old=tokens.owner;
        try{await seedSession();let visits=0;await assert.rejects(read(cap,async()=>{visits++;}),code('PRINCIPAL_AUTH_REVOKED'));assert.equal(visits,0);}
        finally{await admin.query("UPDATE session SET token=$1 WHERE id='session-owner'",[old]);tokens.owner=old;await dispose(cap);}
      }
    });
    await check('changed actual user/session behind original headers cannot switch captured identity',async()=>{
      for(const kind of ['session','user']){
        const cap=await captured(),token=tokens.owner;
        try{
          await admin.query("DELETE FROM session WHERE id='session-owner'");
          await admin.query(`INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)`,
            [kind==='session'?'session-other':'session-owner',token,kind==='user'?'member':'owner',Date.now()+3600000,now]);
          await assert.rejects(read(cap,async()=>assert.fail()),code('NATIVE_TRANSPORT_SCOPE_CHANGED'));
        }finally{await admin.query("DELETE FROM session WHERE id IN('session-owner','session-other')");await seedSession();await dispose(cap);}
      }
    });
    await check('fresh ACL ban seat expiry and deleted session revoke real original request',async()=>{
      const scenarios=[
        ["UPDATE organization_user_permissions SET status='disabled' WHERE user_id='member'","UPDATE organization_user_permissions SET status='active' WHERE user_id='member'"],
        ["UPDATE \"user\" SET banned=1,ban_expires=1 WHERE id='member'","UPDATE \"user\" SET banned=0,ban_expires=NULL WHERE id='member'"],
        ["UPDATE team_memberships SET status='active' WHERE id='inactive-seat';UPDATE organization_user_permissions SET status='active' WHERE user_id='inactive'","UPDATE team_memberships SET status='suspended' WHERE id='inactive-seat';UPDATE organization_user_permissions SET status='disabled' WHERE user_id='inactive'"],
        ["UPDATE session SET expires_at=1 WHERE id='session-member'",`UPDATE session SET expires_at=${Date.now()+3600000} WHERE id='session-member'`],
      ];
      for(const[change,restore]of scenarios){const cap=await captured('member','canRead');try{await admin.query(change);let visits=0;
        // BetterAuth's actual seat hook rejects disabled membership before the
        // workspace callback, so ACL/ban/seat/expiry all revoke this auth path.
        await assert.rejects(read(cap,async()=>{visits++;}),code('PRINCIPAL_AUTH_REVOKED'));assert.equal(visits,0);}
        finally{await admin.query(restore);await seedSession('member');await dispose(cap);}}
      const cap=await captured('member','canRead');await admin.query("DELETE FROM session WHERE id='session-member'");
      try{await assert.rejects(read(cap,async()=>assert.fail()),code('PRINCIPAL_AUTH_REVOKED'));}finally{await seedSession('member');await dispose(cap);}
    });
    await check('workspace root/type/owner/project/customer identity changes never rebind old transport',async()=>{
      await admin.query(`INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at)
        VALUES('another-customer','principal-org','Other','other','active',100,100)`);
      await admin.query(`INSERT INTO canvas_projects(id,organization_id,name,slug,status,created_at,updated_at)
        VALUES('another-project','principal-org','Other','other','active',100,100)`);
      const changes=[['root_relative_path',`organizations/principal-org/changed-${crypto.randomUUID()}`],['type','team'],
        ['owner_user_id','member'],['project_id','another-project'],['customer_id','another-customer']];
      for(const[field,value]of changes){stage=`workspace identity ${field}`;const cap=await captured(),before=(await admin.query('SELECT * FROM canvas_workspaces WHERE id=$1',[workspaceId])).rows[0];
        try{await admin.query(`UPDATE canvas_workspaces SET ${field}=$2 WHERE id=$1`,[workspaceId,value]);await assert.rejects(read(cap,async()=>assert.fail()),code(field==='type'?'NATIVE_SESSION_SCOPE_CHANGED':'NATIVE_TRANSPORT_SCOPE_CHANGED'));}
        finally{await admin.query(`UPDATE canvas_workspaces SET ${field}=$2 WHERE id=$1`,[workspaceId,before[field]]);await dispose(cap);}}
      const cap=await captured(),oldData=process.env.DATA;process.env.DATA=path.join(dataRoot,'different');
      try{await assert.rejects(read(cap,async()=>assert.fail()),code('NATIVE_TRANSPORT_SCOPE_CHANGED'));}finally{process.env.DATA=oldData;await dispose(cap);}
    });
    await check('foreign actual organization and disabled workspace deny before any native consumer',async()=>{
      const foreign=`foreign-${crypto.randomUUID()}`;
      await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
        VALUES($1,'owner','team',1,200,200)`,[foreign]);
      for(const kind of ['organization','status']){stage=`foreign workspace ${kind}`;const cap=await captured();let visits=0;
        try{if(kind==='organization')await admin.query('UPDATE canvas_workspaces SET organization_id=$2 WHERE id=$1',[workspaceId,foreign]);
          else await admin.query("UPDATE canvas_workspaces SET status='disabled' WHERE id=$1",[workspaceId]);
          await assert.rejects(read(cap,async()=>{visits++;}),code('PRINCIPAL_ACCESS_DENIED'));assert.equal(visits,0);
        }finally{await admin.query("UPDATE canvas_workspaces SET organization_id='principal-org',status='active' WHERE id=$1",[workspaceId]);await dispose(cap);}
      }
      await admin.query('DELETE FROM canvas_organization_settings WHERE organization_id=$1',[foreign]);
    });
    await check('caller-owned wrong isolation and foreign schema deny without fallback',async()=>{
      for(const begin of ['BEGIN READ ONLY','BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE']){
        const cap=await captured();await assert.rejects(transaction(db=>phase(db,cap,{permission:'canRead',...input(native.identity)},async()=>assert.fail()),begin),code('PRINCIPAL_SCOPE_CHANGED'));await dispose(cap);
      }
      const cap=await captured();await assert.rejects(transaction(async(db)=>{await db.run('SET LOCAL search_path=pg_catalog');await phase(db,cap,{permission:'canRead',...input(native.identity)},async()=>assert.fail());}),code('PRINCIPAL_SCOPE_CHANGED'));await dispose(cap);
    });
    await check('native readiness missing state permanent quarantine and generation remain strict',async()=>{
      for(const kind of ['missing','quarantine','generation']){
        const target=await seed(`guard-${kind}`),cap=await captured();
        if(kind==='missing')await admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1',[target.identity.documentId]);
        if(kind==='quarantine')await admin.query("UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1",[target.identity.documentId]);
        if(kind==='generation')await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1',[target.identity.documentId]);
        await assert.rejects(transaction(db=>phase(db,cap,{permission:'canRead',...input(target.identity)},async()=>assert.fail())),
          code(kind==='missing'?'NATIVE_SESSION_STATE_MISSING':kind==='quarantine'?'NATIVE_SESSION_QUARANTINED':'NATIVE_SESSION_SCOPE_CHANGED'));await dispose(cap);
      }
    });
    await check('actual peer ACL session and workspace writes conflict with genuine held B rows',async()=>{
      const cap=await captured('member','canRead');await transaction(db=>phase(db,cap,{permission:'canRead',...input(native.identity)},async(_doc,access)=>{
        for(const[sql,values]of [["UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'",[]],
          ["UPDATE session SET expires_at=1 WHERE id='session-member'",[]],["UPDATE canvas_workspaces SET root_relative_path='changed' WHERE id=$1",[workspaceId]]] as const){
          const peer=await ownClient();try{await peer.query('BEGIN');await assert.rejects(peer.query(sql,[...values]),code('55P03'));}
          finally{await peer.query('ROLLBACK');await endClient(peer);}}
        await access.assertCurrent();
      }));await dispose(cap);
    });
    await check('same object backend XID and exact search-path drift are fatal even when caught',async()=>{
      for(const kind of ['backend','xid','searchpath']){
        const cap=await captured();await assert.rejects(transaction(async(db,client)=>{
          const peer=await ownClient();await peer.query('BEGIN');let selected=client;
          const wrapped:SqlConnection={get:async(sql,args)=>(await selected.query(sql,args)).rows[0],all:async(sql,args)=>(await selected.query(sql,args)).rows,
            run:async(sql,args)=>({changes:(await selected.query(sql,args)).rowCount??0}),close:()=>assert.fail()};
          try{await phase(wrapped,cap,{permission:'canRead',...input(native.identity)},async(_doc,access)=>{
            if(kind==='backend')selected=peer;else if(kind==='xid')await wrapped.run('COMMIT;BEGIN');else await wrapped.run(`SET LOCAL search_path="${schema}", pg_catalog`);
            await assert.rejects(access.assertCurrent(),code('PRINCIPAL_SCOPE_CHANGED'));
          });}finally{await peer.query('ROLLBACK').catch(()=>undefined);await endClient(peer);}
        }),code('PRINCIPAL_SCOPE_CHANGED'));await dispose(cap);
      }
    });
    await check('callbacks returning throw null or undefined poison phase and every later retry',async()=>{
      for(const error of [null,undefined,new Error('consumer-only')]){
        const cap=await captured();await assert.rejects(read(cap,async()=>{throw error;}),error instanceof Error?e=>e===error:code('NATIVE_TRANSPORT_INVALID'));
        await assert.rejects(read(cap,async()=>assert.fail()));await dispose(cap);
      }
    });
    await check('opaque forgery copied capability wrong input and caught misuse poison active owner',async()=>{
      const original=await captured();await assert.rejects(read({...original} as AuthenticatedNativeSessionTransport,async()=>assert.fail()),code('NATIVE_TRANSPORT_REQUIRED'));await dispose(original);
      for(const kind of ['forgery','input','dispose-forgery']){
        const cap=await captured();await assert.rejects(transaction(db=>phase(db,cap,{permission:'canRead',...input(native.identity)},async()=>{
          if(kind==='dispose-forgery'){await assert.rejects(dispose({} as AuthenticatedNativeSessionTransport),code('NATIVE_TRANSPORT_REQUIRED'));return;}
          await assert.rejects(phase(db,kind==='forgery'?{} as AuthenticatedNativeSessionTransport:cap,
            kind==='input'?{permission:'canRead',path:'../invalid.md'}:{permission:'canRead',...input(native.identity)},async()=>assert.fail()));
        })),code(kind==='input'?'NATIVE_TRANSPORT_INVALID':'NATIVE_TRANSPORT_REQUIRED'));await dispose(cap);
      }
    });
    await check('retained facade getters and assertions reject and poison a later fresh native phase',async()=>{
      for(const mode of ['getter','assertion']){
        const cap=await captured();let old!:ExistingNativeSessionRequestAccess,assertion!:()=>Promise<void>;
        await read(cap,async(_doc,access)=>{old=access;assertion=access.assertCurrent;});
        await assert.rejects(read(cap,async()=>{if(mode==='getter')assert.throws(()=>old.workspace,code('NATIVE_TRANSPORT_REQUIRED'));
          else await assert.rejects(assertion(),code('NATIVE_TRANSPORT_REQUIRED'));}),code('NATIVE_TRANSPORT_REQUIRED'));await dispose(cap);
      }
    });
    await check('retained native capability still expires under the unchanged native Reader contract',async()=>{
      const cap=await captured();await transaction(async db=>{
        let retained!:ExistingNativeCollaborationSession;
        await phase(db,cap,{permission:'canRead',...input(native.identity)},async doc=>{retained=doc;});
        await assert.rejects(current(db,retained),code('NATIVE_SESSION_REQUIRED'));
      });await dispose(cap);
    });
    await check('old failed/disposed facade also poisons a different transport and connection successor',async()=>{
      for(const kind of ['same-connection','different-connection','failed','disposed']){
        const oldCap=await captured(),newCap=await captured();let old!:ExistingNativeSessionRequestAccess;
        const misuse=async()=>{assert.throws(()=>old.workspace,code(kind==='disposed'?'NATIVE_TRANSPORT_DISPOSED':kind==='failed'?'NATIVE_TRANSPORT_INVALID':'NATIVE_TRANSPORT_REQUIRED'));};
        if(kind==='same-connection')await assert.rejects(transaction(async db=>{
          await phase(db,oldCap,{permission:'canRead',...input(native.identity)},async(_doc,access)=>{old=access;});
          await db.run('ROLLBACK;BEGIN');await phase(db,newCap,{permission:'canRead',...input(native.identity)},misuse);
        }),code('NATIVE_TRANSPORT_REQUIRED'));
        else{
          await read(oldCap,async(_doc,access)=>{old=access;});
          if(kind==='failed')await assert.rejects(read(oldCap,async()=>{throw null;}),code('NATIVE_TRANSPORT_INVALID'));
          if(kind==='disposed')await dispose(oldCap);
          await assert.rejects(read(newCap,misuse),code(kind==='disposed'?'NATIVE_TRANSPORT_DISPOSED':kind==='failed'?'NATIVE_TRANSPORT_INVALID':'NATIVE_TRANSPORT_REQUIRED'));
        }
        await dispose(oldCap);await dispose(newCap);
      }
    });
    await check('detached facade assertion drains and rejects successful consumer return',async()=>{
      const cap=await captured();let settled=false;await assert.rejects(read(cap,async(_doc,access)=>{
        void access.assertCurrent().then(()=>{settled=true;},()=>{settled=true;});return 'not-published';
      }),code('NATIVE_TRANSPORT_DETACHED'));assert(settled);await dispose(cap);
    });
    await check('caught reentrant same capability and concurrent different connection poison original phase',async()=>{
      const cap=await captured();await assert.rejects(transaction(db=>phase(db,cap,{permission:'canRead',...input(native.identity)},async()=>{
        await transaction(second=>assert.rejects(phase(second,cap,{permission:'canRead',...input(native.identity)},async()=>assert.fail()),code('NATIVE_TRANSPORT_REENTRANT')));
      })),code('NATIVE_TRANSPORT_REENTRANT'));await dispose(cap);
    });
    await check('external dispose invalidates immediately and awaits entire native consumer',async()=>{
      const cap=await captured(),entered=gate(),release=gate();let disposed=false;
      const pending=read(cap,async()=>{entered.resolve();await release.promise;return 'not-published';});const rejected=assert.rejects(pending,code('NATIVE_TRANSPORT_DISPOSED'));
      let closing!:Promise<void>;try{await bounded(entered.promise);closing=dispose(cap).then(()=>{disposed=true;});await new Promise<void>(done=>setImmediate(done));assert.equal(disposed,false);}
      finally{release.resolve();await rejected;}await closing;assert(disposed);await dispose(cap);await assert.rejects(read(cap,async()=>assert.fail()),code('NATIVE_TRANSPORT_DISPOSED'));
    });
    await check('self-dispose rejects instead of awaiting own callback forever',async()=>{
      const cap=await captured();await assert.rejects(read(cap,async()=>{await assert.rejects(dispose(cap),code('NATIVE_TRANSPORT_REENTRANT'));}),code('NATIVE_TRANSPORT_DISPOSED'));await dispose(cap);
    });
    await check('facade is closed through actual Reader Principal and factory completion windows',async()=>{
      for(const window of [2,3]){
        const cap=await captured();let reads=0,baseline=0,checks=0,armed=false,attempted=false,old!:ExistingNativeSessionRequestAccess;
        await assert.rejects(transaction(async(db,client)=>{
          const wrapped:SqlConnection={...db,get:async(sql,args)=>{const row=(await client.query(sql,args)).rows[0];
            if(sql.includes('SELECT * FROM')&&sql.includes('collaboration_yjs_states WHERE'))reads++;
            if(armed&&reads===baseline+3&&sql.includes('SELECT expires_at FROM')&&++checks===window){attempted=true;assert.throws(()=>old.userId,code('NATIVE_TRANSPORT_REQUIRED'));}return row;}};
          await phase(wrapped,cap,{permission:'canRead',...input(native.identity)},async(_doc,access)=>{old=access;baseline=reads;armed=true;});
        }),code('NATIVE_TRANSPORT_REQUIRED'));assert(attempted);await dispose(cap);
      }
    });
    await check('same-name namespace OID replacement in final factory window is rejected',async()=>{
      const cap=await captured();let switched=false,realmReads=0;
      await assert.rejects(transaction(async(db,client)=>{
        const wrapped:SqlConnection={...db,get:async(sql,args)=>{
          if(sql.includes('to_regnamespace(current_schema())')&&++realmReads===3){
            switched=true;await client.query(`ALTER SCHEMA "${schema}" RENAME TO "${schema}_old"`);await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`ALTER TABLE "${schema}_old".canvas_workspaces SET SCHEMA "${schema}"`);
          }return(await client.query(sql,args)).rows[0];}};
        await phase(wrapped,cap,{permission:'canRead',...input(native.identity)},async()=>{});
      }),code('NATIVE_TRANSPORT_SCOPE_CHANGED'));assert(switched);await dispose(cap);assert.equal((await admin.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    });
    await check('final whole-factory binding rejects a switched real backend despite identical workspace rows',async()=>{
      const cap=await captured();let switched=false,realmReads=0;
      await assert.rejects(transaction(async(_db,client)=>{
        const peer=await ownClient();await peer.query('BEGIN');let selected=client;
        const wrapped:SqlConnection={get:async(sql,args)=>{
          if(sql.includes('to_regnamespace(current_schema())')&&++realmReads===3){switched=true;selected=peer;}
          return(await selected.query(sql,args)).rows[0];},all:async(sql,args)=>(await selected.query(sql,args)).rows,
          run:async(sql,args)=>({changes:(await selected.query(sql,args)).rowCount??0}),close:()=>assert.fail()};
        try{await phase(wrapped,cap,{permission:'canRead',...input(native.identity)},async()=>{});}
        finally{await peer.query('ROLLBACK');await endClient(peer);}
      }),code('NATIVE_TRANSPORT_SCOPE_CHANGED'));assert(switched);await dispose(cap);
    });
    await check('dispose awaits blocked actual Principal final response after native consumer closes',async()=>{
      const cap=await captured(),entered=gate(),release=gate();let reads=0,baseline=0,checks=0,armed=false,finished=false;
      const pending=transaction(async(db,client)=>{
        const wrapped:SqlConnection={...db,get:async(sql,args)=>{const row=(await client.query(sql,args)).rows[0];
          if(sql.includes('SELECT * FROM')&&sql.includes('collaboration_yjs_states WHERE'))reads++;
          if(armed&&reads===baseline+3&&sql.includes('SELECT expires_at FROM')&&++checks===3){entered.resolve();await release.promise;}return row;}};
        return phase(wrapped,cap,{permission:'canRead',...input(native.identity)},async()=>{baseline=reads;armed=true;return 'not-published';});
      });const rejected=assert.rejects(pending,code('NATIVE_TRANSPORT_DISPOSED'));
      let closing!:Promise<void>;try{await bounded(entered.promise);closing=dispose(cap).then(()=>{finished=true;});await new Promise<void>(done=>setImmediate(done));assert.equal(finished,false);}
      finally{release.resolve();await rejected;}await closing;assert(finished);
    });
    await check('write loss during final Reader Principal windows rejects returned value',async()=>withWriter(async()=>{
      for(const window of [2,3]){
        const cap=await captured('member','canWrite');let reads=0,baseline=0,checks=0,armed=false,changed=false;
        await assert.rejects(transaction(async(db,client)=>{
          const wrapped:SqlConnection={...db,get:async(sql,args)=>{
            if(armed&&reads===baseline+3&&sql.includes('SELECT id,organization_id,type,status,owner_user_id,project_id,root_relative_path')&&++checks===window){
              changed=true;await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");}
            const row=(await client.query(sql,args)).rows[0];if(sql.includes('SELECT * FROM')&&sql.includes('collaboration_yjs_states WHERE'))reads++;return row;}};
          await phase(wrapped,cap,{permission:'canWrite',...input(native.identity)},async()=>{baseline=reads;armed=true;return 'not-published';});
        }),code('PRINCIPAL_ACCESS_DENIED'));assert(changed);assert.equal(await permissionRow(),1);await dispose(cap);
      }
    }));
    await check('actual five-second principal SQL lifetime is unchanged and cannot publish an expired callback',async()=>{
      const cap=await captured(),before=await stored(native.identity);let entered=false;
      await assert.rejects(transaction(db=>phase(db,cap,{permission:'canRead',...input(native.identity)},async(_doc,access)=>{
        const settings=await db.get("SELECT current_setting('transaction_timeout') AS duration,current_setting('lock_timeout') AS wait") as Record<string,unknown>;
        assert.equal(Reflect.get(settings,'duration'),'5s');assert.equal(Reflect.get(settings,'wait'),'50ms');entered=true;
        await new Promise<void>(done=>setTimeout(done,5100));await access.assertCurrent();return 'not-published';
      })));assert(entered);assert.deepEqual(await stored(native.identity),before);await assert.rejects(read(cap,async()=>assert.fail()));await dispose(cap);
    });
    await check('actual trusted Solo Cookie/Bearer owner and unauthorized member',async()=>{
      const soloBody=Buffer.from(JSON.stringify({...claims,edition:'solo',seatLimit:1,quotas:{users:1},entitlementsVersion:7})).toString('base64url');
      process.env.CANVAS_LICENSE_CERT=`${header}.${soloBody}.${crypto.sign('RSA-SHA256',Buffer.from(`${header}.${soloBody}`),keys.privateKey).toString('base64url')}`;
      const solo=await getLicenseStatus();assert.equal(solo.licensed,true);assert.equal(solo.edition,'solo');
      for(const cookie of [true,false]){const cap=await captured('owner','canWrite',cookie);await read(cap,async(_doc,access)=>{assert.equal(access.userId,'owner');await access.assertCurrent();},'canWrite');await dispose(cap);
        await assert.rejects(captured('member','canRead',cookie),code('PRINCIPAL_AUTH_REVOKED'));}
    });
    assert.equal(fetches,0);
    console.log(`Authenticated native transport PG18: ${cases} genuine Cookie/Bearer/Team/Solo/lifetime families passed; inactive, no Session/WS activation.`);
  }finally{
    globalThis.fetch=originalFetch;
    try{if(pool)await pool.end();}finally{
      try{for(const client of clients)await client.end();}finally{
        try{if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);}}
        finally{await control.end();await rm(dataRoot,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}
      }
    }
  }
}
main().catch(error=>{console.error('Owned authenticated native transport fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  constraint:error&&typeof error==='object'?Reflect.get(error,'constraint')??null:null});process.exitCode=1;});
