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
  const schema = `callback_access_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^callback_access_[a-f0-9]{32}$/u);
  const workspaceId = `native-callback-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-callback-access-'));
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
    const { withWorkspaceRequestPrincipal:capture } = await import('../app/lib/workspaces/request-principal');
    const { withAuthenticatedExistingNativeCollaborationSessionOnConnection:readSession,
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
    const transaction = async <T>(operation:(db:SqlConnection,client:Client)=>Promise<T>,begin='BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') => {
      const client=await ownClient();await client.query(begin);
      try{return await operation(connection(client),client);}
      finally{await client.query('ROLLBACK').catch(()=>undefined);await endClient(client);}
    };
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Native callback access passed: ${name}`);};
    const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&Reflect.get(error,'code')===expected;
    const captured=async<T>(operation:(principal:WorkspaceRequestPrincipal)=>Promise<T>,userId='member',permission:'canRead'|'canWrite'='canRead',cookie=false)=>
      capture(await request(userId,cookie),{permission,workspaceId},operation);
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
    const native=await seed('callback-native');
    const permissionRow=async(client:Client=admin)=>(await client.query("SELECT can_write_team_workspace FROM organization_user_permissions WHERE user_id='member'")).rows[0].can_write_team_workspace;
    const withWriter=async(operation:()=>Promise<void>)=>{
      await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
      try{await operation();}finally{await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");}
    };
    await check('genuine Cookie/Bearer same-B entry rights distinguish read-only and required-write phases',async()=>{
      for(const cookie of [true,false])for(const userId of ['member','owner'])for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const){
        const target=await seed(`${userId}-${cookie}-${representation}`,representation,{empty:true,profile:true});const before=await stored(target.identity);
        const actual=await request(userId,cookie);assert.equal((await auth.api.getSession({headers:actual.headers}))?.session.id,`session-${userId}`);
        const value=await capture(actual,{permission:userId==='owner'?'canWrite':'canRead',workspaceId},p=>transaction((db,client)=>readSession(db,p,input(target.identity),async(cap,access)=>{
          assert(Object.isFrozen(access));assert(Object.isFrozen(access.workspace));assert(Object.isFrozen(access.workspace.permissions));
          assert.equal(access.userId,userId);assert.equal(access.sessionId,`session-${userId}`);assert.equal(access.workspace.actor?.userId,userId);
          assert.equal(access.workspace.workspaceId,workspaceId);assert.equal(access.workspace.permissions.canRead,true);assert.equal(access.workspace.permissions.canWrite,userId==='owner');
          assert.deepEqual(Reflect.ownKeys(access),['workspace','userId','sessionId','assertCurrent']);assert(!JSON.stringify(access).includes(tokens[userId]));
          assert.equal((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,Reflect.get(client,'processID'));
          await access.assertCurrent();assert.equal(cap.snapshot.stateProof,target.proof);assert.equal(cap.snapshot.hasBom,true);
          assert.equal(inspect(db,cap,s=>s.content.kind),representation==='plain_text'?'plain_text':'rich_text');
          return userId==='owner'?'write-required-diagnostic':'read-diagnostic';
        })));
        assert.equal(value,userId==='owner'?'write-required-diagnostic':'read-diagnostic');assert.deepEqual(await stored(target.identity),before);
      }
    });
    await check('B rights follow actual SQL before phase entry instead of earlier request workspace',async()=>{
      await captured(async p=>{
        await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
        try{await transaction(db=>readSession(db,p,input(native.identity),async(_cap,access)=>{assert.equal(access.workspace.permissions.canWrite,true);await access.assertCurrent();}));}
        finally{await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");}
      });
    });
    await check('canRead is entry-rights diagnosis and cannot prove current write authorization',async()=>withWriter(async()=>{
      const before=await stored(native.identity);
      const result=await captured(p=>transaction((db,client)=>readSession(db,p,input(native.identity),async(_cap,access)=>{
        assert.equal(access.workspace.permissions.canWrite,true);
        await db.run("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        await access.assertCurrent();assert.equal(await permissionRow(client),0);
        // Frozen entry facts deliberately do not become a refreshed write grant.
        assert.equal(access.workspace.permissions.canWrite,true);return 'read-diagnostic-only';
      })));
      assert.equal(result,'read-diagnostic-only');assert.equal(await permissionRow(),1);assert.deepEqual(await stored(native.identity),before);
    }));
    await check('genuine canWrite rejects read-only actor before any consumer',async()=>{
      let visits=0;await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async()=>{visits++;})),'member','canWrite'),code('PRINCIPAL_ACCESS_DENIED'));
      assert.equal(visits,0);
    });
    await check('required write loss after binary read prevents consumer',async()=>withWriter(async()=>{
      let visits=0,changed=false;const before=await stored(native.identity);
      await assert.rejects(captured(p=>transaction(async(db,client)=>{
        const wrapped:SqlConnection={...db,get:async(sql,args)=>{const row=(await client.query(sql,args)).rows[0];
          if(!changed&&sql.includes('SELECT * FROM')&&sql.includes('collaboration_yjs_states WHERE')){changed=true;await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");}return row;}};
        await readSession(wrapped,p,input(native.identity),async()=>{visits++;});
      }),'member','canWrite'),code('PRINCIPAL_ACCESS_DENIED'));
      assert(changed);assert.equal(visits,0);assert.equal(await permissionRow(),1);assert.deepEqual(await stored(native.identity),before);
    }));
    await check('caught required-write loss remains fatal to facade and native phase',async()=>withWriter(async()=>{
      const before=await stored(native.identity);
      await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async(_cap,access)=>{
        await db.run("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        await assert.rejects(access.assertCurrent(),code('PRINCIPAL_ACCESS_DENIED'));return 'unpublishable-write-draft';
      })),'member','canWrite'),code('PRINCIPAL_ACCESS_DENIED'));
      assert.equal(await permissionRow(),1);assert.deepEqual(await stored(native.identity),before);
    }));
    await check('implicit final native check blocks write loss without consumer assertion',async()=>withWriter(async()=>{
      const before=await stored(native.identity);let returned=false;
      await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async(_cap,access)=>{
        assert.equal(access.workspace.permissions.canWrite,true);await db.run("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        returned=true;return 'unpublishable-write-draft';
      })),'member','canWrite'),code('PRINCIPAL_ACCESS_DENIED'));
      assert(returned);assert.equal(await permissionRow(),1);assert.deepEqual(await stored(native.identity),before);
    }));
    await check('write loss in reader and actual Principal final-check windows rejects returned draft',async()=>withWriter(async()=>{
      for(const finalWindow of [2,3]){
        let changed=false,reads=0,checks=0,armed=false;const before=await stored(native.identity);
        await assert.rejects(captured(p=>transaction(async(db,client)=>{
          const wrapped:SqlConnection={...db,get:async(sql,args)=>{
            // current() starts with the raw workspace row, before its permission/seat reads.
            if(armed&&reads===2&&sql.includes('SELECT id,organization_id,type,status,owner_user_id,project_id,root_relative_path')&&++checks===finalWindow){
              changed=true;await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
            }
            const row=(await client.query(sql,args)).rows[0];if(sql.includes('SELECT * FROM')&&sql.includes('collaboration_yjs_states WHERE'))reads++;return row;
          }};
          await readSession(wrapped,p,input(native.identity),async()=>{armed=true;return 'unpublishable-write-draft';});
        }),'member','canWrite'),code('PRINCIPAL_ACCESS_DENIED'));
        assert(changed);assert.equal(await permissionRow(),1);assert.deepEqual(await stored(native.identity),before);
      }
    }));
    await check('actual peer ACL/session/user updates conflict with held principal rows',async()=>{
      for(const cookie of [true,false])await captured(p=>transaction(db=>readSession(db,p,input(native.identity),async(_cap,access)=>{
        for(const sql of ["UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'",
          "UPDATE session SET expires_at=1 WHERE id='session-member'","UPDATE \"user\" SET role='admin' WHERE id='member'"]){
          const peer=await ownClient();try{await peer.query('BEGIN');await assert.rejects(peer.query(sql),code('55P03'));}
          finally{await peer.query('ROLLBACK');await endClient(peer);}
        }
        await access.assertCurrent();assert.equal(access.workspace.permissions.canWrite,false);
      })),'member','canRead',cookie);
      assert.equal(await permissionRow(),0);
    });
    await check('all facade getters and retained assertion expire with native callback',async()=>{
      let retained!:ExistingNativeSessionRequestAccess,assertion!:()=>Promise<void>;
      await captured(p=>transaction(db=>readSession(db,p,input(native.identity),async(_cap,access)=>{retained=access;assertion=access.assertCurrent;await assertion();})));
      for(const key of ['workspace','userId','sessionId','assertCurrent'] as const)assert.throws(()=>retained[key],code('NATIVE_SESSION_REQUIRED'));
      await assert.rejects(assertion(),code('NATIVE_SESSION_REQUIRED'));
    });
    await check('caught old facade getter or assertion poisons actual successor phase',async()=>{
      for(const method of ['getter','assertion'])await assert.rejects(captured(p=>transaction(async(db)=>{
        let retained!:ExistingNativeSessionRequestAccess,assertion!:()=>Promise<void>;
        await readSession(db,p,input(native.identity),async(_cap,access)=>{retained=access;assertion=access.assertCurrent;});
        await db.run('COMMIT; BEGIN');
        await readSession(db,p,input(native.identity),async()=>{
          if(method==='getter')assert.throws(()=>retained.workspace,code('NATIVE_SESSION_REQUIRED'));
          else await assert.rejects(assertion(),code('NATIVE_SESSION_REQUIRED'));
        });
      })),code('NATIVE_SESSION_REQUIRED'));
    });
    await check('facade misuse in both completion windows remains fatal after native capability closes',async()=>{
      for(const finalWindow of [2,3])for(const field of ['workspace','userId','sessionId','assertCurrent','retained-assertion']){
        let attempted=false,reads=0,checks=0,armed=false,retained!:ExistingNativeSessionRequestAccess,assertion!:()=>Promise<void>;
        await assert.rejects(captured(p=>transaction(async(db,client)=>{
          const wrapped:SqlConnection={...db,get:async(sql,args)=>{const row=(await client.query(sql,args)).rows[0];
            if(sql.includes('SELECT * FROM')&&sql.includes('collaboration_yjs_states WHERE'))reads++;
            if(armed&&reads===2&&sql.includes('SELECT expires_at FROM')&&++checks===finalWindow){
              attempted=true;if(field==='retained-assertion')await assert.rejects(assertion(),code('NATIVE_SESSION_REQUIRED'));
              else assert.throws(()=>Reflect.get(retained,field),code('NATIVE_SESSION_REQUIRED'));
            }return row;
          }};
          await readSession(wrapped,p,input(native.identity),async(_cap,access)=>{retained=access;assertion=access.assertCurrent;armed=true;});
        })),code('NATIVE_SESSION_REQUIRED'));assert(attempted);
      }
    });
    await check('detached facade assertion is drained and permanently rejects completion',async()=>{
      let completed=false;
      await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async(_cap,access)=>{
        void access.assertCurrent().then(()=>{completed=true;},()=>{completed=true;});
      }))),code('NATIVE_SESSION_DETACHED'));
      assert(completed);
    });
    await check('caught native forgery and reentrant facade use cannot complete successfully',async()=>{
      for(const kind of ['forged-native','pending-getter'])await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async(_cap,access)=>{
        if(kind==='forged-native'){await assert.rejects(current(db,{} as ExistingNativeCollaborationSession),code('NATIVE_SESSION_REQUIRED'));return;}
        const pending=access.assertCurrent();assert.throws(()=>access.workspace,code('NATIVE_SESSION_REENTRANT'));await pending.catch(()=>undefined);
      }))));
    });
    await check('same facade assertion detects actual backend XID and search-path changes',async()=>{
      for(const kind of ['backend','transaction','searchpath'])await assert.rejects(captured(p=>transaction(async(db,client)=>{
        const peer=await ownClient();await peer.query('BEGIN');let active=client;
        const wrapped:SqlConnection={get:async(sql,args)=>(await active.query(sql,args)).rows[0],all:async(sql,args)=>(await active.query(sql,args)).rows,
          run:async(sql,args)=>({changes:(await active.query(sql,args)).rowCount??0}),close:()=>assert.fail()};
        try{await readSession(wrapped,p,input(native.identity),async(_cap,access)=>{
          if(kind==='backend')active=peer;else if(kind==='transaction')await wrapped.run('COMMIT; BEGIN');else await wrapped.run('SET LOCAL search_path=pg_catalog');
          await assert.rejects(access.assertCurrent(),code('PRINCIPAL_SCOPE_CHANGED'));
        });}finally{await peer.query('ROLLBACK');await endClient(peer);}
      })),code('PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('genuine session expiry during facade callback rolls back and grants nothing',async()=>{
      const before=await stored(native.identity);
      await assert.rejects(captured(p=>transaction(db=>readSession(db,p,input(native.identity),async(_cap,access)=>{
        await db.run("UPDATE session SET expires_at=1 WHERE id='session-member'");await assert.rejects(access.assertCurrent(),code('PRINCIPAL_AUTH_REVOKED'));
      }))),code('PRINCIPAL_AUTH_REVOKED'));
      assert.deepEqual(await stored(native.identity),before);
    });
    assert.equal(fetches,0);
    console.log(`Native callback access PG18: ${cases} genuine Cookie/Bearer/ACL/lifetime families passed; no write grant/session activation.`);
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
main().catch(error=>{console.error('Owned native callback access fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  constraint:error&&typeof error==='object'?Reflect.get(error,'constraint')??null:null});process.exitCode=1;});
