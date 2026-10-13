import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, types as pgTypes } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceRequestPrincipal } from '../app/lib/workspaces/request-principal';
import type { ExistingNativeCollaborationSession, ExistingNativeSessionIdentity } from '../app/lib/collaboration/native-session-state-reader';

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
  const schema = `raw_session_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^raw_session_[a-f0-9]{32}$/u);
  const workspaceId = `native-raw-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-raw-native-session-'));
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async (bigintStrings=false) => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      ...(bigintStrings?{types:{getTypeParser:(oid:number,format?:'text'|'binary')=>oid===20?(value:string)=>value:pgTypes.getTypeParser(oid,format)}}:{}),
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
    const { auth } = await import('../app/lib/auth');
    const { withWorkspaceRequestPrincipal:capture } = await import('../app/lib/workspaces/request-principal');
    const { withAuthenticatedExistingNativeCollaborationSessionOnConnection:readSession,
      withExistingNativeCollaborationSessionOnConnection:readOnlySession,
      assertExistingNativeCollaborationSessionCurrentOnConnection:current,
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
    const transaction = async <T>(operation:(db:SqlConnection,client:Client)=>Promise<T>,begin='BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',bigintStrings=false) => {
      const client=await ownClient(bigintStrings);await client.query(begin);
      try{return await operation(connection(client),client);}
      finally{await client.query('ROLLBACK').catch(()=>undefined);await endClient(client);}
    };
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Raw consistency family completed: ${name}`);};
    const captured=async<T>(operation:(principal:WorkspaceRequestPrincipal)=>Promise<T>,userId='owner',cookie=false)=>capture(await request(userId,cookie),{permission:'canRead',workspaceId},operation);
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
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { COLLABORATION_FAILURE_CODES, isCollaborationStateQuarantined } = await import('../app/lib/collaboration/failure');
    const { COLLABORATION_CHECKPOINT_ERROR_CODES } = await import('../app/lib/collaboration/checkpoint-errors');
    const selected=await requireRequestWorkspace(await request('owner',true),{workspaceId,permissions:'canRead'});
    assert(!selected.response);const workspace=selected.workspace;
    assert.equal((await auth.api.getSession({headers:(await request()).headers}))?.session.id,'session-owner');
    const lostMetadata:string[]=[];
    const roundtrip=COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable;
    type Case={name:string;allow:boolean;code:string|null;permanent:number;degraded:number;sequence:number|null;
      errorGeneration:number|null;generation?:number;phase:string|null};
    const casesToInspect:Case[]=[
      {name:'healthy-cleared-tuple',allow:true,code:null,permanent:0,degraded:0,sequence:null,errorGeneration:null,phase:null},
      {name:'nonpermanent-projection-failure',allow:true,code:roundtrip,permanent:0,degraded:0,sequence:7,errorGeneration:1,phase:'serialize'},
      {name:'retryable-binary-persistence-failure',allow:true,code:COLLABORATION_FAILURE_CODES.persistenceFailed,permanent:0,degraded:1,sequence:7,errorGeneration:1,phase:'binary_persist'},
      {name:'historical-nonpermanent-error',allow:true,code:roundtrip,permanent:0,degraded:0,sequence:7,errorGeneration:1,generation:2,phase:'serialize'},
      {name:'legacy-degraded-no-code',allow:false,code:null,permanent:0,degraded:1,sequence:null,errorGeneration:null,phase:null},
      {name:'valid-current-permanent-error',allow:false,code:roundtrip,permanent:1,degraded:1,sequence:7,errorGeneration:1,phase:'serialize'},
      {name:'current-permanent-even-if-degraded-zero',allow:false,code:roundtrip,permanent:1,degraded:0,sequence:7,errorGeneration:1,phase:'serialize'},
      {name:'code-alone-missing-clocks',allow:false,code:roundtrip,permanent:0,degraded:0,sequence:null,errorGeneration:null,phase:null},
      {name:'orphan-permanent-missing-code',allow:false,code:null,permanent:1,degraded:0,sequence:null,errorGeneration:null,phase:null},
      {name:'orphan-error-phase',allow:false,code:null,permanent:0,degraded:0,sequence:null,errorGeneration:null,phase:'serialize'},
      {name:'orphan-error-sequence',allow:false,code:null,permanent:0,degraded:0,sequence:7,errorGeneration:null,phase:null},
      {name:'orphan-error-generation',allow:false,code:null,permanent:0,degraded:0,sequence:null,errorGeneration:1,phase:null},
      {name:'future-error-sequence',allow:false,code:roundtrip,permanent:0,degraded:0,sequence:8,errorGeneration:1,phase:'serialize'},
      {name:'future-error-generation',allow:false,code:roundtrip,permanent:0,degraded:0,sequence:7,errorGeneration:2,phase:'serialize'},
      {name:'historical-permanent-error',allow:false,code:roundtrip,permanent:1,degraded:0,sequence:7,errorGeneration:1,generation:2,phase:'serialize'},
    ];
    for(const scenario of casesToInspect)await check(scenario.name,async()=>{
      for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const){
        const target=await seed(`${scenario.name}-${representation}`,representation);
        await admin.query(`UPDATE collaboration_yjs_states SET lifecycle_generation=$2,projection_error_code=$3,
          projection_error_permanent=$4,degraded=$5,projection_error_sequence=$6,projection_error_generation=$7,
          projection_error_phase=$8 WHERE document_id=$1`,[target.identity.documentId,scenario.generation??1,scenario.code,
          scenario.permanent,scenario.degraded,scenario.sequence,scenario.errorGeneration,scenario.phase]);
        const identity={...target.identity,lifecycleGeneration:scenario.generation??1},before=await stored(identity);
        for(const bigintStrings of [false,true])for(const entry of ['readonly','authenticated-cookie','authenticated-bearer'] as const){
          let visited=0,observed:Record<string,unknown>|undefined,failure:unknown;
          const consume=async(cap:ExistingNativeCollaborationSession)=>{
            visited++;const snapshot=cap.snapshot;await current(active!,cap);
            observed={degraded:snapshot.degraded,hasProjectionError:!!snapshot.projectionError,
              permanent:snapshot.projectionError?.permanent??null,quarantined:isCollaborationStateQuarantined(snapshot)};
            assert.equal(inspect(active!,cap,native=>native.content.kind),representation==='plain_text'?'plain_text':'rich_text');
          };
          let active:SqlConnection|undefined;
          try{
            const verifyType=async(db:SqlConnection)=>{const parsed=await db.get('SELECT projection_error_permanent FROM collaboration_yjs_states WHERE document_id=$1',[identity.documentId]) as {projection_error_permanent:unknown};
              assert.equal(typeof parsed.projection_error_permanent,bigintStrings?'string':'number');};
            if(entry==='readonly')await transaction(async db=>{active=db;await verifyType(db);await readOnlySession(db,{workspace,...input(identity)},consume);},
              'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',bigintStrings);
            else await captured(p=>transaction(async db=>{active=db;await verifyType(db);await readSession(db,p,input(identity),consume);},
              'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',bigintStrings),
              'owner',entry==='authenticated-cookie');
          }catch(error){failure=error;}
          assert.deepEqual(await stored(identity),before,'The reader must not repair or normalize persisted raw evidence.');
          const permitted=failure===undefined;
          console.log('Actual raw consistency observation:',{case:scenario.name,representation,entry,bigintStrings,permitted,visited,
            rawPermanent:before.projection_error_permanent,rawDegraded:before.degraded,rawErrorCode:before.projection_error_code,
            rawErrorGeneration:before.projection_error_generation,observed,errorCode:failure&&typeof failure==='object'?Reflect.get(failure,'code'):null});
          if(scenario.allow){assert.equal(permitted,true);assert.equal(visited,1);}
          else if(permitted)lostMetadata.push(`${scenario.name}/${representation}/${entry}/${bigintStrings?'string':'number'}`);
          else{assert.equal(visited,0);assert(failure&&typeof failure==='object');
            const expectedCode=['legacy-degraded-no-code','valid-current-permanent-error','current-permanent-even-if-degraded-zero'].includes(scenario.name)
              ?'NATIVE_SESSION_QUARANTINED':'NATIVE_SESSION_STATE_INVALID';
            assert.equal(Reflect.get(failure,'code'),expectedCode);}
        }
      }
    });
    assert.equal(fetches,0);
    console.log('Current exact-source evidence:',{families:cases,unexpectedAdmissions:lostMetadata.length,counterexamples:lostMetadata});
    stage='final strict capability admission assertion';
    assert.deepEqual(lostMetadata,[], 'Malformed permanent/error metadata must reject before exposing either native reader capability.');
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
main().catch(error=>{console.error('Owned raw-session consistency fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  constraint:error&&typeof error==='object'?Reflect.get(error,'constraint')??null:null});process.exitCode=1;});
