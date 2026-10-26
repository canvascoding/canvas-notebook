import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { WebSocket } from 'ws';
import { MessageType, Hocuspocus } from '@hocuspocus/server';
import { AuthMessageType } from '@hocuspocus/common';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
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
  const schema = `native_socket_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_socket_[a-f0-9]{32}$/u);
  const workspaceId = `native-transport-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-socket-'));
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
    (runtime as import('pg').Pool).on('connect',client=>{client.on('error',()=>undefined);});
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
    const check=async(name:string,operation:()=>Promise<void>)=>{if(process.env.CANVAS_TEST_NATIVE_SOCKET_CASE&&!name.includes(process.env.CANVAS_TEST_NATIVE_SOCKET_CASE))return;stage=name;await operation();cases++;console.log(`Native Socket passed: ${name}`);};
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
    const input=(identity:ExistingNativeSessionIdentity)=>({path:identity.path,expectedIdentity:identity});
    const identities=new Map<string,ExistingNativeSessionIdentity>();
    const native=await seed('socket-native');identities.set(native.identity.documentId,native.identity);
    const retryOriginalRequest=async<T>(operation:()=>Promise<T>):Promise<T>=>{for(let attempt=0;;attempt++){try{return await operation();}catch(error){if(!error||typeof error!=='object'||Reflect.get(error,'code')!=='PRINCIPAL_BUSY'||attempt===3)throw error;await new Promise(done=>setTimeout(done,50));}}};
    const captured=async(userId='owner',permission:'canRead'|'canWrite'='canWrite',cookie=false)=>
      retryOriginalRequest(()=>transaction(db=>request(userId,cookie).then(actual=>enroll(db,actual,{workspaceId,maxPermission:permission}))));
    const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
    const bounded=async(promise:Promise<void>)=>{let timer!:ReturnType<typeof setTimeout>;try{
      await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture phase did not enter within eight seconds.')),8000);})]);
    }finally{clearTimeout(timer);}};


    const {createCollaborationRoomOwnerSession}=await import('../app/lib/collaboration/room-owner');
    type EnrollmentFault='commit'|'close'|null;
    let enrollmentFault:EnrollmentFault=null,enrollmentFaultFired=false;
    let enrollmentAbort:{entered:ReturnType<typeof gate>;release:ReturnType<typeof gate>}|undefined;
    let queuedFrame:{documentId:string;entered:ReturnType<typeof gate>}|undefined;
    let observedEnrollment:{transport:AuthenticatedNativeSessionTransport;connection:SqlConnection}|undefined;
    const observedBackends = new Map<number, SqlConnection>();
    const actualTransport=await import('../app/lib/collaboration/authenticated-native-session-transport');
    const actualDb=await import('../app/lib/db');
    let joinModeRace:{path:string;quarantined:boolean;fired:boolean}|undefined;
    let messageFault:{documentId:string;kind:'commit'|'close'|'final'|'owner-final'|'disconnect'|'timeout';connection?:SqlConnection;fired:boolean;finished?:boolean;entered?:ReturnType<typeof gate>;release?:ReturnType<typeof gate>}|undefined;
    let peerBusy:{documentId:string;hook:'beforeHandleMessage'|'beforeSync';cap:AuthenticatedNativeSessionTransport;entered:ReturnType<typeof gate>;release:ReturnType<typeof gate>;holding?:Promise<unknown>;fired:boolean;triggered:boolean;attempts:number;releaseAtAttempt:number}|undefined;
    const socketHook=new AsyncLocalStorage<string>();
    const peerChecks=new Map<string,number>();
    const peerDisposals=new Map<AuthenticatedNativeSessionTransport,Promise<void>>();
    const peerPhase=new AsyncLocalStorage<{documentId:string;kind:'check'|'write';fence:import('../app/lib/collaboration/room-owner').CollaborationRoomOwnerFence}>();
    const openObservedConnection=async()=>{
      const actual=await actualDb.openDb();let committed=false;
      const backend = Number((await actual.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
      const observed:SqlConnection={get:async(sql,values)=>{
        const active=peerPhase.getStore();
        if(peerBusy&&!peerBusy.fired&&socketHook.getStore()===peerBusy.hook&&active?.documentId===peerBusy.documentId&&sql.includes("current_setting('session_replication_role')")){
          const busy=peerBusy;busy.fired=true;const fence=active.fence;
          busy.holding=transaction(db=>owned(db,busy.cap,{permission:'canWrite',identity:identities.get(busy.documentId)!,ownerFence:fence},async access=>{
            // Two Current readers use compatible SHARE locks. Hold a genuine
            // conflicting tuple lock so the other B must fail NOWAIT before
            // its owner callback; elapsed time alone is never Busy evidence.
            await db.get("SELECT organization_id FROM canvas_organization_settings WHERE organization_id='principal-org' FOR UPDATE");
            busy.entered.resolve();await busy.release.promise;await access.assertCurrent();
          }));
          await bounded(busy.entered.promise);
        }
        return actual.get(sql,values);
      },all:async(sql,values)=>{
        const result=await actual.all(sql,values);
        if(joinModeRace&&!joinModeRace.fired&&sql.startsWith('SELECT s.lifecycle_generation,s.degraded')&&values?.[1]===joinModeRace.path){
          joinModeRace.fired=true;
          await actual.run("UPDATE collaboration_yjs_states SET degraded=$1,projection_error_code=$2,projection_error_permanent=$1,projection_error_generation=$3,projection_error_sequence=$4 WHERE workspace_id=$5 AND path=$6",[joinModeRace.quarantined?0:1,joinModeRace.quarantined?null:'COLLABORATION_SCHEMA_INVALID',joinModeRace.quarantined?null:1,joinModeRace.quarantined?null:7,workspaceId,joinModeRace.path]);
        }
        const row=result[0] as Record<string,unknown>|undefined;
        if(sql.startsWith('SELECT s.document_id,s.workspace_id')&&typeof row?.document_id==='string'){
          if(messageFault&&peerPhase.getStore()?.kind==='write'&&messageFault.documentId===peerPhase.getStore()?.documentId&&messageFault.documentId===row.document_id){
            messageFault.connection=observed;
            if(messageFault.kind==='final'&&!messageFault.fired){messageFault.fired=true;await actual.run("UPDATE \"session\" SET token=$1 WHERE id='session-owner'",[crypto.randomBytes(32).toString('hex')]);}
            if(messageFault.kind==='owner-final'&&!messageFault.fired){messageFault.fired=true;await actual.run('UPDATE collaboration_yjs_states SET room_owner_epoch=room_owner_epoch+1 WHERE document_id=$1',[row.document_id]);}
            if(messageFault.kind==='timeout'&&!messageFault.fired){messageFault.fired=true;await actual.run('SELECT pg_sleep(5.1)');}
            if(messageFault.kind==='disconnect'&&!messageFault.fired){messageFault.fired=true;messageFault.entered!.resolve();await messageFault.release!.promise;}
          }
        }
        return result;
      },run:async(sql,values)=>{
        const result=await actual.run(sql,values);
        if(sql==='COMMIT'){
          committed=true;
          if(enrollmentFault==='commit'&&observedEnrollment?.connection===observed&&!enrollmentFaultFired){enrollmentFaultFired=true;throw new Error('Lost actual enrollment COMMIT response.');}
          if(messageFault?.kind==='commit'&&messageFault.connection===observed&&!messageFault.fired){messageFault.fired=true;throw new Error('Lost actual message authorization COMMIT response.');}
        }
        return result;
      },close:async error=>{
        await actual.close(error);
        if (observedBackends.get(backend) === observed) observedBackends.delete(backend);
        if(messageFault?.kind==='close'&&messageFault.connection===observed&&committed&&!messageFault.fired){messageFault.fired=true;throw new Error('Lost actual message authorization close response.');}
        if(enrollmentFault==='close'&&observedEnrollment?.connection===observed&&committed&&!enrollmentFaultFired){enrollmentFaultFired=true;throw new Error('Lost actual enrollment close response after COMMIT.');}
      }};
      observedBackends.set(backend, observed);
      return observed;
    };
    // Evaluate the exact saved product source with actual SQL. Controlled same-B
    // mutations, completion faults and genuine overlapping phases never replace
    // returned SQL rows, original credentials or authenticated principals.
    const serverFilename=path.resolve('server/collaboration-server.ts'),requireSource=createRequire(serverFilename);
    const peerFilename=path.resolve('app/lib/collaboration/authenticated-native-peer.ts'),requirePeer=createRequire(peerFilename);
    const compiledPeer=ts.transpileModule(await readFile(peerFilename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}});
    const productPeer={} as typeof import('../app/lib/collaboration/authenticated-native-peer');
    new Function('require','module','exports',compiledPeer.outputText)((name:string)=>name==='../db'?{...actualDb,openDb:openObservedConnection}:requirePeer(name),{exports:productPeer},productPeer);
    const admissionOrigins = new WeakMap<import('../app/lib/collaboration/authenticated-native-session-transport').AuthenticatedNativePeerOrigin, AuthenticatedNativeSessionTransport>();
    const disposedAdmissionTransports = new WeakSet<AuthenticatedNativeSessionTransport>();
    const observedTransport = { ...actualTransport,
      adoptAuthenticatedNativePeerOrigin: (...args: Parameters<typeof actualTransport.adoptAuthenticatedNativePeerOrigin>) => {
        const origin = actualTransport.adoptAuthenticatedNativePeerOrigin(...args); admissionOrigins.set(origin, args[0]); return origin;
      },
      disposeAuthenticatedNativePeerOrigin: async (...args: Parameters<typeof actualTransport.disposeAuthenticatedNativePeerOrigin>) => {
        await actualTransport.disposeAuthenticatedNativePeerOrigin(...args);
        const cap = admissionOrigins.get(args[0]); if (cap) disposedAdmissionTransports.add(cap);
      },
      captureAuthenticatedNativePeerOriginTransportOnConnection: async (...args: Parameters<typeof actualTransport.captureAuthenticatedNativePeerOriginTransportOnConnection>) => {
        const transport = await actualTransport.captureAuthenticatedNativePeerOriginTransportOnConnection(...args);
        if ((enrollmentFault || enrollmentAbort) && !observedEnrollment) {
          const backend = Number((await args[0].get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
          const connection = observedBackends.get(backend); assert(connection, 'Capture B must be an actually observed backend.');
          observedEnrollment = { transport, connection };
        }
        if (enrollmentAbort) { enrollmentAbort.entered.resolve(); await enrollmentAbort.release.promise; }
        return transport;
      },
    };
    // Admission now owns Capture/Join B. Observe its exact saved source too,
    // otherwise completion faults never reach the actual enrollment connection.
    const admissionFilename = path.resolve('app/lib/collaboration/authenticated-native-peer-admission.ts');
    const requireAdmission = createRequire(admissionFilename);
    const compiledAdmission = ts.transpileModule(await readFile(admissionFilename, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } });
    const productAdmission = {} as typeof import('../app/lib/collaboration/authenticated-native-peer-admission');
    new Function('require', 'module', 'exports', compiledAdmission.outputText)((name: string) => {
      if (name === '../db') return { ...actualDb, openDb: openObservedConnection };
      if (name === './authenticated-native-session-transport') return observedTransport;
      return requireAdmission(name);
    }, { exports: productAdmission }, productAdmission);
    const compiled=ts.transpileModule(await readFile(serverFilename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}});
    const productServer={} as typeof import('../server/collaboration-server');
    new Function('require','module','exports',compiled.outputText)((name:string)=>{
      if(name==='@/app/lib/db')return{...actualDb,openDb:openObservedConnection};
      if(name==='@/app/lib/collaboration/authenticated-native-peer-admission')return productAdmission;
      if(name==='@/app/lib/collaboration/authenticated-native-peer')return{...productPeer,createAuthenticatedNativePeer:(input:Parameters<typeof productPeer.createAuthenticatedNativePeer>[0])=>{
        const peer=productPeer.createAuthenticatedNativePeer(input);
        return{...peer,dispose:()=>{const pending=peer.dispose();peerDisposals.set(input.transport,pending);return pending;},check:(...args:Parameters<typeof peer.check>)=>peerPhase.run({documentId:input.identity.documentId,fence:args[0],kind:'check'},async()=>{
          peerChecks.set(input.identity.documentId,(peerChecks.get(input.identity.documentId)??0)+1);
          try{return await peer.check(...args);}catch(error){if(peerBusy&&peerBusy.fired&&input.identity.documentId===peerBusy.documentId&&socketHook.getStore()===peerBusy.hook&&isBusy(error)){const busy=peerBusy;busy.attempts++;busy.release.resolve();await busy.holding;if(busy.attempts<busy.releaseAtAttempt){busy.fired=false;busy.entered=gate();busy.release=gate();}}throw error;}finally{peerChecks.set(input.identity.documentId,peerChecks.get(input.identity.documentId)!-1);}
        }),authorizeWrite:(...args:Parameters<typeof peer.authorizeWrite>)=>peerPhase.run({documentId:input.identity.documentId,fence:args[0],kind:'write'},async()=>{
          try{return await peer.authorizeWrite(...args);}catch(error){if(peerBusy&&peerBusy.fired&&input.identity.documentId===peerBusy.documentId&&socketHook.getStore()===peerBusy.hook&&isBusy(error)){const busy=peerBusy;busy.attempts++;busy.release.resolve();await busy.holding;if(busy.attempts<busy.releaseAtAttempt){busy.fired=false;busy.entered=gate();busy.release=gate();}}throw error;}finally{if(messageFault?.documentId===input.identity.documentId)messageFault.finished=true;}
        })};
      }};
      if(name==='@/app/lib/collaboration/authenticated-native-session-transport')return{...actualTransport,captureAuthenticatedNativeSessionTransportOnConnection:async(...args:Parameters<typeof enroll>)=>{
        const transport=await actualTransport.captureAuthenticatedNativeSessionTransportOnConnection(...args);
        if((enrollmentFault||enrollmentAbort)&&!observedEnrollment)observedEnrollment={transport,connection:args[0]};
        if(enrollmentAbort){enrollmentAbort.entered.resolve();await enrollmentAbort.release.promise;}
        return transport;
      }};
      return requireSource(name);
    },{exports:productServer},productServer);
    const {createCollaborationServer,flushCollaborationDocuments}=productServer;
    const {issueCollaborationTicket}=await import('../app/lib/collaboration/ticket');
    const {loadCollaborationState}=await import('../app/lib/collaboration/persistence');
    const mobile=await import('../app/lib/mobile/collaboration-ticket');
    const {withAuthenticatedTextCollaborationSessionGrant:publishGrant}=await import('../app/lib/collaboration/authenticated-text-session-service');
    const mobileCaps=new Map<string,AuthenticatedNativeSessionTransport>();
    const mobileTicket=async(identity:ExistingNativeSessionIdentity,userId='owner',permission:'read'|'write'='write',incompatibleRepresentation=false)=>retryOriginalRequest(async()=>publishGrant({request:await request(userId),workspaceId,sessionRequest:{path:identity.path,provider:'yjs',representation:'plain_text'},permission},async publication=>{
      let adopted:AuthenticatedNativeSessionTransport|undefined;
      const claims = claimsFor(identity,userId,publication.grant.permission);
      // A deliberately incompatible selector never replaces the genuine
      // captured transport or its native identity. Native admission must
      // reject it and dispose that exact capability before Connection exists.
      const ticket=mobile.issueAuthenticatedMobileCollaborationTicket({claims:{...claims,...incompatibleRepresentation?{representation:'tiptap_xml' as const}:{}},user:{id:userId,name:userId,email:null,role:null},takeTransport:rollback=>{adopted=publication.takeTransport(rollback);return adopted;}});
      assert(adopted);mobileCaps.set(ticket.token,adopted);return ticket;
    }));
    const actualRoot=path.join(dataRoot,'organizations/principal-org/shared');await mkdir(actualRoot,{recursive:true});
    await writeFile(path.join(actualRoot,native.identity.path),'ABC');
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION='1';
    const server=http.createServer((_request,response)=>{response.statusCode=404;response.end();});
    const sockets=new Set<WebSocket>();
    const authRequests=new Map<string,Request>();
    const actualDocuments=new Map<string,import('@hocuspocus/server').Document>();
    const actualRuntime:{hocuspocus?:Hocuspocus}={};
    const originalHooks=Hocuspocus.prototype.hooks;
    Hocuspocus.prototype.hooks=(async function(this:Hocuspocus,name:string,payload:Record<string,unknown>,...args:unknown[]){
      actualRuntime.hocuspocus=this;
      if(name==='onAuthenticate'&&typeof payload.documentName==='string'&&payload.request instanceof Request)authRequests.set(payload.documentName,payload.request);
      if(name==='beforeSync'&&queuedFrame&&queuedFrame.documentId===payload.documentName&&payload.type===2)queuedFrame.entered.resolve();
      const busy=peerBusy;const trigger=!!busy&&!busy.triggered&&name===busy.hook&&payload.documentName===busy.documentId;
      if(trigger){busy.triggered=true;await waitUntil(()=>!peerChecks.get(busy.documentId),'The preceding genuine monitor phase did not settle before the targeted actual Socket hook.');}
      const result=await socketHook.run(name,()=> (originalHooks as (...args:unknown[])=>Promise<unknown>).call(this,name,payload,...args));
      if(name==='connected'&&payload.connection&&typeof payload.documentName==='string')actualDocuments.set(payload.documentName,(payload.connection as import('@hocuspocus/server').Connection).document);
      return result;
    }) as typeof originalHooks;
    const wss=createCollaborationServer(server,{roomOwner:{createSession:async onInvalidated=>{const client=await ownClient();return createCollaborationRoomOwnerSession({query:((sql:string,values?:unknown[])=>client.query(sql,values).catch(error=>{console.log('Actual owner query failure:',{command:sql.split(/\s/u)[0],code:error.code});throw error;})) as typeof client.query,on:client.on.bind(client),end:client.end.bind(client)},()=>{console.log('Actual owner fixture invalidated.');onInvalidated();});},heartbeatMs:1000}});
    const waitUntil=async(predicate:()=>boolean|Promise<boolean>,label:string)=>{
      const until=Date.now()+8000;while(Date.now()<until){if(await predicate())return;await new Promise(done=>setTimeout(done,20));}throw new Error(label);
    };
    const frame=(documentId:string,type:number,write:(encoder:ReturnType<typeof encoding.createEncoder>)=>void)=>{
      const encoder=encoding.createEncoder();encoding.writeVarString(encoder,documentId);encoding.writeVarUint(encoder,type);write(encoder);return encoding.toUint8Array(encoder);
    };
    const claimsFor=(identity:ExistingNativeSessionIdentity,userId='owner',permission:'read'|'write'='write')=>({userId,sessionId:`session-${userId}`,workspaceId,organizationId:identity.organizationId,
      documentId:identity.documentId,path:identity.path,provider:'yjs' as const,representation:identity.representation,permission,lifecycleGeneration:identity.lifecycleGeneration});
    type SocketPeer={socket:WebSocket;messages:Array<{type:number;auth?:number;body?:Record<string,unknown>;reason?:string}>;doc:InstanceType<typeof Y.Doc>};
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert(address&&typeof address==='object');
    const connect=async(identity:ExistingNativeSessionIdentity,userId='owner',cookie=true,options:{permission?:'read'|'write';mobile?:boolean;token?:string;retryJoin?:boolean;localDoc?:InstanceType<typeof Y.Doc>}={},joinAttempt=0):Promise<SocketPeer>=>{
      const original=await request(userId,cookie),ticket=issueCollaborationTicket(claimsFor(identity,userId,options.permission));
      const headers={origin:'http://localhost',cookie:options.mobile?'':original.headers.get('cookie')??'',
        authorization:options.mobile?'':original.headers.get('authorization')??'','x-canvas-workspace-id':workspaceId};
      const socket=options.mobile?new WebSocket(`ws://127.0.0.1:${address.port}/ws/collaboration`,[mobile.MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL],{headers}):new WebSocket(`ws://127.0.0.1:${address.port}/ws/collaboration`,{headers});sockets.add(socket);
      const messages:SocketPeer['messages']=[],doc=options.localDoc??new Y.Doc();
      socket.on('message',data=>{try{
        const bytes=data instanceof ArrayBuffer?new Uint8Array(data):Array.isArray(data)?new Uint8Array(Buffer.concat(data)):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
        const decoder=decoding.createDecoder(bytes);decoding.readVarString(decoder);const type=decoding.readVarUint(decoder);
        if(type===MessageType.Auth){const authType=decoding.readVarUint(decoder);messages.push({type,auth:authType,...authType===AuthMessageType.PermissionDenied?{reason:decoding.readVarString(decoder)}:{}});}
        else if(type===MessageType.Stateless)messages.push({type,body:JSON.parse(decoding.readVarString(decoder))});
        else if(type===MessageType.Sync){const subtype=decoding.readVarUint(decoder);if(subtype===1||subtype===2)Y.applyUpdate(doc,decoding.readVarUint8Array(decoder));else if(subtype===0&&options.localDoc){const vector=decoding.readVarUint8Array(decoder);socket.send(frame(identity.documentId,MessageType.Sync,encoder=>{encoding.writeVarUint(encoder,1);encoding.writeVarUint8Array(encoder,Y.encodeStateAsUpdate(doc,vector));}));}messages.push({type});}
        else messages.push({type});
      }catch{messages.push({type:-1});}});
      socket.on('error',()=>undefined);
      await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
      socket.send(frame(identity.documentId,MessageType.Auth,encoder=>{encoding.writeVarUint(encoder,AuthMessageType.Token);encoding.writeVarString(encoder,options.token??ticket.token);}));
      await waitUntil(()=>messages.some(message=>message.auth===AuthMessageType.Authenticated)||messages.some(message=>message.auth===AuthMessageType.PermissionDenied),'Socket auth did not settle.');
      const denied=messages.find(message=>message.auth===AuthMessageType.PermissionDenied);
      // A Web join that genuinely collides with another room's bounded Auth B
      // restarts the entire actual handshake, never its consumed short phase.
      if(options.retryJoin&&denied&&joinAttempt<3){socket.close();if(!options.localDoc)doc.destroy();await new Promise(done=>setTimeout(done,50));const fresh=options.mobile?await mobileTicket(identity,userId,options.permission):undefined;return connect(identity,userId,cookie,{...options,...fresh?{token:fresh.token}:{}},joinAttempt+1);}
      assert(messages.some(message=>message.auth===AuthMessageType.Authenticated),'Actual Socket authentication rejected.');
      await waitUntil(()=>messages.some(message=>message.body?.type==='durability_snapshot'),'Socket startup snapshot did not arrive.');
      socket.send(frame(identity.documentId,MessageType.Sync,encoder=>{encoding.writeVarUint(encoder,0);encoding.writeVarUint8Array(encoder,Y.encodeStateVector(doc));}));
      await waitUntil(()=>doc.getText('content').toString().startsWith('ABC'),'Actual Socket did not synchronize native body.');
      return{socket,messages,doc};
    };
    const join=(identity:ExistingNativeSessionIdentity,userId='owner',cookie=true,options:Parameters<typeof connect>[3]={})=>connect(identity,userId,cookie,{...options,retryJoin:true});
    const sendAppend=(peer:SocketPeer,identity:ExistingNativeSessionIdentity,text:string)=>{
      const vector=Y.encodeStateVector(peer.doc);peer.doc.getText('content').insert(peer.doc.getText('content').length,text);
      peer.socket.send(frame(identity.documentId,MessageType.Sync,encoder=>{encoding.writeVarUint(encoder,2);encoding.writeVarUint8Array(encoder,Y.encodeStateAsUpdate(peer.doc,vector));}));
    };
    try{
      await check('actual Web Cookie Socket performs genuine Join Owner ingress apply and durable Store then token rotation revokes idle peer',async()=>{
        const peer=await join(native.identity);assert.equal((await auth.api.getSession({headers:(await request('owner',true)).headers}))?.session.id,'session-owner');
        sendAppend(peer,native.identity,'!');
        await waitUntil(async()=>{const state=await loadCollaborationState(native.identity.documentId);return !!state&&state.documentSequence>7;},'Accepted actual Socket update was not stored.');
        const state=await loadCollaborationState(native.identity.documentId);assert(state);const storedDoc=new Y.Doc();Y.applyUpdate(storedDoc,state.yjsState);assert.equal(storedDoc.getText('content').toString(),'ABC!');storedDoc.destroy();
        assert.equal(actualDocuments.get(native.identity.documentId)?.getText('content').toString(),'ABC!');
        await seedSession('owner');await waitUntil(()=>peer.messages.some(message=>message.body?.type==='access_revoked'),'Original Socket token rotation did not revoke idle peer.');
        assert.equal(actualDocuments.get(native.identity.documentId)?.getText('content').toString(),'ABC!');peer.socket.close();peer.doc.destroy();
      });
      for(const fault of ['commit','close'] as const)await check(`actual enrollment ${fault} failure disposes the exact genuinely minted transport`,async()=>{
        const other=await seed(`enroll-${fault}`);await writeFile(path.join(actualRoot,other.identity.path),'ABC');
        enrollmentFault=fault;enrollmentFaultFired=false;observedEnrollment=undefined;
        try{await assert.rejects(connect(other.identity));assert(enrollmentFaultFired);assert(observedEnrollment);
          await assert.rejects(transaction(db=>phase(db,observedEnrollment!.transport,{permission:'canRead',...input(other.identity)},async()=>assert.fail())),code('NATIVE_TRANSPORT_DISPOSED'));
        }finally{enrollmentFault=null;const minted=observedEnrollment as {transport:AuthenticatedNativeSessionTransport}|undefined;if(minted)await dispose(minted.transport);}
      });
      await check('actual Web abort before Connection disposes a genuinely minted transport after earlier cleanup already settled',async()=>{
        const other=await seed('late-enrollment-abort');await writeFile(path.join(actualRoot,other.identity.path),'ABC');observedEnrollment=undefined;const entered=gate(),release=gate();enrollmentAbort={entered,release};
        const connecting=connect(other.identity).then(()=>assert.fail('Aborted connection unexpectedly authenticated.'),()=>undefined);
        try{await bounded(entered.promise);assert(observedEnrollment);[...sockets].at(-1)!.terminate();await waitUntil(()=>authRequests.get(other.identity.documentId)?.signal.aborted??false,'Actual upgrade Request did not abort.');release.resolve();await connecting;
          const cap=(observedEnrollment as unknown as {transport:AuthenticatedNativeSessionTransport}).transport;await assert.rejects(transaction(db=>phase(db,cap,{permission:'canRead',...input(other.identity)},async()=>assert.fail())),code('NATIVE_TRANSPORT_DISPOSED'));assert(!actualDocuments.has(other.identity.documentId));
        }finally{release.resolve();enrollmentAbort=undefined;await connecting;}
      });
      for(const fault of ['commit','close','final','owner-final','disconnect','timeout'] as const)await check(`actual failed message authorization ${fault} precedes every Room broadcast and native Store effect`,async()=>{
        const other=await seed(`message-${fault}`);await writeFile(path.join(actualRoot,other.identity.path),'ABC');
        const writer=await join(other.identity),observer=await join(other.identity);messageFault={documentId:other.identity.documentId,kind:fault,fired:false,...fault==='disconnect'?{entered:gate(),release:gate()}:{}};
        try{sendAppend(writer,other.identity,'-REJECTED');await waitUntil(()=>messageFault!.fired,'Actual message authorization fault did not fire.');
          if(fault==='disconnect'){await bounded(messageFault!.entered!.promise);writer.socket.terminate();await waitUntil(()=>actualDocuments.get(other.identity.documentId)?.getConnectionsCount()===1,'Actual frame peer did not disconnect before apply.');messageFault!.release!.resolve();await waitUntil(()=>messageFault!.finished??false,'Disconnected actual write phase did not settle.');}
          else await waitUntil(()=>writer.messages.some(message=>message.type===MessageType.CLOSE),'Rejected message connection did not settle.');
          await flushCollaborationDocuments();
          const roomChanged=actualDocuments.get(other.identity.documentId)?.getText('content').toString().includes('-REJECTED')??false;
          const remoteChanged=observer.doc.getText('content').toString().includes('-REJECTED');
          const storedState=await loadCollaborationState(other.identity.documentId);assert(storedState);const durable=new Y.Doc();Y.applyUpdate(durable,storedState.yjsState);
          const storedChanged=durable.getText('content').toString().includes('-REJECTED');durable.destroy();
          console.log('Actual rejected message authorization measurements:',{roomChanged,remoteChanged,storedChanged});
          assert.equal(roomChanged,false);assert.equal(remoteChanged,false);assert.equal(storedChanged,false);
        }finally{messageFault?.release?.resolve();messageFault=undefined;writer.socket.close();observer.socket.close();writer.doc.destroy();observer.doc.destroy();}
      });
      await check('actual member Write is checked freshly after the concrete Room mutation queue before live apply',async()=>{
        const other=await seed('queued-write-acl');await writeFile(path.join(actualRoot,other.identity.path),'ABC');await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
        let release:(()=>void)|undefined;let writer:SocketPeer|undefined,observer:SocketPeer|undefined;
        try{writer=await join(other.identity,'member');observer=await join(other.identity);const document=actualDocuments.get(other.identity.documentId);assert(document);
          const {acquireCollaborationRoomMutationLock}=await import('../app/lib/collaboration/room-mutation-lock');release=await acquireCollaborationRoomMutationLock(document);const entered=gate();queuedFrame={documentId:other.identity.documentId,entered};
          sendAppend(writer,other.identity,'-QUEUED-DENIED');await bounded(entered.promise);await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");release();release=undefined;
          await waitUntil(()=>writer!.messages.some(message=>message.body?.type==='access_revoked'),'Queued writer ACL change was not freshly rejected.');await flushCollaborationDocuments();assert.equal(document.getText('content').toString(),'ABC');assert.equal(observer.doc.getText('content').toString(),'ABC');
          const state=await loadCollaborationState(other.identity.documentId);assert(state);const durable=new Y.Doc();Y.applyUpdate(durable,state.yjsState);assert.equal(durable.getText('content').toString(),'ABC');durable.destroy();
        }finally{release?.();queuedFrame=undefined;await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");writer?.socket.close();observer?.socket.close();writer?.doc.destroy();observer?.doc.destroy();}
      });
      await check('actual private Mobile transport joins without Socket credentials and stores accepted update after consumed credentials are disposed',async()=>{
        const other=await seed('mobile-private');await writeFile(path.join(actualRoot,other.identity.path),'ABC');
        const ticket=await mobileTicket(other.identity),peer=await join(other.identity,'owner',false,{mobile:true,token:ticket.token});
        assert.equal(mobile.consumeMobileCollaborationTicket(ticket.token),null);sendAppend(peer,other.identity,'-MOBILE');
        await waitUntil(()=>actualDocuments.get(other.identity.documentId)?.getText('content').toString()==='ABC-MOBILE','Original private Mobile transport did not apply.');
        peer.socket.close();const cap=mobileCaps.get(ticket.token)!;await waitUntil(()=>peerDisposals.has(cap),'Actual Mobile disconnect did not dispose its consumed transport.');await peerDisposals.get(cap);
        await flushCollaborationDocuments();
        const state=await loadCollaborationState(other.identity.documentId);assert(state);const durable=new Y.Doc();Y.applyUpdate(durable,state.yjsState);assert.equal(durable.getText('content').toString(),'ABC-MOBILE');durable.destroy();
        await assert.rejects(connect(other.identity,'owner',false,{mobile:true,token:ticket.token}));peer.socket.close();peer.doc.destroy();
        await assert.rejects(transaction(db=>phase(db,cap,{permission:'canRead',...input(other.identity)},async()=>assert.fail())),code('NATIVE_TRANSPORT_DISPOSED'));
      });
      await check('actual consumed native Mobile transport is disposed when an incompatible representation is rejected before Connection exists',async()=>{
        const other=await seed('mobile-gate-reject');await writeFile(path.join(actualRoot,other.identity.path),'ABC');const ticket=await mobileTicket(other.identity,'owner','write',true),cap=mobileCaps.get(ticket.token)!;
        try{await assert.rejects(connect(other.identity,'owner',false,{mobile:true,token:ticket.token}));assert.equal(mobile.consumeMobileCollaborationTicket(ticket.token),null);
          assert(disposedAdmissionTransports.has(cap), 'the actual admission origin disposal must finish for this exact captured transport');
          // A poisoned capability retains its first scope failure even after
          // disposal. It must never become usable through the original path.
          await assert.rejects(transaction(db=>phase(db,cap,{permission:'canRead',...input(other.identity)},async()=>assert.fail())),code('NATIVE_TRANSPORT_SCOPE_CHANGED'));
        }finally{await dispose(cap);}
      });
      await check('actual Mobile protocol never falls back to a signed Web token without its private store origin',async()=>{
        const other=await seed('mobile-missing');await writeFile(path.join(actualRoot,other.identity.path),'ABC');
        await assert.rejects(connect(other.identity,'owner',false,{mobile:true}));
      });
      for(const quarantined of [false,true])await check(`actual read-only Join uses ${quarantined?'quarantined fixed-canRead diagnosis':'healthy fixed-canRead reader'} and cannot apply`,async()=>{
        const other=await seed(`read-${quarantined}`);await writeFile(path.join(actualRoot,other.identity.path),'ABC');
        if(quarantined)await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_permanent=1,projection_error_generation=1,projection_error_sequence=7 WHERE document_id=$1",[other.identity.documentId]);
        const peer=await join(other.identity,'member',true,{permission:'read'});sendAppend(peer,other.identity,'-DENIED');
        await new Promise(done=>setTimeout(done,150));await flushCollaborationDocuments();assert.equal(actualDocuments.get(other.identity.documentId)?.getText('content').toString(),'ABC');
        const state=await loadCollaborationState(other.identity.documentId);assert(state);const durable=new Y.Doc();Y.applyUpdate(durable,state.yjsState);assert.equal(durable.getText('content').toString(),'ABC');durable.destroy();
        assert.equal(peer.messages.some(message=>message.body?.type==='access_revoked'),false);peer.socket.close();peer.doc.destroy();
      });
      await check('actual quarantine transport accepts path-only and exact expectedIdentity inputs as separate fixed-canRead capabilities',async()=>{
        const other=await seed('diagnosis-input-contract');await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_permanent=1,projection_error_generation=1,projection_error_sequence=7 WHERE document_id=$1",[other.identity.documentId]);
        for(const withIdentity of [false,true]){const cap=await captured('member','canRead');try{
          await transaction(db=>actualTransport.withAuthenticatedNativeSessionDiagnosisTransportOnConnection(db,cap,{path:other.identity.path,...withIdentity?{expectedIdentity:other.identity}:{}},async(diagnosis,access)=>{
            assert.equal(diagnosis.permission,'read');assert.equal(diagnosis.snapshot.documentId,other.identity.documentId);assert.equal(access.workspace.permissions.canWrite,false);await access.assertCurrent();
          }));
        }finally{await dispose(cap);}}
      });
      for(const quarantined of [false,true])await check(`actual read-only mode race ${quarantined?'diagnosis-to-healthy':'healthy-to-quarantine'} rejects instead of granting from the selector`,async()=>{
        const other=await seed(`mode-race-${quarantined}`);await writeFile(path.join(actualRoot,other.identity.path),'ABC');
        if(quarantined)await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_permanent=1,projection_error_generation=1,projection_error_sequence=7 WHERE document_id=$1",[other.identity.documentId]);
        joinModeRace={path:other.identity.path,quarantined,fired:false};try{await assert.rejects(connect(other.identity,'member',true,{permission:'read'}));assert(joinModeRace.fired);assert(!actualDocuments.has(other.identity.documentId));}finally{joinModeRace=undefined;}
      });
      await check('actual writer quarantine race degrades and closes for a fresh diagnosis without false access revocation',async()=>{
        const other=await seed('writer-quarantine');await writeFile(path.join(actualRoot,other.identity.path),'ABC');const peer=await join(other.identity);
        await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_permanent=1,projection_error_generation=1,projection_error_sequence=7 WHERE document_id=$1",[other.identity.documentId]);
        sendAppend(peer,other.identity,'-DENIED');await waitUntil(()=>peer.messages.some(message=>message.body?.type==='degraded')&&peer.messages.some(message=>message.type===MessageType.CLOSE),'Quarantine writer did not degrade and close.');
        assert.equal(peer.messages.some(message=>message.body?.type==='access_revoked'),false);assert.equal(actualDocuments.get(other.identity.documentId)?.getText('content').toString(),'ABC');peer.socket.close();peer.doc.destroy();
      });
      for(const hook of ['beforeHandleMessage','beforeSync'] as const)await check(`actual pre-callback ${hook} PeerBusy retry delivers the same once-sent local update`,async()=>{
        const other=await seed(`busy-${hook}`);identities.set(other.identity.documentId,other.identity);await writeFile(path.join(actualRoot,other.identity.path),'ABC');
        const writer=await join(other.identity),observer=await join(other.identity),cap=await captured();const entered=gate(),release=gate();
        peerBusy={documentId:other.identity.documentId,hook,cap,entered,release,fired:false,triggered:false,attempts:0,releaseAtAttempt:1};
        try{sendAppend(writer,other.identity,'-BUSY');await bounded(entered.promise);
          await waitUntil(()=>actualDocuments.get(other.identity.documentId)?.getText('content').toString()==='ABC-BUSY','Once-sent local edit was not retried after actual Peer lock release.');
          release.resolve();await peerBusy.holding;
          assert.equal(peerBusy.attempts,1, 'the actual pre-callback lock rejection must be observed once');
          await waitUntil(()=>observer.doc.getText('content').toString()==='ABC-BUSY','Retried local edit did not broadcast to the actual peer.');
          await flushCollaborationDocuments();
          const current=await loadCollaborationState(other.identity.documentId);assert(current);const durable=new Y.Doc();Y.applyUpdate(durable,current.yjsState);
          const measurement={local:writer.doc.getText('content').toString(),room:actualDocuments.get(other.identity.documentId)?.getText('content').toString(),stored:durable.getText('content').toString(),remote:observer.doc.getText('content').toString(),revoked:writer.messages.some(message=>message.body?.type==='access_revoked')};durable.destroy();
          console.log('Actual one-send PeerBusy counter:',{hook,...measurement});assert.equal(measurement.local,'ABC-BUSY');assert.equal(measurement.room,'ABC-BUSY');assert.equal(measurement.stored,'ABC-BUSY');assert.equal(measurement.remote,'ABC-BUSY');assert.equal(measurement.revoked,false);assert.equal(writer.messages.some(message=>message.type===MessageType.CLOSE),false);
        }finally{release.resolve();await peerBusy?.holding;peerBusy=undefined;await dispose(cap);writer.socket.close();observer.socket.close();writer.doc.destroy();observer.doc.destroy();}
      });
      await check('actual Mobile Busy exhaustion closes 1013 and a fresh single-use ticket resyncs the same retained local edit',async()=>{
        const other=await seed('mobile-busy-rejoin');identities.set(other.identity.documentId,other.identity);await writeFile(path.join(actualRoot,other.identity.path),'ABC');
        const ticket=await mobileTicket(other.identity),writer=await join(other.identity,'owner',false,{mobile:true,token:ticket.token}),observer=await join(other.identity),cap=await captured();const entered=gate(),release=gate();
        peerBusy={documentId:other.identity.documentId,hook:'beforeHandleMessage',cap,entered,release,fired:false,triggered:false,attempts:0,releaseAtAttempt:3};let closeCode:number|undefined;writer.socket.once('close',value=>{closeCode=value;});
        try{sendAppend(writer,other.identity,'-REJOIN');await bounded(entered.promise);try{await waitUntil(()=>closeCode!==undefined,'Busy exhaustion did not close the actual Socket.');}finally{console.log('Actual Busy exhaustion trace:',{fired:peerBusy?.fired,triggered:peerBusy?.triggered,attempts:peerBusy?.attempts,closed:closeCode!==undefined});}assert.equal(closeCode,1013);assert.equal(peerBusy.attempts,3);await peerBusy.holding;peerBusy=undefined;
          assert.equal(writer.messages.some(message=>message.body?.type==='access_revoked'),false);assert.equal(actualDocuments.get(other.identity.documentId)?.getText('content').toString(),'ABC');
          await assert.rejects(connect(other.identity,'owner',false,{mobile:true,token:ticket.token}));const fresh=await mobileTicket(other.identity);assert.notEqual(fresh.token,ticket.token);
          const rejoined=await join(other.identity,'owner',false,{mobile:true,token:fresh.token,localDoc:writer.doc});
          await waitUntil(()=>actualDocuments.get(other.identity.documentId)?.getText('content').toString()==='ABC-REJOIN'&&observer.doc.getText('content').toString()==='ABC-REJOIN','Fresh Mobile state-vector handshake did not recover the retained once-sent edit.');await flushCollaborationDocuments();
          const state=await loadCollaborationState(other.identity.documentId);assert(state);const durable=new Y.Doc();Y.applyUpdate(durable,state.yjsState);assert.equal(durable.getText('content').toString(),'ABC-REJOIN');durable.destroy();rejoined.socket.close();
        }finally{release.resolve();await peerBusy?.holding;peerBusy=undefined;await dispose(cap);writer.socket.close();observer.socket.close();writer.doc.destroy();observer.doc.destroy();}
      });
      await flushCollaborationDocuments();assert.equal(fetches,0);
      console.log(`Authenticated native actual Socket PG18: ${cases} real network/SQL/auth/Owner/apply/Store families passed.`);
    }finally{
      for(const socket of sockets)socket.terminate();
      await waitUntil(()=>[...actualRuntime.hocuspocus?.documents.values()??[]].every(document=>document.getConnectionsCount()===0),'Own fixture Socket connections did not close.');
      await flushCollaborationDocuments();
      if(actualRuntime.hocuspocus){await Promise.allSettled([...actualRuntime.hocuspocus.documents.values()].map(document=>actualRuntime.hocuspocus!.unloadDocument(document)));await Promise.allSettled([...actualRuntime.hocuspocus.unloadingDocuments.values()]);}
      await new Promise<void>(done=>wss.close(()=>done()));
      await new Promise<void>(done=>server.close(()=>done()));
      // These are exclusively this random fixture's synthetic in-memory Docs.
      // Its native Store was flushed; release their Awareness intervals too.
      for(const document of actualDocuments.values())document.destroy();
      Hocuspocus.prototype.hooks=originalHooks;
    }
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
main().catch(error=>{console.error('Actual native Socket fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null});process.exitCode=1;});
