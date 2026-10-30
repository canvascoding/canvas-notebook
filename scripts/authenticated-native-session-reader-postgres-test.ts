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
  const schema = `authenticated_session_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^authenticated_session_[a-f0-9]{32}$/u);
  const workspaceId = `native-auth-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-auth-native-session-'));
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
    const { withWorkspaceRequestPrincipal:capture,withWorkspaceRequestPrincipalOnConnection:principalPhase } = await import('../app/lib/workspaces/request-principal');
    const { withAuthenticatedExistingNativeCollaborationSessionOnConnection:readSession,
      withExistingNativeCollaborationSessionOnConnection:readOnlySession,
      assertExistingNativeCollaborationSessionCurrentOnConnection:current,
      inspectExistingNativeCollaborationSessionOnConnection:inspect } = await import('../app/lib/collaboration/native-session-state-reader');
    const { createPlainTextYDoc,createRichMarkdownYDoc,validateRichMarkdownYDoc,richMarkdownSchemaExtensions } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const { getSchema } = await import('@tiptap/core');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const { persistCollaborationYDoc } = await import('../app/lib/collaboration/persistence');
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { collaborationAdmissionActionDigest,collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
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
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Authenticated native session passed: ${name}`);};
    const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&Reflect.get(error,'code')===expected;
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
    const native=await seed('native-existing');
    await check('actual cookie/bearer trusted Team rights read native Plain/XML/Blocks/empty',async()=>{
      for(const cookie of [true,false]) for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const) for(const empty of [true,false]){
        const target=await seed(`${representation}-${empty}-${cookie}`,representation,{empty,profile:true});const before=await stored(target.identity);
        const actual=await request('member',cookie);assert.equal((await auth.api.getSession({headers:actual.headers}))?.session.id,'session-member');
        await capture(actual,{permission:'canRead',workspaceId},p=>transaction(db=>readSession(db,p,input(target.identity),async cap=>{
          const value=await current(db,cap);assert.equal(value.stateProof,target.proof);assert.equal(value.stateVector,target.vector.toString('base64'));
          assert.equal(value.hasBom,true);assert.equal(value.newlineStyle,'crlf');assert.equal(value.documentSequence,empty?0:7);
          assert(!/yjsState|canonicalHash|serializedHash|content|frontmatter|canWrite|token/u.test(JSON.stringify(value)));
          assert.equal(inspect(db,cap,snapshot=>snapshot.content.kind),representation==='plain_text'?'plain_text':'rich_text');
        })));
        assert.deepEqual(await stored(target.identity),before);
      }
    });
    await check('nonexportable legal Rich keeps exact binary without disk source',async()=>{
      const doc=createRichMarkdownYDoc('| Keep |\n| --- |\n| value |','tiptap_blocks');
      try{const tree=new CollaborationBlockTree(doc,getSchema(richMarkdownSchemaExtensions()));
        for(const row of tree.records.values())if(['tableCell','tableHeader'].includes((row.get('shape') as {type:string}).type))
          (row.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth',[120]);
        assert.equal(validateRichMarkdownYDoc(doc).code,'roundtrip_unstable');const target=await seed('nonexportable','tiptap_blocks',{doc});const before=await stored(target.identity);
        await captured(p=>transaction(db=>readSession(db,p,input(target.identity),async cap=>{await current(db,cap);inspect(db,cap,snapshot=>assert.equal(snapshot.content.kind,'rich_text'));})));
        assert.deepEqual(await stored(target.identity),before);
      }finally{doc.destroy();}
    });
    await check('copied input protects path/identity across first await',async()=>{
      await captured(p=>transaction(async db=>{const mutable={path:native.identity.path,expectedIdentity:{...native.identity}};
        const pending=readSession(db,p,mutable,async cap=>assert.equal(cap.snapshot.documentId,native.identity.documentId));
        mutable.path='foreign.md';mutable.expectedIdentity.path='foreign.md';mutable.expectedIdentity.lifecycleGeneration=2;await pending;
      }));
    });
    await check('malformed/accessor/extra fields and wrong identity reject with zero visitor',async()=>{
      const variants=[{path:'../escape.md'},{path:'native.docx'},{path:native.identity.path,workspace:{}},
        {path:native.identity.path,readOnly:false},Object.defineProperty({},'path',{enumerable:true,get:()=>native.identity.path}),
        {...input(native.identity),expectedIdentity:{...native.identity,lifecycleGeneration:2}}];
      for(const variant of variants){let visits=0;await assert.rejects(captured(p=>transaction(db=>readSession(db,p,variant as ReturnType<typeof input>,async()=>{visits++;}))));assert.equal(visits,0);}
      await assert.rejects(captured(p=>transaction(async db=>{await assert.rejects(readSession(db,p,{path:'../escape.md'},async()=>assert.fail()),code('NATIVE_SESSION_INVALID'));})),code('NATIVE_SESSION_INVALID'));
    });
    await check('forged/copy/retained principal and wrong transaction give no capability',async()=>{
      await transaction(db=>assert.rejects(readSession(db,{} as WorkspaceRequestPrincipal,input(native.identity),async()=>assert.fail()),code('PRINCIPAL_REQUIRED')));
      let retained!:WorkspaceRequestPrincipal;await captured(async p=>{retained=p;});
      await transaction(db=>assert.rejects(readSession(db,retained,input(native.identity),async()=>assert.fail()),code('PRINCIPAL_REQUIRED')));
      for(const begin of ['BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY','BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'])
        await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async()=>assert.fail()),begin)),code('PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(captured(async p=>{const c=await ownClient();try{await readSession(connection(c),p,input(native.identity),async()=>assert.fail());}finally{await endClient(c);}}),code('PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('original RO API still works and cannot borrow private RW authorization',async()=>{
      await captured(p=>transaction(db=>principalPhase(db,p,async access=>{
        await assert.rejects(readOnlySession(db,{workspace:access.workspace,...input(native.identity)},async()=>assert.fail()),code('NATIVE_SESSION_SCOPE_CHANGED'));
      })));
      // Obtain the real workspace outside the held SQL phase for the unchanged RO path.
      const {requireRequestWorkspace}=await import('../app/lib/workspaces/request');const real=await requireRequestWorkspace(await request(),{workspaceId,permissions:'canRead'});assert(!real.response);
      await transaction(db=>readOnlySession(db,{workspace:real.workspace,...input(native.identity)},async cap=>assert.equal(cap.snapshot.stateProof,native.proof)),'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async()=>{
        await assert.rejects(readOnlySession(db,{workspace:real.workspace,...input(native.identity)},async()=>assert.fail()),code('NATIVE_SESSION_REENTRANT'));
      }))),code('NATIVE_SESSION_REENTRANT'));
    });
    for(const [name,change,restore,expected,userId] of [
      ['token CAS',"UPDATE session SET token='replaced' WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED','owner'],
      ['expired session',"UPDATE session SET expires_at=1 WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED','owner'],
      ['deleted session',"DELETE FROM session WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED','owner'],
      ['banned despite old ban expiry',"UPDATE \"user\" SET banned=1,ban_expires=1 WHERE id='owner'","UPDATE \"user\" SET banned=0,ban_expires=NULL WHERE id='owner'",'SEAT_ACCESS_INACTIVE','owner'],
      ['revoked org ACL',"UPDATE organization_user_permissions SET status='disabled' WHERE user_id='member'","UPDATE organization_user_permissions SET status='active' WHERE user_id='member'",'SEAT_MEMBERSHIP_REQUIRED','member'],
      ['seat rank change',"UPDATE team_memberships SET status='active' WHERE id='inactive-seat'; UPDATE organization_user_permissions SET status='active' WHERE user_id='inactive'","UPDATE team_memberships SET status='suspended' WHERE id='inactive-seat'; UPDATE organization_user_permissions SET status='disabled' WHERE user_id='inactive'",'SEAT_LIMIT_EXCEEDED','member'],
    ] as const)await check(name,async()=>{
      const before=await stored(native.identity);let visitors=0;
      try{await assert.rejects(captured(async p=>{await admin.query(change);await transaction(db=>readSession(db,p,input(native.identity),async()=>{visitors++;}));},userId),code(expected));}
      finally{if(restore)await admin.query(restore);await seedSession(userId);}assert.equal(visitors,0);assert.deepEqual(await stored(native.identity),before);
    });
    await check('invalid actual cookie cannot create outer principal',async()=>{
      const actual=await request('owner',true);actual.headers.set('cookie',actual.headers.get('cookie')+'tampered');
      await assert.rejects(capture(actual,{permission:'canRead'},async()=>assert.fail()),code('PRINCIPAL_AUTH_REVOKED'));
    });
    await check('auth revalidated after native binary read before visitor',async()=>{
      await assert.rejects(captured(p=>transaction(async(db,client)=>{
        let revoked=false;const wrapped:SqlConnection={...db,get:async(sql,args)=>{const row=(await client.query(sql,args)).rows[0];
          if(!revoked&&sql.includes('SELECT * FROM')&&sql.includes('collaboration_yjs_states WHERE')){revoked=true;await client.query("UPDATE session SET expires_at=1 WHERE id='session-owner'");}return row;}};
        await readSession(wrapped,p,input(native.identity),async()=>assert.fail('Visitor cannot run after SQL-phase session expiry.'));
      })),code('PRINCIPAL_AUTH_REVOKED'));
    });
    await check('own SQL session/ACL revocation and final callback expiry are fatal',async()=>{
      for(const sql of ["UPDATE session SET expires_at=1 WHERE id='session-owner'","UPDATE organization_user_permissions SET status='disabled' WHERE user_id='owner'"])
        await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async cap=>{
          await db.run(sql);await assert.rejects(current(db,cap));
        }))));
    });
    await check('wrong connection/wrapper/forged/retained native capability poisons actual phase',async()=>{
      for(const variant of ['wrapper','foreign','forged'])await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async cap=>{
        const peer=await ownClient();await peer.query('BEGIN');try{
          await assert.rejects(current(variant==='wrapper'?{...db}:variant==='foreign'?connection(peer):db,
            variant==='forged'?Object.freeze({snapshot:cap.snapshot}):cap),code('NATIVE_SESSION_REQUIRED'));
        }finally{await peer.query('ROLLBACK');await endClient(peer);}
      }))),code('NATIVE_SESSION_REQUIRED'));
      let old!:ExistingNativeCollaborationSession;await captured(p=>transaction(db=>readSession(db,p,input(native.identity),async cap=>{old=cap;})));
      assert.throws(()=>old.snapshot,code('NATIVE_SESSION_REQUIRED'));
      await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async()=>{await assert.rejects(current(db,old),code('NATIVE_SESSION_REQUIRED'));}))),code('NATIVE_SESSION_REQUIRED'));
    });
    await check('same DB supersession rejects retained getter and poisons successor',async()=>{
      await assert.rejects(captured(p=>transaction(async(db)=>{let old!:ExistingNativeCollaborationSession;
        await readSession(db,p,input(native.identity),async cap=>{old=cap;});await db.run('COMMIT');await db.run('BEGIN');
        await readSession(db,p,input(native.identity),async()=>{assert.throws(()=>old.snapshot,code('NATIVE_SESSION_REQUIRED'));});
      })),code('NATIVE_SESSION_REQUIRED'));
    });
    await check('caught forged principal/invalid request and detached current cannot complete',async()=>{
      for(const variant of ['principal','invalid','detached'])await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async cap=>{
        if(variant==='detached'){void current(db,cap).catch(()=>undefined);return;}
        await assert.rejects(readSession(db,variant==='principal'?{} as WorkspaceRequestPrincipal:p,
          variant==='invalid'?{path:'../escape.md'}:input(native.identity),async()=>assert.fail()));
      }))));
    });
    await check('expired native capability during authenticated completion remains fatal',async()=>{
      // #2 is the reader callback's explicit final assertion; #3 is the
      // unchanged Principal service's genuine check AFTER that callback.
      for(const finalWindow of [2,3])for(const variant of ['current','inspect','getter','wrong-wrapper','forged','prior-getter']){
        let attempted=false;
        await assert.rejects(captured(p=>transaction(async(db,client)=>{
          let retained!:ExistingNativeCollaborationSession,reads=0,finalAuthChecks=0,armed=false;
          const wrapped:SqlConnection={...db,get:async(sql,args)=>{
            const row=(await client.query(sql,args)).rows[0];
            if(sql.includes('SELECT * FROM')&&sql.includes('collaboration_yjs_states WHERE'))reads++;
            // The actual Member check now returns account/session facts in
            // the joint snapshot. Observe that real reply, not its old SQL.
            const memberReply=sql.includes('SELECT header.*,account.*,')&&sql.includes(' AS token_hash');
            if(armed&&reads===2&&memberReply&&++finalAuthChecks===finalWindow){
              attempted=true;
              if(variant==='getter'||variant==='prior-getter')assert.throws(()=>retained.snapshot,code('NATIVE_SESSION_REQUIRED'));
              else if(variant==='inspect')assert.throws(()=>inspect(wrapped,retained,()=>assert.fail()),code('NATIVE_SESSION_REQUIRED'));
              else await assert.rejects(current(variant==='wrong-wrapper'?{...wrapped}:wrapped,
                variant==='forged'?{} as ExistingNativeCollaborationSession:retained),code('NATIVE_SESSION_REQUIRED'));
            }
            return row;
          }};
          if(variant==='prior-getter'){
            await readSession(wrapped,p,input(native.identity),async cap=>{retained=cap;});
            await wrapped.run('COMMIT; BEGIN');reads=0;finalAuthChecks=0;
          }
          armed=true;
          await readSession(wrapped,p,input(native.identity),async cap=>{if(variant!=='prior-getter')retained=cap;});
        })),code('NATIVE_SESSION_REQUIRED'));
        assert.equal(attempted,true);
      }
    });
    await check('actual backend/XID/searchpath switching cannot retain authenticated authority',async()=>{
      for(const variant of ['backend','transaction','searchpath'])await assert.rejects(captured(p=>transaction(async(db,client)=>{
        const peer=await ownClient();await peer.query('BEGIN');let active=client;
        const wrapped:SqlConnection={get:async(sql,args)=>(await active.query(sql,args)).rows[0],all:async(sql,args)=>(await active.query(sql,args)).rows,
          run:async(sql,args)=>({changes:(await active.query(sql,args)).rowCount??0}),close:()=>assert.fail()};
        try{await readSession(wrapped,p,input(native.identity),async cap=>{
          if(variant==='backend')active=peer;else if(variant==='transaction')await wrapped.run('COMMIT; BEGIN');else await wrapped.run('SET LOCAL search_path=pg_catalog');
          await assert.rejects(current(wrapped,cap));
        });}finally{await peer.query('ROLLBACK');await endClient(peer);}
      })));
    });
    await check('native lifecycle drift and raw schema/quarantine/missing never seed or fallback',async()=>{
      for(const kind of ['generation','lineage','path','quarantine','missing','xml-attribute']){
        stage=`native lifecycle drift: ${kind}`;
        const doc=kind==='xml-attribute'?createRichMarkdownYDoc('Raw native','tiptap_xml'):undefined;
        if(doc)(doc.getXmlFragment('body').toArray()[0] as InstanceType<typeof Y.XmlElement>).setAttribute('future-attr','untrusted');
        const target=await seed(`invalid-${kind}`,doc?'tiptap_xml':'plain_text',{doc});doc?.destroy();
        if(kind==='generation')await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1',[target.identity.documentId]);
        if(kind==='lineage')await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=100 WHERE id=$1",[target.identity.lineageId]);
        if(kind==='path')await admin.query("UPDATE collaboration_yjs_states SET path='changed.md' WHERE document_id=$1",[target.identity.documentId]);
        if(kind==='quarantine')await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1',[target.identity.documentId]);
        if(kind==='missing')await admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1',[target.identity.documentId]);
        const before=await stored(target.identity);let visits=0;await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(target.identity),async()=>{visits++;}))));
        assert.equal(visits,0);assert.deepEqual(await stored(target.identity),before);
      }
    });
    await check('real active owner peer store/delete advances under native shared fence',async()=>{
      const doc=createPlainTextYDoc('ABC'),target=await seed('active-owner','plain_text',{doc}),client=await ownClient(),owner=await createCollaborationRoomOwnerSession(client);
      try{const{lineageId:_lineage,...scope}=target.identity;const fence=await owner.acquire(scope);
        await captured(p=>transaction(db=>readSession(db,p,input(target.identity),async cap=>{
          const before=await current(db,cap);doc.getText('content').delete(0,1);
          const saved=await persistCollaborationYDoc(scope.documentId,scope.lifecycleGeneration,doc,scope,fence);
          assert.equal(saved.documentSequence,8);const after=await current(db,cap);
          assert.equal(after.documentSequence,8);assert.equal(after.stateVector,before.stateVector);assert.notEqual(after.stateProof,before.stateProof);
          inspect(db,cap,snapshot=>{assert.equal(snapshot.content.kind,'plain_text');if(snapshot.content.kind==='plain_text')assert.equal(snapshot.content.text,'BC');});
        })));
        assert.equal((await stored(target.identity)).document_sequence,8);
      }finally{doc.destroy();await owner.close();clients.delete(client);}
    });
    await check('actual bigint shared key excludes lifecycle exclusive and real reservation denies',async()=>{
      await captured(p=>transaction(db=>readSession(db,p,input(native.identity),async()=>{
        const peer=await ownClient();try{const locked=(await peer.query('SELECT pg_try_advisory_lock($1::bigint) AS locked',[collaborationAdmissionLockKey(workspaceId)])).rows[0].locked;assert.equal(locked,false);}
        finally{await endClient(peer);}
      })));
      const target=await seed('reserved'),admission=createCollaborationAdmissionService({openConnection:async()=>{
        const client=await ownClient();return{...connection(client),close:()=>endClient(client)};
      }});
      const{lineageId:_lineage,...identity}=target.identity,payload=JSON.stringify({targetPath:'renamed.md'});
      await admission.reserve({requestId:crypto.randomUUID(),actorId:'owned-fixture',action:'rename',actionPayloadText:payload,actionDigest:collaborationAdmissionActionDigest('rename',payload),
        scopes:[{workspaceId,organizationId:'principal-org',path:identity.path,kind:'exact'}],expectedDocuments:[{...identity,status:'active'}]});
      await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(target.identity),async()=>assert.fail()))),code('NATIVE_SESSION_BUSY'));
    });
    await check('actual trusted Solo owner remains readable and member has no capability',async()=>{
      const soloBody=Buffer.from(JSON.stringify({...claims,edition:'solo',seatLimit:1,quotas:{users:1},entitlementsVersion:7})).toString('base64url');
      process.env.CANVAS_LICENSE_CERT=`${header}.${soloBody}.${crypto.sign('RSA-SHA256',Buffer.from(`${header}.${soloBody}`),keys.privateKey).toString('base64url')}`;
      assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT,process.env.CANVAS_INSTANCE_ID!)).ok,true);
      const solo=await getLicenseStatus();assert.equal(solo.edition,'solo');assert.equal(solo.licensed,true);
      await captured(p=>transaction(db=>readSession(db,p,input(native.identity),async cap=>assert.equal(cap.snapshot.documentId,native.identity.documentId))));
      await assert.rejects(captured(async()=>assert.fail(),'member'),code('PRINCIPAL_AUTH_REVOKED'));
    });
    assert.equal(fetches,0);
    console.log(`Authenticated existing-only native session: ${cases} actual PostgreSQL18/BetterAuth/Team+Solo matrix families passed; no reader activation.`);
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
main().catch(error=>{console.error('Owned authenticated session fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  constraint:error&&typeof error==='object'?Reflect.get(error,'constraint')??null:null});process.exitCode=1;});
