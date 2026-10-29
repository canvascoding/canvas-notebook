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
import type { ExistingNativeSessionIdentity } from '../app/lib/collaboration/native-session-state-reader';

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
  const schema = `native_owned_peer_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_owned_peer_[a-f0-9]{32}$/u);
  const workspaceId = `native-transport-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-owned-peer-'));
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
      disposeAuthenticatedNativeSessionTransport:dispose, withAuthenticatedOwnedNativeSessionTransportOnConnection:owned,
      isAuthenticatedNativeSessionTransportBusy:isBusy } = await import('../app/lib/collaboration/authenticated-native-session-transport');
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
    const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
    const bounded=async(promise:Promise<void>)=>{let timer!:ReturnType<typeof setTimeout>;try{
      await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture phase did not enter within eight seconds.')),8000);})]);
    }finally{clearTimeout(timer);}};

    const {createCollaborationRoomOwnerSession}=await import('../app/lib/collaboration/room-owner');
    const {createCollaborationAdmissionService}=await import('../app/lib/collaboration/room-admission');
    const {createRepresentationAdmissionRequest}=await import('../app/lib/collaboration/representation-admission-contract');
    const {loadCollaborationState}=await import('../app/lib/collaboration/persistence');
    const {collaborationUpdateStateProof}=await import('../app/lib/collaboration/state-proof');
    const {openDb}=await import('../app/lib/db');
    const ownerClient=await ownClient(), owner=await createCollaborationRoomOwnerSession(ownerClient);
    const {lineageId:_lineage,...scope}=native.identity;
    const fence=await owner.acquire(scope);
    const nativeBefore=await stored(native.identity);
    const observe=async<T>(cap:AuthenticatedNativeSessionTransport,consume:(access:import('../app/lib/collaboration/authenticated-native-session-transport').AuthenticatedOwnedNativeSessionAccess)=>Promise<T>,
      permission:'canRead'|'canWrite'='canRead')=>transaction(db=>owned(db,cap,{permission,identity:native.identity,ownerFence:fence},consume));
    try{
      const { createAuthenticatedNativePeer } = await import('../app/lib/collaboration/authenticated-native-peer');
      const { measureDocumentOperation, withDocumentOperationMetricObserver } = await import('../app/lib/observability/document-operation-metrics');
      const peerFor = async (userId='owner', maximum:'canRead'|'canWrite'='canWrite', permission:'read'|'write'='write', cookie=false) => {
        const transport=await captured(userId,maximum,cookie);
        return createAuthenticatedNativePeer({transport,identity:native.identity,claims:{...native.identity,provider:'yjs',
          userId,sessionId:`session-${userId}`,permission,issuedAt:Date.now(),expiresAt:Date.now()+600000}});
      };
      for(const cookie of [true,false])await check(`actual ${cookie?'Cookie':'Bearer'} writer status uses one bounded authorization phase`,async()=>{
        const peer=await peerFor('owner','canWrite','write',cookie);
        try{
          const measurements:import('../app/lib/observability/document-operation-metrics').DocumentOperationMeasurement[]=[];
          const result=await withDocumentOperationMetricObserver(value=>measurements.push(value),()=>
            measureDocumentOperation('read','request',()=>peer.check(fence)));
          assert.equal(result.quarantined,false);assert.equal(result.workspace.permissions.canWrite,true);
          assert.equal(measurements.length,1);
          console.log('Actual peer status measurement:',{cookie,statements:measurements[0].statements,
            checkouts:measurements[0].checkouts,authorizationChecks:measurements[0].phases.find(value=>value.phase==='authorization')?.calls});
          assert.equal(measurements[0].phases.find(value=>value.phase==='authorization')?.calls,2,
            'Status owns one genuine Principal with its initial and final fresh Current.');
          assert.equal(measurements[0].openConnectionsAtCompletion,0);assert.equal(measurements[0].openQueriesAtCompletion,0);
          // Status never replaces the distinct fresh canWrite phase before a live mutation.
          await peer.authorizeWrite(fence);
        }finally{await peer.dispose();}
      });
      await check('a read-only original transport cannot be promoted by forged writer claims',async()=>{
        const peer=await peerFor('owner','canRead','write');
        try{await assert.rejects(peer.check(fence),code('NATIVE_TRANSPORT_ACCESS_DENIED'));}
        finally{await peer.dispose();}
      });
      await check('current write revocation rejects status and the actual mutation authorization',async()=>{
        await withWriter(async()=>{
          const statusPeer=await peerFor('member'),writePeer=await peerFor('member');
          await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
          try{await assert.rejects(statusPeer.check(fence),code('PRINCIPAL_ACCESS_DENIED'));
            await assert.rejects(writePeer.authorizeWrite(fence),code('PRINCIPAL_ACCESS_DENIED'));}
          finally{await statusPeer.dispose();await writePeer.dispose();}
        });
      });
      await check('quarantined writer keeps diagnosis after write revocation without mutation authority',async()=>{
        await withWriter(async()=>{
          const peer=await peerFor('member');
          await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
          await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_permanent=1,projection_error_generation=1,projection_error_sequence=7 WHERE document_id=$1",[native.identity.documentId]);
          try{const result=await peer.check(fence);assert.equal(result.quarantined,true);assert.equal(result.workspace.permissions.canWrite,false);
            await assert.rejects(peer.authorizeWrite(fence),code('PRINCIPAL_ACCESS_DENIED'));}
          finally{await peer.dispose();await admin.query('UPDATE collaboration_yjs_states SET degraded=0,projection_error_code=NULL,projection_error_permanent=0,projection_error_generation=NULL,projection_error_sequence=NULL WHERE document_id=$1',[native.identity.documentId]);}
        });
      });
      await check('read ticket remains read-only even when current workspace permits writing',async()=>{
        const peer=await peerFor('owner','canRead','read');
        try{assert.equal((await peer.check(fence)).quarantined,false);
          await assert.rejects(peer.authorizeWrite(fence),code('NATIVE_TRANSPORT_ACCESS_DENIED'));}
        finally{await peer.dispose();}
      });
      for(const cookie of [true,false])await check(`genuine ${cookie?'Cookie':'Bearer'} held-owner phase uses original auth and expires facade`,async()=>{
        assert.equal((await auth.api.getSession({headers:(await request('owner',cookie)).headers}))?.session.id,'session-owner');
        const cap=await captured('owner','canWrite',cookie);let retained:import('../app/lib/collaboration/authenticated-native-session-transport').AuthenticatedOwnedNativeSessionAccess|undefined;
        await observe(cap,async access=>{retained=access;assert.equal(access.userId,'owner');assert.equal(access.sessionId,'session-owner');
          assert.deepEqual(access.identity,native.identity);assert.equal(access.quarantined,false);await access.assertCurrent();});
        assert(retained);assert.throws(()=>retained!.workspace,code('NATIVE_TRANSPORT_REQUIRED'));await dispose(cap);
      });
      await check('actual Reserve and Drain block new strict joins while exact held owner still validates',async()=>{
        const state=await loadCollaborationState(native.identity.documentId);assert(state);
        const request=createRepresentationAdmissionRequest(state,'owner',{requestId:crypto.randomUUID(),expectedDocumentId:state.documentId,
          expectedLifecycleGeneration:state.lifecycleGeneration,documentSequence:state.documentSequence,stateProof:collaborationUpdateStateProof(state.yjsState,Y)!});
        const service=createCollaborationAdmissionService({openConnection:openDb});await service.reserve(request);
        const strict=await captured();await assert.rejects(transaction(db=>phase(db,strict,{permission:'canRead',...input(native.identity)},async()=>assert.fail())),code('NATIVE_SESSION_BUSY'));await dispose(strict);
        const cap=await captured();await observe(cap,async access=>{await access.assertCurrent();});
        await service.startDrain(request,state.documentId);await observe(cap,async access=>{assert.equal(access.quarantined,false);await access.assertCurrent();});
        await dispose(cap);
        // This fixture owns only its generated operation; its normal owner remains held for later cases.
        await admin.query('DELETE FROM collaboration_admission_targets WHERE request_id=$1',[request.requestId]);
        await admin.query('DELETE FROM collaboration_admission_scopes WHERE request_id=$1',[request.requestId]);
        await admin.query('DELETE FROM collaboration_admission_requests WHERE request_id=$1',[request.requestId]);
      });
      await check('actual conflicting PG row lock rejects Busy before callback then freshly retries',async()=>{
        const first=await captured(),second=await captured(),entered=gate(),release=gate(),bothReady=gate();let secondCalls=0,ready=0;
        // Both genuine HTTP factories finish before overlapping their real B
        // lock phases. No fake principal or returned SQL result is injected.
        const overlapping=async<T>(cap:AuthenticatedNativeSessionTransport,later:boolean,consume:Parameters<typeof observe<T>>[1])=>transaction(db=>{
          let gated=false;
          const actual={...db,get:async(sql:string,values?:unknown[])=>{
            if(!gated&&sql.includes("current_setting('session_replication_role')")){
              gated=true;if(++ready===2)bothReady.resolve();await bothReady.promise;if(later)await entered.promise;
            }
            return db.get(sql,values);
          }};
          return owned(actual,cap,{permission:'canWrite',identity:native.identity,ownerFence:fence},async access=>{
            // Two policy readers both hold SHARE and are compatible. A genuine
            // writer must hold a conflicting row lock before expecting Busy.
            if(!later)await db.get("SELECT user_id FROM organization_user_permissions WHERE user_id='owner' FOR UPDATE NOWAIT");
            return consume(access);
          });
        });
        const holding=overlapping(first,false,async access=>{entered.resolve();await release.promise;await access.assertCurrent();});
        const attempted=overlapping(second,true,async()=>{secondCalls++;});
        try{await bounded(entered.promise);await assert.rejects(attempted,error=>isBusy(error));assert.equal(secondCalls,0);}
        finally{release.resolve();await holding;}
        await observe(second,async access=>{secondCalls++;assert(access.workspace.permissions.canWrite);await access.assertCurrent();},'canWrite');
        assert.equal(secondCalls,1);await dispose(first);await dispose(second);
      });
      await check('callback-crafted Principal Busy is fatal and never classified transient',async()=>{
        const cap=await captured();const {WorkspaceRequestPrincipalError}=await import('../app/lib/workspaces/request-principal');
        await assert.rejects(observe(cap,async()=>{throw new WorkspaceRequestPrincipalError('PRINCIPAL_BUSY');}),error=>!isBusy(error));
        await assert.rejects(observe(cap,async()=>assert.fail()));await dispose(cap);
      });
      await check('quarantine remains explicit read-only status under the held owner',async()=>{
        const cap=await captured('member','canRead');await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_permanent=1,projection_error_generation=1,projection_error_sequence=7 WHERE document_id=$1",[native.identity.documentId]);
        try{await observe(cap,async access=>{assert.equal(access.quarantined,true);assert.equal(access.workspace.permissions.canWrite,false);await access.assertCurrent();});
          await assert.rejects(observe(cap,async()=>assert.fail(),'canWrite'),code('NATIVE_TRANSPORT_ACCESS_DENIED'));}
        finally{await admin.query('UPDATE collaboration_yjs_states SET degraded=0,projection_error_code=NULL,projection_error_permanent=0,projection_error_generation=NULL,projection_error_sequence=NULL WHERE document_id=$1',[native.identity.documentId]);await dispose(cap);}
      });
      for(const mutation of ["projection_error_permanent=1", "projection_error_code='bad',projection_error_generation=2,projection_error_sequence=7",
        "projection_error_code='bad',projection_error_generation=1,projection_error_sequence=8", 'degraded=2', 'projection_error_permanent=2',
        'persisted_at=-1', 'checkpointed_at=-1', 'has_bom=2']) {
        await check('corrupt original error/clock/degraded tuple denies before any writer callback',async()=>{
          const cap=await captured();let calls=0;
          await admin.query('UPDATE collaboration_yjs_states SET '+mutation+' WHERE document_id=$1',[native.identity.documentId]);
          try{await assert.rejects(observe(cap,async()=>{calls++;},'canWrite'),code('NATIVE_TRANSPORT_SCOPE_CHANGED'));assert.equal(calls,0);}
          finally{await admin.query("UPDATE collaboration_yjs_states SET degraded=0,projection_error_code=NULL,projection_error_permanent=0,projection_error_generation=NULL,projection_error_sequence=NULL,projection_error_phase=NULL,persisted_at=100,checkpointed_at=NULL,newline_style='lf',has_bom=0 WHERE document_id=$1",[native.identity.documentId]);await dispose(cap);}
        });
      }
      await check('valid current permanent quarantine never enters a genuine Write callback',async()=>{
        const cap=await captured();let calls=0;
        await admin.query("UPDATE collaboration_yjs_states SET projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_permanent=1,projection_error_generation=1,projection_error_sequence=7 WHERE document_id=$1",[native.identity.documentId]);
        try{await assert.rejects(observe(cap,async()=>{calls++;},'canWrite'),code('NATIVE_TRANSPORT_QUARANTINED'));assert.equal(calls,0);}
        finally{await admin.query('UPDATE collaboration_yjs_states SET projection_error_code=NULL,projection_error_permanent=0,projection_error_generation=NULL,projection_error_sequence=NULL WHERE document_id=$1',[native.identity.documentId]);await dispose(cap);}
      });
      for(const cookie of [true,false])await check(`same-session original ${cookie?'Cookie':'Bearer'} token rotation is fatal`,async()=>{
        const cap=await captured('owner','canWrite',cookie);await seedSession('owner');let entered=false;
        await assert.rejects(observe(cap,async()=>{entered=true;}),code('PRINCIPAL_AUTH_REVOKED'));assert.equal(entered,false);await dispose(cap);
      });
      await check('changed original workspace root is rejected across later phases',async()=>{
        const cap=await captured();await admin.query('UPDATE canvas_workspaces SET root_relative_path=$2 WHERE id=$1',[workspaceId,'organizations/principal-org/other']);
        try{await assert.rejects(observe(cap,async()=>assert.fail()),code('NATIVE_TRANSPORT_SCOPE_CHANGED'));}
        finally{await admin.query('UPDATE canvas_workspaces SET root_relative_path=$2 WHERE id=$1',[workspaceId,'organizations/principal-org/shared']);await dispose(cap);}
      });
      await check('active Registry and Lineage are observed on the actual B',async()=>{
        const cap=await captured();await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=$2 WHERE id=$1",[native.identity.lineageId,Date.now()]);
        try{await assert.rejects(observe(cap,async()=>assert.fail()),code('NATIVE_TRANSPORT_SCOPE_CHANGED'));}
        finally{await admin.query("UPDATE file_collaboration_lineages SET status='active',archived_at=NULL WHERE id=$1",[native.identity.lineageId]);await dispose(cap);}
      });
      await check('consistent foreign Native and genuine SQL Owner cannot replace the original Workspace organization',async()=>{
        const other=await seed('foreign-native-organization');
        await admin.query("UPDATE collaboration_yjs_states SET organization_id='foreign-native-org' WHERE document_id=$1",[other.identity.documentId]);
        await admin.query("UPDATE collaboration_documents SET organization_id='foreign-native-org' WHERE id=$1",[other.identity.documentId]);
        await admin.query("UPDATE file_collaboration_lineages SET organization_id='foreign-native-org' WHERE id=$1",[other.identity.lineageId]);
        const foreignIdentity={...other.identity,organizationId:'foreign-native-org'};
        const foreignClient=await ownClient(),foreignOwner=await createCollaborationRoomOwnerSession(foreignClient);
        const {lineageId:_foreignLineage,...foreignScope}=foreignIdentity;
        const foreignFence=await foreignOwner.acquire(foreignScope),cap=await captured();let calls=0;
        try{await assert.rejects(transaction(db=>owned(db,cap,{permission:'canWrite',identity:foreignIdentity,ownerFence:foreignFence},async()=>{calls++;})),
          code('NATIVE_TRANSPORT_SCOPE_CHANGED'));assert.equal(calls,0);}
        finally{await dispose(cap);await foreignOwner.close();clients.delete(foreignClient);}
      });
      await check('final current Write loss rejects and rolls back the complete real B',async()=>{
        await withWriter(async()=>{const cap=await captured('member','canWrite');
          await assert.rejects(transaction((db,client)=>owned(db,cap,{permission:'canWrite',identity:native.identity,ownerFence:fence},async access=>{
            assert(access.workspace.permissions.canWrite);const settings=await db.get("SELECT current_setting('transaction_timeout') AS total,current_setting('lock_timeout') AS wait") as {total:string;wait:string};
            assert.equal(settings.total,'5s');assert.equal(settings.wait,'50ms');await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
          })),code('PRINCIPAL_ACCESS_DENIED'));assert.equal(await permissionRow(),1);await dispose(cap);});
      });
      await check('actual inactive Seat denies an idle owner-phase peer',async()=>{
        const cap=await captured('member','canRead');await admin.query("UPDATE team_memberships SET status='suspended' WHERE user_id='member'");
        try{await assert.rejects(observe(cap,async()=>assert.fail()));}
        finally{await admin.query("UPDATE team_memberships SET status='active' WHERE user_id='member'");await dispose(cap);}
      });
      await check('dispose invalidates immediately and settles a blocked actual phase',async()=>{
        const cap=await captured(),entered=gate(),release=gate();let finished=false;
        const running=observe(cap,async()=>{entered.resolve();await release.promise;});const rejected=assert.rejects(running,code('NATIVE_TRANSPORT_DISPOSED'));
        await bounded(entered.promise);const disposing=dispose(cap).then(()=>{finished=true;});await new Promise<void>(done=>setImmediate(done));assert.equal(finished,false);
        release.resolve();await rejected;await disposing;assert(finished);await assert.rejects(observe(cap,async()=>assert.fail()),code('NATIVE_TRANSPORT_DISPOSED'));
      });
      await check('actual owner release in the closed-principal final window cannot escape as success',async()=>{
        const finalNative=await seed('final-owner-window'),finalClient=await ownClient();
        const finalOwner=await createCollaborationRoomOwnerSession(finalClient);
        const {lineageId:_finalLineage,...finalScope}=finalNative.identity;
        const finalFence=await finalOwner.acquire(finalScope),cap=await captured();let observations=0,calls=0;
        try{await assert.rejects(transaction(db=>{
          const actual={...db,get:async(sql:string,values?:unknown[])=>{
            if(sql.includes('pg_current_xact_id()::text AS xid,w.id AS workspace_id')&&++observations===3)await finalOwner.release(finalFence);
            return db.get(sql,values);
          }};
          return owned(actual,cap,{permission:'canWrite',identity:finalNative.identity,ownerFence:finalFence},async()=>{calls++;});
        }),code('ROOM_OWNER_LOST'));assert.equal(calls,1);assert.equal(observations,3);}
        finally{await dispose(cap);await finalOwner.close();clients.delete(finalClient);}
      });
      await check('released real SQL owner cannot be impersonated by retained fence data',async()=>{
        const cap=await captured();await owner.release(fence);await assert.rejects(observe(cap,async()=>assert.fail()),code('ROOM_OWNER_LOST'));await dispose(cap);
      });
    }finally{await owner.close();clients.delete(ownerClient);}
    const nativeAfter=await stored(native.identity);
    assert.deepEqual(nativeAfter.yjs_state,nativeBefore.yjs_state);
    assert.deepEqual(nativeAfter.state_vector,nativeBefore.state_vector);
    assert.equal(nativeAfter.document_sequence,nativeBefore.document_sequence);
    assert.equal(fetches,0);
    console.log(`Authenticated held-owner peer PG18: ${cases} actual Cookie/Bearer/Owner/Busy/Scope/Seat/Write-final/disposal families passed.`);
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
main().catch(error=>{console.error('Owned authenticated held-peer fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  constraint:error&&typeof error==='object'?Reflect.get(error,'constraint')??null:null});process.exitCode=1;});
