import assert from 'node:assert/strict';
import { mock } from 'node:test';
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
  const schema = `native_ticket_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_ticket_[a-f0-9]{32}$/u);
  const workspaceId = `native-transport-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-ticket-access-'));
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
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Native ticket passed: ${name}`);};
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

    const { issueAuthenticatedMobileCollaborationTicket:issue,issueMobileCollaborationTicket:legacyIssue,
      consumeMobileCollaborationTicket:consume,disposeMobileCollaborationTickets:disposeTickets } = await import('../app/lib/mobile/collaboration-ticket');
    const native=await seed(' exact native ticket ');
    const ticketClaims={userId:'owner',sessionId:'session-owner',workspaceId,organizationId:'principal-org',
      documentId:native.identity.documentId,path:native.identity.path,provider:'yjs' as const,representation:'plain_text' as const,
      permission:'write' as const,lifecycleGeneration:1};
    const ticketUser={id:'owner',name:'Original Owner',email:'owner@principal.test',role:'admin'};
    const captured=async(cookie=false)=>transaction(async db=>{
      const actual=await request('owner',cookie);
      assert.equal((await auth.api.getSession({headers:actual.headers}))?.session.id,'session-owner');
      return enroll(db,actual,{workspaceId,maxPermission:'canWrite'});
    });
    const read=async(transport:AuthenticatedNativeSessionTransport)=>transaction(db=>phase(db,transport,
      {permission:'canWrite',path:native.identity.path,expectedIdentity:native.identity},async(doc,access)=>{
        assert.equal(access.userId,'owner');assert.equal(access.sessionId,'session-owner');
        assert.equal(doc.snapshot.documentId,native.identity.documentId);await access.assertCurrent();
      }));
    const issueOwned=(cap:AuthenticatedNativeSessionTransport)=>issue({claims:{...ticketClaims},user:{...ticketUser},takeTransport:()=>cap});
    const disposed=async(cap:AuthenticatedNativeSessionTransport)=>assert.rejects(read(cap),code('NATIVE_TRANSPORT_DISPOSED'));
    await check('actual Cookie/Bearer transport is private, single-use and owned by the consumed socket',async()=>{
      for(const cookie of [true,false]){
        const cap=await captured(cookie),ticket=issueOwned(cap);
        assert.equal('authenticatedTransport' in ticket,false);
        assert.deepEqual(Object.keys(ticket).sort(),['claims','expiresAt','token']);
        assert.equal(ticket.claims.expiresAt-ticket.claims.issuedAt,30_000);
        assert(!JSON.stringify(ticket).includes(tokens.owner),'HTTP output cannot include the original auth token');
        const identity=consume(ticket.token);assert(identity);
        assert.equal(identity.authenticatedTransport,cap);assert.equal(consume(ticket.token),null);
        await read(cap);await dispose(cap);await disposed(cap);
      }
    });
    await check('native claim and user copies resist mutation after adoption',async()=>{
      const cap=await captured(),copiedClaims={...ticketClaims},copiedUser={...ticketUser};
      const ticket=issue({claims:copiedClaims,user:copiedUser,takeTransport:()=>cap});
      copiedClaims.path='changed.md';copiedClaims.userId='wrong';copiedUser.name='changed';
      assert(Object.isFrozen(ticket.claims));
      const identity=consume(ticket.token);assert(identity);
      assert.equal(identity.claims.path,native.identity.path);assert.equal(identity.claims.userId,'owner');
      assert.equal(identity.user.name,'Original Owner');assert(Object.isFrozen(identity.user));
      await read(cap);await dispose(cap);
    });
    await check('invalid, accessor, guest and mismatched-user tickets reject before taking transport',async()=>{
      let takes=0;const cap=await captured();
      const takeTransport=()=>{takes++;return cap;};
      const invalid=[{...ticketClaims,path:'../unsafe.md'},{...ticketClaims,userId:'different'},
        {...ticketClaims,guestInvitationId:'guest'},{...ticketClaims,representation:'excalidraw_scene'},
        {...ticketClaims,organizationId:undefined},{...ticketClaims,lifecycleGeneration:0}];
      for(const item of invalid)assert.throws(()=>issue({claims:item as typeof ticketClaims,user:{...ticketUser},takeTransport}));
      const accessor={...ticketClaims};Object.defineProperty(accessor,'path',{enumerable:true,get:()=>native.identity.path});
      assert.throws(()=>issue({claims:accessor,user:{...ticketUser},takeTransport}));
      assert.equal(takes,0);await read(cap);await dispose(cap);
    });
    await check('publisher rollback removes exactly the adopted ticket and clears its original credentials',async()=>{
      const cap=await captured();let rollback!:()=>void|Promise<void>;
      const ticket=issue({claims:{...ticketClaims},user:{...ticketUser},takeTransport:cleanup=>{rollback=cleanup;return cap;}});
      await rollback();await rollback();assert.equal(consume(ticket.token),null);await disposed(cap);
    });
    await check('owned TTL timer disposes an unused real transport without subsequent ticket activity',async()=>{
      const cap=await captured();mock.timers.enable({apis:['setTimeout']});
      let ticket:ReturnType<typeof issue>;
      try{ticket=issueOwned(cap);mock.timers.tick(30_001);}finally{mock.timers.reset();}
      await disposed(cap);assert.equal(consume(ticket!.token),null);
    });
    await check('consume cancels TTL ownership; original deadline never disposes an active socket transport',async()=>{
      const cap=await captured();mock.timers.enable({apis:['setTimeout']});
      try{const ticket=issueOwned(cap);assert.equal(consume(ticket.token)?.authenticatedTransport,cap);mock.timers.tick(60_000);}
      finally{mock.timers.reset();}
      await read(cap);await dispose(cap);
    });
    await check('sixth native ticket evicts and disposes only the oldest of five per user',async()=>{
      const caps:AuthenticatedNativeSessionTransport[]=[],tickets:ReturnType<typeof issue>[]=[];
      for(let i=0;i<6;i++){const cap=await captured();caps.push(cap);tickets.push(issueOwned(cap));}
      assert.equal(consume(tickets[0].token),null);await disposed(caps[0]);
      for(let i=1;i<6;i++){assert.equal(consume(tickets[i].token)?.authenticatedTransport,caps[i]);await read(caps[i]);await dispose(caps[i]);}
    });
    await check('legacy ticket issuance cannot orphan an evicted native original transport',async()=>{
      const cap=await captured(),ticket=issueOwned(cap);
      for(let i=0;i<5;i++)legacyIssue({claims:{...ticketClaims},user:{...ticketUser}});
      assert.equal(consume(ticket.token),null);await disposed(cap);disposeTickets();
    });
    await check('host store teardown clears stored transports while consumed socket retains exclusive ownership',async()=>{
      const socketCap=await captured(),socketTicket=issueOwned(socketCap);
      assert.equal(consume(socketTicket.token)?.authenticatedTransport,socketCap);
      const capA=await captured(),capB=await captured(),a=issueOwned(capA),b=issueOwned(capB);
      disposeTickets();assert.equal(consume(a.token),null);assert.equal(consume(b.token),null);
      await disposed(capA);await disposed(capB);await read(socketCap);await dispose(socketCap);
    });
    await check('failed publisher adoption never creates a consumable record',async()=>{
      const cap=await captured();let takes=0;
      assert.throws(()=>issue({claims:{...ticketClaims},user:{...ticketUser},takeTransport:()=>{takes++;throw new Error('Publisher rejects transfer');}}));
      assert.equal(takes,1);await read(cap);await dispose(cap);
    });
    await check('synchronous cancelled adoption clears transport without inserting an orphan ticket',async()=>{
      const cap=await captured();
      assert.throws(()=>issue({claims:{...ticketClaims},user:{...ticketUser},takeTransport:cleanup=>{void cleanup();return cap;}}));
      await disposed(cap);
    });
    disposeTickets();assert.equal(fetches,0);
    console.log(`Authenticated mobile tickets PG18: ${cases} genuine Cookie/Bearer/ownership families passed; actual timer callbacks use a deterministic clock; no Socket activation.`);
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
main().catch(error=>{console.error('Owned authenticated mobile ticket fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  constraint:error&&typeof error==='object'?Reflect.get(error,'constraint')??null:null});process.exitCode=1;});
