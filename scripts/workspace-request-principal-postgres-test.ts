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
import type { WorkspaceRequestPrincipal, WorkspaceRequestPrincipalAccess } from '../app/lib/workspaces/request-principal';

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
  const schema = `request_principal_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^request_principal_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-request-principal-'));
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
      await own(admin);
      let scopedSql = sql;
      if (sql.trim().startsWith('DO $main_agent_id_migration$')) {
        assert(sql.trim().endsWith('$main_agent_id_migration$;'));
        assert.equal(sql.split("table_schema = 'public'").length - 1, 2);
        scopedSql = sql.replaceAll("table_schema = 'public'", `table_schema = '${schema}'`);
        assert.equal(scopedSql.replaceAll(`table_schema = '${schema}'`, "table_schema = 'public'"), sql);
      }
      const result = await admin.query(scopedSql,values); await own(admin); return result;
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
      VALUES('org-space','principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`);
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
    const { withWorkspaceRequestPrincipal: capture,withWorkspaceRequestPrincipalOnConnection: phase } = await import('../app/lib/workspaces/request-principal');
    const { LEGACY_PERSONAL_WORKSPACE_ID } = await import('../app/lib/workspaces/context');
    const request = async (userId='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':'org-space' });
      if (cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[userId],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/metadata?path=note.md',{ headers });
    };
    const transaction = async <T>(operation:(db:SqlConnection,client:Client)=>Promise<T>,begin='BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') => {
      const client = await ownClient(); await client.query(begin);
      try { return await operation(connection(client),client); }
      finally { await client.query('ROLLBACK').catch(()=>undefined); await endClient(client); }
    };
    const check = async (name:string,operation:()=>Promise<void>) => { stage=name; await operation(); cases++; console.log(`Principal fixture passed: ${name}`); };
    const expected = (code:string) => (error:unknown) => !!error && typeof error==='object' && Reflect.get(error,'code')===code;
    const captured = async <T>(operation:(principal:WorkspaceRequestPrincipal)=>Promise<T>,userId='owner') => capture(await request(userId),{ permission:'canRead' },operation);
    const observeAuthorizationDml = async (operation:()=>Promise<void>) => {
      const authorizationTables=new Set(['canvas_organization_settings','team_memberships','team_membership_sync_state','user','session',
        'organization_user_permissions','canvas_workspaces','canvas_projects','canvas_workspace_members','canvas_project_members']);
      const dml:Array<{command:string;table:string}>=[];
      const originalQuery=Client.prototype.query;
      Client.prototype.query=function(this:Client,...args:unknown[]){
        // Count every invocation, including callback overloads; forward the original arguments unchanged.
        const sql=typeof args[0]==='string'?args[0]:args[0]&&typeof args[0]==='object'?String(Reflect.get(args[0],'text')??''):'';
        const match=/^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+((?:"[^"]+"|[a-z_][a-z0-9_]*)(?:\.(?:"[^"]+"|[a-z_][a-z0-9_]*))?)/iu.exec(sql);
        const table=match?.[2].split('.').at(-1)?.replaceAll('"','');
        if(match&&table&&authorizationTables.has(table))dml.push({command:match[1].replace(/\s+/gu,' ').toUpperCase(),table});
        return Reflect.apply(originalQuery,this,args);
      } as typeof Client.prototype.query;
      try{await operation();return dml;}
      finally{Client.prototype.query=originalQuery;}
    };
    await check('actual trusted verifier and BetterAuth cookie/bearer factory',async()=>{
      for (const cookie of [true,false]) {
        const actual = await request('owner',cookie);
        assert.equal((await auth.api.getSession({ headers:actual.headers }))?.session.id,'session-owner');
        await capture(actual,{ permission:'canWrite' },p=>transaction(db=>phase(db,p,async access=>{
          assert.equal(access.userId,'owner'); assert.equal(access.sessionId,'session-owner');
          assert.equal(access.workspace.workspaceId,'org-space'); assert.equal(access.workspace.permissions.canWrite,true);
          assert(Object.isFrozen(access.workspace)); await access.assertCurrent();
        })));
      }
      assert.equal(fetches,0);
    });
    await check('fresh Cookie/Bearer principal factories and same-B phases issue no authorization bootstrap DML',async()=>{
      console.log('Owned fresh principal regression fixture:',JSON.stringify({pid:process.pid,schema,dataRoot}));
      const observations:Array<{ mode:'cookie'|'bearer'; factoryCallbacks:number; phaseCallbacks:number; dml:Array<{ command:string; table:string }> }>=[];
      for(const cookie of [true,false]){
        const observed:typeof observations[number]={mode:cookie?'cookie':'bearer',factoryCallbacks:0,phaseCallbacks:0,dml:[]};observations.push(observed);
        observed.dml=await observeAuthorizationDml(async()=>{
          await capture(await request('owner',cookie),{permission:'canWrite'},principal=>{
            observed.factoryCallbacks++;
            return transaction(db=>phase(db,principal,async access=>{
              observed.phaseCallbacks++;
              assert.equal(access.userId,'owner');assert.equal(access.sessionId,'session-owner');
              assert.equal(access.workspace.workspaceId,'org-space');assert.equal(access.workspace.permissions.canWrite,true);
              await access.assertCurrent();
            }));
          });
        });
      }
      console.log('Actual fresh principal authorization-DML witness:',JSON.stringify(observations.map(observed=>({...observed,dmlCount:observed.dml.length}))));
      assert.deepEqual(observations.map(({mode,factoryCallbacks,phaseCallbacks})=>({mode,factoryCallbacks,phaseCallbacks})),[
        {mode:'cookie',factoryCallbacks:1,phaseCallbacks:1},{mode:'bearer',factoryCallbacks:1,phaseCallbacks:1},
      ]);
      for(const observed of observations)assert.equal(observed.dml.length,0,`${observed.mode} fresh authorization must not issue bootstrap DML for an existing workspace`);
    });
    await check('a second genuine original-header factory and B2 coexist with an already open B1',async()=>{
      let factoryCallbacks=0,phaseCallbacks=0;
      const memberRequest=await request('member',true);
      // The hour-expiry seed is refresh-due under actual BetterAuth defaults.
      // Allow that genuine session update before B1, without minting its Principal early.
      const refreshedMember=await auth.api.getSession({headers:memberRequest.headers});
      assert.equal(refreshedMember?.user.id,'member');assert.equal(refreshedMember?.session.id,'session-member');
      await captured(owner=>transaction((ownerDb,ownerClient)=>phase(ownerDb,owner,async ownerAccess=>{
        const ownerPid=(await ownerClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        assert.equal(ownerAccess.userId,'owner');assert.equal(ownerAccess.sessionId,'session-owner');
        assert.equal(ownerAccess.workspace.workspaceId,'org-space');assert.equal(ownerAccess.workspace.permissions.canWrite,true);
        // Deliberately mint the second Principal only while B1 remains inside
        // its callback; this factory still runs actual getSession on the original headers.
        await capture(memberRequest,{permission:'canRead'},member=>{
          factoryCallbacks++;
          return transaction((memberDb,memberClient)=>phase(memberDb,member,async memberAccess=>{
            phaseCallbacks++;
            assert.notEqual((await memberClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,ownerPid);
            assert.equal(memberAccess.userId,'member');assert.equal(memberAccess.sessionId,'session-member');
            assert.equal(memberAccess.workspace.workspaceId,'org-space');assert.equal(memberAccess.workspace.permissions.canRead,true);
            assert.equal(memberAccess.workspace.permissions.canWrite,false);
            await ownerAccess.assertCurrent();await memberAccess.assertCurrent();
          }));
        });
        await ownerAccess.assertCurrent();
      })));
      assert.equal(factoryCallbacks,1);assert.equal(phaseCallbacks,1);
    });
    await check('initialized factories reject fallback selections and configured organization drift without repair',async()=>{
      const metadataSql=`SELECT jsonb_build_object(
        'organizations',(SELECT jsonb_agg(jsonb_build_array(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) ORDER BY organization_id) FROM canvas_organization_settings),
        'users',(SELECT jsonb_agg(jsonb_build_array(id,role,banned,updated_at) ORDER BY id) FROM "user"),
        'permissions',(SELECT jsonb_agg(jsonb_build_array(organization_id,user_id,role,status,updated_at) ORDER BY organization_id,user_id) FROM organization_user_permissions),
        'workspaces',(SELECT jsonb_agg(jsonb_build_array(id,organization_id,type,owner_user_id,root_relative_path,status,updated_at) ORDER BY id) FROM canvas_workspaces)
      ) AS snapshot`;
      const before=(await admin.query(metadataSql)).rows[0].snapshot;
      const configuredOrganization=process.env.CANVAS_ORGANIZATION_ID;
      let rejectedCallbacks=0,restoredCallbacks=0;
      try{
        for(const cookie of [true,false]){
          const actual=await request('owner',cookie);
          const dml=await observeAuthorizationDml(async()=>{
            for(const selection of [null,LEGACY_PERSONAL_WORKSPACE_ID,'missing-initialized-workspace']){
              const headers=new Headers(actual.headers);
              if(selection===null)headers.delete('x-canvas-workspace-id');
              else headers.set('x-canvas-workspace-id',selection);
              const selected=new NextRequest(actual.url,{headers});
              await assert.rejects(capture(selected,{permission:'canRead'},async()=>{
                rejectedCallbacks++;assert.fail('No factory callback for a missing, legacy or unknown selection.');
              }),expected('PRINCIPAL_ACCESS_DENIED'));
            }
            try{
              process.env.CANVAS_ORGANIZATION_ID='different-configured-organization';
              const authenticated=await auth.api.getSession({headers:actual.headers});
              assert.equal(authenticated?.user.id,'owner');assert.equal(authenticated?.session.id,'session-owner');
              await assert.rejects(capture(actual,{permission:'canRead'},async()=>{
                rejectedCallbacks++;assert.fail('No factory callback for unconfirmed organization configuration.');
              }),expected('PRINCIPAL_WORKSPACE_UNCONFIRMED'));
            }finally{
              if(configuredOrganization===undefined)delete process.env.CANVAS_ORGANIZATION_ID;
              else process.env.CANVAS_ORGANIZATION_ID=configuredOrganization;
            }
            await capture(actual,{permission:'canWrite'},principal=>{
              restoredCallbacks++;
              return transaction(db=>phase(db,principal,async access=>{
                assert.equal(access.userId,'owner');assert.equal(access.sessionId,'session-owner');
                assert.equal(access.workspace.workspaceId,'org-space');assert.equal(access.workspace.permissions.canWrite,true);
                await access.assertCurrent();
              }));
            });
          });
          assert.deepEqual(dml,[],`${cookie?'cookie':'bearer'} initialized selection failures must not repair authorization state`);
        }
      }finally{
        if(configuredOrganization===undefined)delete process.env.CANVAS_ORGANIZATION_ID;
        else process.env.CANVAS_ORGANIZATION_ID=configuredOrganization;
      }
      assert.equal(rejectedCallbacks,0);assert.equal(restoredCallbacks,2);
      assert.deepEqual((await admin.query(metadataSql)).rows[0].snapshot,before);
    });
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { getPostgresWorkspaceState } = await import('../app/lib/workspaces/postgres-runtime');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const readGenericAuthorizationMetadata = async () => {
      const snapshot=(await admin.query(`SELECT jsonb_build_object(
        'organizations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY organization_id) FROM canvas_organization_settings t),
        'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "user" t),
        'sessions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "session" t),
        'permissions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY organization_id,user_id) FROM organization_user_permissions t),
        'memberships',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM team_memberships t),
        'membershipSync',(SELECT jsonb_agg(to_jsonb(t) ORDER BY organization_id) FROM team_membership_sync_state t),
        'workspaces',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM canvas_workspaces t),
        'projects',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM canvas_projects t),
        'workspaceMembers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY workspace_id,user_id) FROM canvas_workspace_members t),
        'projectMembers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY organization_id,project_id,user_id) FROM canvas_project_members t)
      ) AS snapshot`)).rows[0].snapshot;
      // Compare every persisted field without printing session credentials on failure.
      return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    };
    const checkGenericWorkspaceReads = async (userId:'owner'|'member',cookie:boolean) => {
      const backendPids=new Set<number>();
      const originalQuery=Client.prototype.query;
      Client.prototype.query=function(this:Client,...args:unknown[]){
        const pid=Reflect.get(this,'processID');
        if(typeof pid==='number'&&Number.isSafeInteger(pid))backendPids.add(pid);
        return Reflect.apply(originalQuery,this,args);
      } as typeof Client.prototype.query;
      try{
        const selectedRequest=await request(userId,cookie);
        const selected=await requireRequestWorkspace(selectedRequest,{permissions:'canRead'});
        assert.equal(selected.response,null);assert(selected.session);assert(selected.workspace);
        assert.equal(selected.session.user.id,userId);assert.equal(selected.session.session.id,`session-${userId}`);
        assert.equal(selected.workspace.workspaceId,'org-space');assert.equal(selected.workspace.organizationId,'principal-org');
        assert.equal(selected.workspace.permissions.canRead,true);assert.equal(selected.workspace.permissions.canWrite,userId==='owner');
        const headers=new Headers(selectedRequest.headers);headers.delete('x-canvas-workspace-id');
        const defaultRequest=new NextRequest(selectedRequest.url,{headers});
        const defaultRead=await requireRequestWorkspace(defaultRequest,{permissions:'canRead'});
        assert.equal(defaultRead.response,null);assert(defaultRead.session);assert(defaultRead.workspace);
        assert.equal(defaultRead.session.user.id,userId);assert.equal(defaultRead.session.session.id,`session-${userId}`);
        assert.equal(defaultRead.workspace.workspaceId,`personal-${userId}`);assert.equal(defaultRead.workspace.workspaceType,'personal');
        assert.equal(defaultRead.workspace.ownerUserId,userId);assert.equal(defaultRead.workspace.rootRelativePath,`workspaces/personal/${userId}/files`);
        assert.equal(defaultRead.workspace.isDefault,true);assert.equal(defaultRead.workspace.permissions.canWrite,true);
        const session=await auth.api.getSession({headers:selectedRequest.headers});
        assert(session);assert.equal(session.user.id,userId);assert.equal(session.session.id,`session-${userId}`);
        const state=await getPostgresWorkspaceState(resolveWorkspaceActor({id:session.user.id,email:session.user.email,role:session.user.role}));
        assert.equal(state.status.configured,true);assert.equal(state.status.organizationId,'principal-org');assert.equal(state.status.ownerUserId,'owner');
        assert.equal(state.defaultWorkspace?.workspaceId,`personal-${userId}`);assert.equal(state.defaultWorkspace?.permissions.canWrite,true);
        const organization=state.workspaces.find(workspace=>workspace.workspaceId==='org-space');
        assert(organization);assert.equal(organization.permissions.canRead,true);assert.equal(organization.permissions.canWrite,userId==='owner');
        const personal=state.workspaces.find(workspace=>workspace.workspaceId===`personal-${userId}`);
        assert(personal);assert.equal(personal.ownerUserId,userId);assert.equal(personal.isDefault,true);
        assert.equal(state.workspaces.some(workspace=>workspace.workspaceType==='personal'&&workspace.ownerUserId!==userId),false);
        assert(backendPids.size>0,'Actual generic reads must issue SQL on a genuine backend.');
        return {userId,mode:cookie?'cookie':'bearer',selectedWorkspace:selected.workspace.workspaceId,
          defaultWorkspace:defaultRead.workspace.workspaceId,inventoryCount:state.workspaces.length,backendPids:[...backendPids]};
      }finally{Client.prototype.query=originalQuery;}
    };
    await check('canonical generic Cookie/Bearer selected default and inventory reads issue no authorization DML',async()=>{
      // Genuine generic warmup canonicalizes the seeded personal rows and allows
      // legitimate BetterAuth refresh before any observed operation or held B.
      for(const userId of ['owner','member'] as const)for(const cookie of [true,false])await checkGenericWorkspaceReads(userId,cookie);
      const before=await readGenericAuthorizationMetadata();
      const observations:Array<{userId:'owner'|'member';mode:string;dmlCount:number;commandTableCounts:Record<string,number>}>=[];
      for(const userId of ['owner','member'] as const)for(const cookie of [true,false]){
        let entered=false;
        const dml=await observeAuthorizationDml(async()=>{await checkGenericWorkspaceReads(userId,cookie);entered=true;});
        assert.equal(entered,true);
        const commandTableCounts:Record<string,number>={};
        for(const item of dml){const key=`${item.command} ${item.table}`;commandTableCounts[key]=(commandTableCounts[key]??0)+1;}
        observations.push({userId,mode:cookie?'cookie':'bearer',dmlCount:dml.length,commandTableCounts});
      }
      const after=await readGenericAuthorizationMetadata();
      console.log('Actual generic ready-read authorization-DML witness:',JSON.stringify({observations,metadataUnchanged:before===after}));
      assert.equal(observations.length,4);
      for(const observed of observations)assert.equal(observed.dmlCount,0,`${observed.userId}/${observed.mode} canonical generic reads must not bootstrap`);
      assert.equal(after,before,'Canonical generic reads must leave every authorization metadata field unchanged.');
    });
    await check('held B1 permits genuine generic selected default inventory reads and a newly minted B2',async()=>{
      for(const userId of ['owner','member'] as const)for(const cookie of [true,false])await checkGenericWorkspaceReads(userId,cookie);
      let factoryCallbacks=0,phaseCallbacks=0;const observedBackends:Array<Awaited<ReturnType<typeof checkGenericWorkspaceReads>>>=[];
      await captured(owner=>transaction((ownerDb,ownerClient)=>phase(ownerDb,owner,async ownerAccess=>{
        const ownerPid=(await ownerClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        assert.equal(ownerAccess.userId,'owner');assert.equal(ownerAccess.workspace.permissions.canWrite,true);
        for(const userId of ['owner','member'] as const)for(const cookie of [true,false]){
          const observed=await checkGenericWorkspaceReads(userId,cookie);
          assert(observed.backendPids.every(pid=>pid!==ownerPid),'Generic reads must coexist on actual separate backends while B1 stays open.');
          observedBackends.push(observed);
          await ownerAccess.assertCurrent();
        }
        // This is an actual original-header factory inside B1, never a preminted Principal.
        await capture(await request('member',true),{permission:'canRead'},member=>{
          factoryCallbacks++;
          return transaction((memberDb,memberClient)=>phase(memberDb,member,async memberAccess=>{
            phaseCallbacks++;
            assert.notEqual((await memberClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,ownerPid);
            assert.equal(memberAccess.userId,'member');assert.equal(memberAccess.sessionId,'session-member');
            assert.equal(memberAccess.workspace.workspaceId,'org-space');assert.equal(memberAccess.workspace.permissions.canRead,true);
            assert.equal(memberAccess.workspace.permissions.canWrite,false);
            await ownerAccess.assertCurrent();await memberAccess.assertCurrent();
          }));
        });
        await ownerAccess.assertCurrent();
      })));
      assert.equal(factoryCallbacks,1);assert.equal(phaseCallbacks,1);assert.equal(observedBackends.length,4);
      console.log('Actual generic reads under held B1 witness:',JSON.stringify({factoryCallbacks,phaseCallbacks,observedBackends}));
    });
    await check('generic reads retain genuine personal default repair and return to zero-DML ready reads',async()=>{
      const original=(await admin.query("SELECT root_relative_path,is_default,display_name,updated_at FROM canvas_workspaces WHERE id='personal-member'")).rows[0];
      assert.equal(original.root_relative_path,'workspaces/personal/member/files');assert.equal(original.is_default,1);
      try{
        await admin.query("UPDATE canvas_workspaces SET root_relative_path='users/member/fixture-needs-repair',is_default=0 WHERE id='personal-member'");
        const repairDml=await observeAuthorizationDml(async()=>{await checkGenericWorkspaceReads('member',true);});
        const repaired=(await admin.query("SELECT root_relative_path,is_default FROM canvas_workspaces WHERE id='personal-member'")).rows[0];
        assert.deepEqual(repaired,{root_relative_path:'workspaces/personal/member/files',is_default:1});
        assert(repairDml.some(item=>item.command==='UPDATE'&&item.table==='canvas_workspaces'),'A genuine noncanonical personal row still requires the original write repair.');
        const before=await readGenericAuthorizationMetadata();
        const readyDml=await observeAuthorizationDml(async()=>{await checkGenericWorkspaceReads('member',false);});
        const after=await readGenericAuthorizationMetadata();
        console.log('Actual generic personal repair witness:',JSON.stringify({repairDmlCount:repairDml.length,readyDmlCount:readyDml.length,metadataUnchanged:before===after}));
        assert.deepEqual(readyDml,[]);assert.equal(after,before);
      }finally{
        await admin.query("UPDATE canvas_workspaces SET root_relative_path=$1,is_default=$2,display_name=$3,updated_at=$4 WHERE id='personal-member'",
          [original.root_relative_path,original.is_default,original.display_name,original.updated_at]);
      }
    });
    const principalRegressionSignal=()=>{
      let release!:()=>void;
      const promise=new Promise<void>(resolve=>{release=resolve;});
      return {promise,release};
    };
    const waitForPrincipalRegression=async(condition:()=>boolean|Promise<boolean>,label:string)=>{
      const deadline=Date.now()+5000;
      while(!await condition()){
        assert(Date.now()<deadline,label);
        await new Promise<void>(resolve=>setTimeout(resolve,5));
      }
    };
    const observePrincipalRegression=<T,>(pending:Promise<T>)=>{
      let settled=false;
      const done=pending.then(value=>{settled=true;return {ok:true as const,value};},
        error=>{settled=true;return {ok:false as const,error};});
      return {done,isSettled:()=>settled};
    };
    await check('both generic read bindings never combine revoked sharing with a newly granted team membership',async()=>{
      const {createPostgresWorkspaceForActor,upsertPostgresWorkspaceMemberForActor}=await import('../app/lib/workspaces/postgres-runtime');
      const {updateOrganizationPermissions}=await import('../app/lib/organization/permissions');
      const ownerSession=await auth.api.getSession({headers:(await request('owner',true)).headers});assert(ownerSession);
      const memberSession=await auth.api.getSession({headers:(await request('member',true)).headers});assert(memberSession);
      assert.equal(ownerSession.user.id,'owner');assert.equal(memberSession.user.id,'member');
      const ownerActor=resolveWorkspaceActor(ownerSession.user),memberActor=resolveWorkspaceActor(memberSession.user);
      const originalPermission=(await admin.query("SELECT can_create_public_links FROM organization_user_permissions WHERE organization_id='principal-org' AND user_id='member'")).rows[0];
      const team=await createPostgresWorkspaceForActor(ownerActor,{type:'team',name:'Principal mixed-permission witness'});
      assert.equal(team.permissions.canManageWorkspace,true);
      const observations:Array<{mode:'selected'|'inventory';share:boolean;status:number}>=[];
      try{
        for(const mode of ['selected','inventory'] as const){
          await admin.query("DELETE FROM canvas_workspace_members WHERE workspace_id=$1 AND user_id='member'",[team.workspaceId]);
          await updateOrganizationPermissions({actorUserId:'owner',targetUserId:'member',permissions:{canCreatePublicLinks:true}});
          const memberRequest=await request('member',true),headers=new Headers(memberRequest.headers);headers.set('x-canvas-workspace-id',team.workspaceId);
          const selected=new NextRequest('http://localhost/api/security/public-shares',{method:'POST',headers});
          const baseline=await requireRequestWorkspace(selected,{permissions:'canCreatePublicLinks'});
          assert.equal(baseline.response?.status,404);assert.equal(baseline.workspace,null);
          const releaseRead=principalRegressionSignal();let readerPid:number|undefined,writerPid:number|undefined,permissionReads=0;
          const originalQuery=Client.prototype.query;
          Client.prototype.query=function(this:Client,...args:unknown[]){
            const sql=(typeof args[0]==='string'?args[0]:'').trim().replace(/\s+/gu,' ');
            const values=Array.isArray(args[1])?args[1]:[];
            if(readerPid&&/^UPDATE canvas_organization_settings SET deployment_mode =/u.test(sql))writerPid=Number(Reflect.get(this,'processID'));
            const original=Reflect.apply(originalQuery,this,args);
            if(!sql.startsWith('SELECT role, status, can_write_team_workspace, can_create_public_links,')
              || values[0]!=='principal-org'||values[1]!=='member'||++permissionReads!==(mode==='selected'?1:2))return original;
            return Promise.resolve(original).then(async result=>{
              assert.equal(result.rows[0]?.can_create_public_links,1);
              readerPid=Number(Reflect.get(this,'processID'));assert(Number.isSafeInteger(readerPid));
              await releaseRead.promise;return result;
            });
          } as typeof Client.prototype.query;
          const reader=observePrincipalRegression(mode==='selected'
            ?requireRequestWorkspace(selected,{permissions:'canCreatePublicLinks'}).then(result=>({share:result.workspace?.permissions.canCreatePublicLinks??false,status:result.response?.status??200}))
            :getPostgresWorkspaceState(memberActor).then(result=>({share:result.workspaces.find(item=>item.workspaceId===team.workspaceId)?.permissions.canCreatePublicLinks??false,status:200})));
          let writer:ReturnType<typeof observePrincipalRegression<Awaited<ReturnType<typeof upsertPostgresWorkspaceMemberForActor>>>>|undefined;
          let writerBlocked=false;
          try{
            await waitForPrincipalRegression(()=>readerPid!==undefined||reader.isSettled(),'The actual permission SELECT did not reach its barrier.');
            assert(readerPid);assert.equal(reader.isSettled(),false);
            await updateOrganizationPermissions({actorUserId:'owner',targetUserId:'member',permissions:{canCreatePublicLinks:false}});
            assert.equal((await admin.query("SELECT can_create_public_links FROM organization_user_permissions WHERE organization_id='principal-org' AND user_id='member'")).rows[0].can_create_public_links,0);
            writer=observePrincipalRegression(upsertPostgresWorkspaceMemberForActor(ownerActor,team.workspaceId,{userId:'member',canRead:true,canWrite:false,canManage:false}));
            await waitForPrincipalRegression(async()=>{
              if(writer!.isSettled())return true;
              if(!writerPid)return false;
              writerBlocked=(await admin.query('SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',[readerPid,writerPid])).rows[0].blocked===true;
              return writerBlocked;
            },'The actual member writer neither committed nor blocked on the actual reader.');
            assert(writerPid);assert.notEqual(writerPid,readerPid);
            if(writer.isSettled()){
              const completed=await writer.done;if(!completed.ok)throw completed.error;
              assert.equal((await admin.query("SELECT can_read FROM canvas_workspace_members WHERE workspace_id=$1 AND user_id='member'",[team.workspaceId])).rows[0]?.can_read,1);
            }
            releaseRead.release();
            await waitForPrincipalRegression(()=>reader.isSettled(),'The genuine generic reader did not settle.');
            const observed=await reader.done;if(!observed.ok)throw observed.error;
            await waitForPrincipalRegression(()=>writer!.isSettled(),'The genuine member writer did not settle after reader release.');
            const completed=await writer.done;if(!completed.ok)throw completed.error;
            const fresh=await requireRequestWorkspace(selected,{permissions:'canRead'});assert.equal(fresh.response,null);assert(fresh.workspace);
            assert.equal(fresh.workspace.permissions.canRead,true);assert.equal(fresh.workspace.permissions.canCreatePublicLinks,false);
            console.log('Actual generic mixed-permission witness:',JSON.stringify({mode,readerPid,writerPid,writerBlocked,observed:observed.value,freshRead:true,freshShare:false}));
            observations.push({mode,...observed.value});
          }finally{
            releaseRead.release();await Promise.all([reader.done,writer?.done]);Client.prototype.query=originalQuery;
          }
        }
        assert.deepEqual(observations,[{mode:'selected',share:false,status:404},{mode:'inventory',share:false,status:200}],
          'Neither generic read may authorize old sharing plus a newly granted membership.');
      }finally{
        await updateOrganizationPermissions({actorUserId:'owner',targetUserId:'member',permissions:{canCreatePublicLinks:originalPermission.can_create_public_links===1}});
        await admin.query('DELETE FROM canvas_workspace_members WHERE workspace_id=$1',[team.workspaceId]);
        await admin.query('DELETE FROM canvas_workspaces WHERE id=$1',[team.workspaceId]);
        assert(team.rootPath.startsWith(`${dataRoot}${path.sep}`));await rm(team.rootPath,{recursive:true,force:true});
      }
    });
    await check('two concurrent generic repair fallbacks complete without retaining incompatible read locks',async()=>{
      const {resolvePostgresWorkspaceForActor}=await import('../app/lib/workspaces/postgres-runtime');
      const memberSession=await auth.api.getSession({headers:(await request('member',true)).headers});assert(memberSession);
      const memberActor=resolveWorkspaceActor(memberSession.user);
      const originalRow=(await admin.query("SELECT root_relative_path,is_default,display_name,updated_at FROM canvas_workspaces WHERE id='personal-member'")).rows[0];
      const brokenRoot='users/member/concurrent-repair-witness';
      const releaseReads=principalRegressionSignal(),readerPids=new Set<number>(),originalQuery=Client.prototype.query;
      await admin.query("UPDATE canvas_workspaces SET root_relative_path=$1,is_default=0 WHERE id='personal-member'",[brokenRoot]);
      Client.prototype.query=function(this:Client,...args:unknown[]){
        const sql=(typeof args[0]==='string'?args[0]:'').trim().replace(/\s+/gu,' '),values=Array.isArray(args[1])?args[1]:[];
        const original=Reflect.apply(originalQuery,this,args),pid=Number(Reflect.get(this,'processID'));
        if(!sql.includes("WHERE type = 'personal' AND owner_user_id = $1")||values[0]!=='member'||readerPids.has(pid))return original;
        return Promise.resolve(original).then(async result=>{
          assert.equal(result.rows[0]?.root_relative_path,brokenRoot);assert(Number.isSafeInteger(pid));readerPids.add(pid);
          await releaseReads.promise;return result;
        });
      } as typeof Client.prototype.query;
      const inventory=observePrincipalRegression(getPostgresWorkspaceState(memberActor));
      const selected=observePrincipalRegression(resolvePostgresWorkspaceForActor(memberActor,'org-space'));
      try{
        await waitForPrincipalRegression(()=>readerPids.size===2||inventory.isSettled()||selected.isSettled(),'Both actual repair reads did not reach the common barrier.');
        assert.equal(readerPids.size,2);assert.equal(inventory.isSettled(),false);assert.equal(selected.isSettled(),false);
        releaseReads.release();
        await waitForPrincipalRegression(()=>inventory.isSettled()&&selected.isSettled(),'Both genuine repair fallbacks must complete without a deadlock or timeout.');
        const inventoryResult=await inventory.done,selectedResult=await selected.done;
        if(!inventoryResult.ok)throw inventoryResult.error;if(!selectedResult.ok)throw selectedResult.error;
        assert.equal(inventoryResult.value.defaultWorkspace?.rootRelativePath,'workspaces/personal/member/files');
        assert.equal(inventoryResult.value.defaultWorkspace?.isDefault,true);
        assert.equal(selectedResult.value?.workspaceId,'org-space');assert.equal(selectedResult.value?.permissions.canRead,true);
        assert.deepEqual((await admin.query("SELECT root_relative_path,is_default FROM canvas_workspaces WHERE id='personal-member'")).rows[0],{root_relative_path:'workspaces/personal/member/files',is_default:1});
        Client.prototype.query=originalQuery;
        const before=await readGenericAuthorizationMetadata();
        const readyDml=await observeAuthorizationDml(async()=>{await checkGenericWorkspaceReads('member',true);});
        assert.deepEqual(readyDml,[]);assert.equal(await readGenericAuthorizationMetadata(),before);
        console.log('Actual concurrent generic repair witness:',JSON.stringify({readerPids:[...readerPids],successfulRepairs:2,readyDmlCount:readyDml.length,metadataUnchanged:true}));
      }finally{
        releaseReads.release();await Promise.all([inventory.done,selected.done]);Client.prototype.query=originalQuery;
        await admin.query("UPDATE canvas_workspaces SET root_relative_path=$1,is_default=$2,display_name=$3,updated_at=$4 WHERE id='personal-member'",[originalRow.root_relative_path,originalRow.is_default,originalRow.display_name,originalRow.updated_at]);
      }
    });
    await check('read-only member and genuine forbidden write',async()=>{
      await captured(p=>transaction(db=>phase(db,p,async access=>assert.equal(access.workspace.permissions.canWrite,false))),'member');
      await assert.rejects(capture(await request('member'),{ permission:'canWrite' },async()=>assert.fail()),expected('PRINCIPAL_ACCESS_DENIED'));
    });
    await check('two genuine principal read phases coexist through fresh checks',async()=>{
      // Mint both actual requests before B1 takes any authorization locks.
      // B2 must enter while B1 is still in its callback: no retry or release
      // can hide mutually incompatible principal locks in this witness.
      await captured(owner=>captured(member=>transaction((ownerDb,ownerClient)=>phase(ownerDb,owner,async ownerAccess=>{
        const ownerPid=(await ownerClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        assert.equal(ownerAccess.userId,'owner');
        assert.equal(ownerAccess.workspace.permissions.canWrite,true);
        await transaction((memberDb,memberClient)=>phase(memberDb,member,async memberAccess=>{
          assert.notEqual((await memberClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,ownerPid);
          assert.equal(memberAccess.userId,'member');
          assert.equal(memberAccess.sessionId,'session-member');
          assert.equal(memberAccess.workspace.permissions.canRead,true);
          assert.equal(memberAccess.workspace.permissions.canWrite,false);
          await ownerAccess.assertCurrent();
          await memberAccess.assertCurrent();
        }));
        await ownerAccess.assertCurrent();
      })),'member'));
    });
    await check('unauthenticated/API-key/guest strings cannot mint principal',async()=>{
      const variants:Record<string,string>[]=[{},{ authorization:'Bearer guest:invitation' },{ authorization:'Bearer arbitrary-api-key' }];
      for(const headers of variants)
        await assert.rejects(capture(new NextRequest('http://localhost/api/files/metadata',{ headers }),{ permission:'canRead' },async()=>assert.fail()),expected('PRINCIPAL_AUTH_REVOKED'));
    });
    await check('request headers and selectors snapshot before await',async()=>{
      const actual=await request(); const options:{ permission:'canRead'|'canWrite';workspaceId?:string }={permission:'canRead',workspaceId:'org-space'};
      const pending=capture(actual,options,p=>transaction(db=>phase(db,p,async access=>assert.equal(access.userId,'owner'))));
      actual.headers.set('authorization','Bearer forged');actual.headers.set('x-canvas-workspace-id','foreign');options.permission='canWrite';options.workspaceId='foreign';
      await pending;
    });
    await check('forged and retained principal/access',async()=>{
      await transaction(db=>assert.rejects(phase(db,{} as WorkspaceRequestPrincipal,async()=>assert.fail()),expected('PRINCIPAL_REQUIRED')));
      let retained!:WorkspaceRequestPrincipal; let access!:WorkspaceRequestPrincipalAccess;
      await captured(async p=>{ retained=p; await transaction(db=>phase(db,p,async current=>{access=current;})); });
      await transaction(db=>assert.rejects(phase(db,retained,async()=>assert.fail()),expected('PRINCIPAL_REQUIRED')));
      await assert.rejects(access.assertCurrent(),expected('PRINCIPAL_REQUIRED'));
    });
    await check('caught invalid DB/operation inputs poison genuine principal',async()=>{
      for(const invalid of [null,{},'not-a-connection']) await assert.rejects(captured(async p=>{
        await assert.rejects(phase(invalid as unknown as SqlConnection,p,async()=>assert.fail()),expected('PRINCIPAL_INVALID'));
      }),expected('PRINCIPAL_INVALID'));
      await assert.rejects(captured(p=>transaction(async db=>{
        await assert.rejects(phase(db,p,null as unknown as ()=>Promise<void>),expected('PRINCIPAL_INVALID'));
      })),expected('PRINCIPAL_INVALID'));
    });
    for (const [name,sql,restore,code] of [
      ['session token CAS',"UPDATE session SET token='replaced' WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED'],
      ['expired session',"UPDATE session SET expires_at=1 WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED'],
      ['revoked session',"DELETE FROM session WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED'],
      ['banned remains banned despite past ban expiry',"UPDATE \"user\" SET banned=1,ban_expires=1 WHERE id='owner'","UPDATE \"user\" SET banned=0,ban_expires=NULL WHERE id='owner'",'SEAT_ACCESS_INACTIVE'],
      ['disabled permission',"UPDATE organization_user_permissions SET status='disabled' WHERE user_id='owner'","UPDATE organization_user_permissions SET status='active' WHERE user_id='owner'",'SEAT_MEMBERSHIP_REQUIRED'],
      ['seat rank/activation changed',"UPDATE team_memberships SET status='active' WHERE id='inactive-seat'; UPDATE organization_user_permissions SET status='active' WHERE user_id='inactive'","UPDATE team_memberships SET status='suspended' WHERE id='inactive-seat'; UPDATE organization_user_permissions SET status='disabled' WHERE user_id='inactive'",'SEAT_LIMIT_EXCEEDED'],
    ] as const) {
      await check(name,async()=>{
        const actor=name==='seat rank/activation changed'?'member':'owner';
        try { await assert.rejects(captured(async p=>{await admin.query(sql); await transaction(db=>phase(db,p,async()=>assert.fail('No callback after revocation.')));},actor),expected(code)); }
        finally { if(restore) await admin.query(restore); await seedSession(actor); }
      });
    }
    await check('changed workspace after request capture',async()=>{
      try { await assert.rejects(captured(async p=>{await admin.query("UPDATE canvas_workspaces SET root_relative_path='changed' WHERE id='org-space'"); await transaction(db=>phase(db,p,async()=>assert.fail()));}),expected('PRINCIPAL_SCOPE_CHANGED')); }
      finally { await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared' WHERE id='org-space'"); }
    });
    await check('raw unknown type/status and owner drift cannot normalize into grant',async()=>{
      for(const [field,value,original] of [['type','unknown','organization'],['status','unknown','active'],['owner_user_id','member',null]] as const){
        try{await assert.rejects(captured(async p=>{await admin.query(`UPDATE canvas_workspaces SET ${field}=$1 WHERE id='org-space'`,[value]);
          await transaction(db=>phase(db,p,async()=>assert.fail()));}),expected('PRINCIPAL_SCOPE_CHANGED'));}
        finally{await admin.query(`UPDATE canvas_workspaces SET ${field}=$1 WHERE id='org-space'`,[original]);}
      }
    });
    await check('same caller TX raw status drift rejects final revalidation',async()=>{
      await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>{await db.run("UPDATE canvas_workspaces SET status='unknown' WHERE id='org-space'");}))),expected('PRINCIPAL_SCOPE_CHANGED'));
      assert.equal((await admin.query("SELECT status FROM canvas_workspaces WHERE id='org-space'")).rows[0].status,'active');
    });
    await check('RC/RW requirement and autocommit XID rejection',async()=>{
      for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'])
        await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>assert.fail()),begin)),expected('PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(captured(async p=>{const c=await ownClient(); try{await phase(connection(c),p,async()=>assert.fail());}finally{await endClient(c);}}),expected('PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('current XID/searchpath and shadow relation changes reject',async()=>{
      for (const sql of ['COMMIT; BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',`SET LOCAL search_path=${schema}`, 'CREATE TEMP TABLE "session"(id text)'])
        await assert.rejects(captured(p=>transaction(db=>phase(db,p,async access=>{await db.run(sql); await access.assertCurrent();}))),
          expected(sql.startsWith('CREATE')?'PRINCIPAL_SCHEMA_INVALID':'PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('same wrapper cannot change backend or captured schema',async()=>{
      await assert.rejects(captured(p=>transaction(async(db,client)=>{
        const peer=await ownClient();await peer.query('BEGIN'); let active=client;
        const wrapper:SqlConnection={get:async(sql,args)=>(await active.query(sql,args)).rows[0],all:async(sql,args)=>(await active.query(sql,args)).rows,
          run:async(sql,args)=>({changes:(await active.query(sql,args)).rowCount??0}),close:()=>assert.fail()};
        try{await phase(wrapper,p,async access=>{active=peer;await access.assertCurrent();});}
        finally{await peer.query('ROLLBACK');await endClient(peer);}
      })),expected('PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(captured(p=>transaction(async(db)=>{await db.run('SET LOCAL search_path=pg_catalog');await phase(db,p,async()=>assert.fail());})),expected('PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('final expiry response cannot hide changed backend',async()=>{
      await assert.rejects(captured(p=>transaction(async(_db,client)=>{
        const peer=await ownClient();await peer.query('BEGIN');let active=client,armed=false;
        const wrapper:SqlConnection={get:async(sql,args)=>{const row=(await active.query(sql,args)).rows[0];
          if(armed && sql.startsWith('SELECT expires_at')) active=peer;return row;},
        all:async(sql,args)=>(await active.query(sql,args)).rows,run:async(sql,args)=>({changes:(await active.query(sql,args)).rowCount??0}),close:()=>assert.fail()};
        try{await phase(wrapper,p,async()=>{armed=true;});}finally{await peer.query('ROLLBACK');await endClient(peer);}
      })),expected('PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('fresh locked role follows DB, not the captured session user',async()=>{
      try{await captured(async p=>{await admin.query("UPDATE \"user\" SET role='admin' WHERE id='member'");
        await transaction(db=>phase(db,p,async access=>assert.equal(access.workspace.permissions.canWrite,true)));},'member');}
      finally{await admin.query("UPDATE \"user\" SET role='user' WHERE id='member'");}
    });
    await check('simultaneous and detached phase poison actual callback',async()=>{
      await assert.rejects(captured(p=>transaction(async db=>{
        const first=phase(db,p,async()=>undefined); const second=phase(db,p,async()=>assert.fail());
        await Promise.allSettled([first,second]);
      })),expected('PRINCIPAL_REENTRANT'));
      await assert.rejects(captured(async p=>{const c=await ownClient(); await c.query('BEGIN');
        void phase(connection(c),p,async()=>undefined).catch(()=>undefined);}),expected('PRINCIPAL_DETACHED'));
      // Only the fixture owns and releases the detached caller transaction.
      for(const c of [...clients]) if(c!==admin){await c.query('ROLLBACK');await endClient(c);}
    });
    await check('caught forged principal and retained assertion poison real current DB phase',async()=>{
      await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>{
        await assert.rejects(phase(db,{} as WorkspaceRequestPrincipal,async()=>assert.fail()),expected('PRINCIPAL_REQUIRED'));
      }))),expected('PRINCIPAL_REQUIRED'));
      await assert.rejects(captured(p=>transaction(async db=>{
        let retained!:WorkspaceRequestPrincipalAccess;
        await phase(db,p,async access=>{retained=access;});
        await phase(db,p,async()=>{await assert.rejects(retained.assertCurrent(),expected('PRINCIPAL_REQUIRED'));});
      })),expected('PRINCIPAL_REQUIRED'));
    });
    await check('FK parent NO KEY UPDATE is insufficient, FOR UPDATE blocks insert',async()=>{
      for (const mode of ['NO KEY UPDATE','UPDATE']) await transaction(async(_db,held)=>{
        await held.query(`SELECT organization_id FROM canvas_organization_settings WHERE organization_id='principal-org' FOR ${mode}`);
        const peer=await ownClient(); try{
          await peer.query('BEGIN'); const insert=peer.query("INSERT INTO team_memberships(id,organization_id,candidate_email,status,created_at,updated_at) VALUES('phantom','principal-org','phantom@principal.test','invited',100,100)");
          if(mode==='UPDATE') await assert.rejects(insert,expected('55P03')); else await insert;
        } finally { await peer.query('ROLLBACK'); await endClient(peer); }
      });
    });
    await check('parent-only fence permits existing child activation',async()=>transaction(async(_db,held)=>{
      await held.query("SELECT organization_id FROM canvas_organization_settings WHERE organization_id='principal-org' FOR UPDATE");
      const peer=await ownClient(); try{await peer.query('BEGIN');await peer.query("UPDATE team_memberships SET status='active' WHERE id='inactive-seat'");}
      finally{await peer.query('ROLLBACK');await endClient(peer);}
    }));
    await check('ROW SHARE permits trigger DDL, ROW EXCLUSIVE prevents it',async()=>{
      for(const mode of ['ROW SHARE','ROW EXCLUSIVE']) await transaction(async(_db,held)=>{
        await held.query(`LOCK TABLE organization_user_permissions IN ${mode} MODE`);
        const peer=await ownClient();try{await peer.query('BEGIN');const altered=peer.query('ALTER TABLE organization_user_permissions DISABLE TRIGGER ALL');
          if(mode==='ROW SHARE') await altered; else await assert.rejects(altered,expected('55P03'));}
        finally{await peer.query('ROLLBACK');await endClient(peer);}
      });
    });
    await check('full foundation blocks new and existing predicate/ACL/session writes',async()=>{
      const writes=[
        "INSERT INTO team_memberships(id,organization_id,candidate_email,status,created_at,updated_at) VALUES('phantom','principal-org','phantom@principal.test','invited',100,100)",
        "UPDATE team_memberships SET status='active' WHERE id='inactive-seat'",
        "UPDATE team_memberships SET activated_at=1 WHERE id='member-seat'",
        "UPDATE organization_user_permissions SET status='active' WHERE user_id='inactive'",
        "UPDATE \"user\" SET banned=1 WHERE id='inactive'",
        "UPDATE session SET token='new-token' WHERE id='session-owner'",
        "UPDATE team_membership_sync_state SET reconciliation_seat_limit=1 WHERE organization_id='principal-org'",
        "INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('new-first','owner','team',1,1,1)",
        "UPDATE canvas_workspaces SET status='archived' WHERE id='org-space'",
        'ALTER TABLE organization_user_permissions DISABLE TRIGGER ALL',
      ];
      await captured(p=>transaction(db=>phase(db,p,async access=>{
        for(const sql of writes){const peer=await ownClient();try{await peer.query('BEGIN');await assert.rejects(peer.query(sql),expected('55P03'));}
          finally{await peer.query('ROLLBACK');await endClient(peer);}}
        await access.assertCurrent();
      })));
      // The full caller ROLLBACK releases every lock.
      await admin.query("UPDATE team_memberships SET activated_at=200 WHERE id='member-seat'");
    });
    await check('absent permission FK and all organization/sync predicate',async()=>{
      await admin.query("INSERT INTO \"user\"(id,name,email,email_verified,role,banned,created_at,updated_at) VALUES('absent','Absent','absent@principal.test',1,'user',0,100,100)");
      await admin.query("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('second','owner','team',1,200,200)");
      await captured(p=>transaction(db=>phase(db,p,async()=>{
        for(const sql of ["INSERT INTO organization_user_permissions(organization_id,user_id,created_at,updated_at) VALUES('principal-org','absent',100,100)",
          "INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('second',100,100)"]){
          const peer=await ownClient();try{await peer.query('BEGIN');await assert.rejects(peer.query(sql),expected('55P03'));}
          finally{await peer.query('ROLLBACK');await endClient(peer);}
        }
      })));
      await admin.query("DELETE FROM canvas_organization_settings WHERE organization_id='second'");
    });
    await check('unsafe/deferred/unenforced FK fails closed',async()=>{
      const fk=(await admin.query(`SELECT conname FROM pg_constraint WHERE conrelid='organization_user_permissions'::regclass
        AND confrelid='canvas_organization_settings'::regclass AND contype='f'`)).rows[0].conname;
      assert.match(fk,/^[a-z_]+$/u);
      for(const mode of ['DEFERRABLE','NOT VALID','TRIGGER']) {
        try {
          if(mode==='DEFERRABLE') await admin.query(`ALTER TABLE organization_user_permissions ALTER CONSTRAINT "${fk}" DEFERRABLE INITIALLY IMMEDIATE`);
          if(mode==='NOT VALID') {await admin.query(`ALTER TABLE organization_user_permissions DROP CONSTRAINT "${fk}"`);
            await admin.query(`ALTER TABLE organization_user_permissions ADD CONSTRAINT "${fk}" FOREIGN KEY(organization_id) REFERENCES canvas_organization_settings(organization_id) NOT VALID`);}
          if(mode==='TRIGGER') await admin.query('ALTER TABLE organization_user_permissions DISABLE TRIGGER ALL');
          await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>assert.fail()))),expected('PRINCIPAL_SCHEMA_INVALID'));
        } finally {
          await admin.query(`ALTER TABLE organization_user_permissions ALTER CONSTRAINT "${fk}" NOT DEFERRABLE`);
          await admin.query(`ALTER TABLE organization_user_permissions VALIDATE CONSTRAINT "${fk}"`);
          await admin.query('ALTER TABLE organization_user_permissions ENABLE TRIGGER ALL');
        }
      }
    });
    await check('ambiguous earliest organization and 16 organization bound',async()=>{
      try {
        await admin.query("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('tie','owner','team',1,100,100)");
        await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>assert.fail()))),expected('PRINCIPAL_SCOPE_CHANGED'));
        await admin.query("DELETE FROM canvas_organization_settings WHERE organization_id='tie'");
        await admin.query("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) SELECT 'bounded-'||i,'owner','team',1,100+i,100 FROM generate_series(1,16) i");
        await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>assert.fail()))),expected('PRINCIPAL_TOO_LARGE'));
      } finally {await admin.query("DELETE FROM canvas_organization_settings WHERE organization_id='tie' OR organization_id LIKE 'bounded-%'");}
    });
    await check('earliest synchronized organization ties independently fail',async()=>{
      try{
        await admin.query("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('sync-a','owner','team',1,200,100),('sync-b','owner','team',1,200,100)");
        await admin.query("DELETE FROM team_membership_sync_state WHERE organization_id='principal-org'; INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('sync-a',100,100),('sync-b',100,100)");
        await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>assert.fail()))),expected('PRINCIPAL_SCOPE_CHANGED'));
      }finally{await admin.query("DELETE FROM canvas_organization_settings WHERE organization_id IN('sync-a','sync-b'); INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('principal-org',100,100)");}
    });
    await check('all pending rows count toward 1024 member bound',async()=>{
      try{
        await admin.query("INSERT INTO team_memberships(id,organization_id,candidate_email,status,created_at,updated_at) SELECT 'bounded-'||i,'principal-org','bounded-'||i||'@principal.test','invited',100,100 FROM generate_series(1,1022) i");
        await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>assert.fail()))),expected('PRINCIPAL_TOO_LARGE'));
      } finally {await admin.query("DELETE FROM team_memberships WHERE id LIKE 'bounded-%'");}
    });
    await check('permission/reference budget counts inactive nonmembers',async()=>{
      try{
        await admin.query("INSERT INTO \"user\"(id,name,email,email_verified,role,banned,created_at,updated_at) SELECT 'bounded-'||i,'Bounded','bounded-'||i||'@principal.test',1,'user',0,100,100 FROM generate_series(1,1022) i");
        await admin.query("INSERT INTO organization_user_permissions(organization_id,user_id,status,created_at,updated_at) SELECT 'principal-org','bounded-'||i,'disabled',100,100 FROM generate_series(1,1022) i");
        await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>assert.fail()))),expected('PRINCIPAL_TOO_LARGE'));
      }finally{await admin.query("DELETE FROM organization_user_permissions WHERE user_id LIKE 'bounded-%'; DELETE FROM \"user\" WHERE id LIKE 'bounded-%'");}
    });
    await check('concurrent and unawaited assert poison phase',async()=>{
      await assert.rejects(captured(p=>transaction(db=>phase(db,p,async access=>{await Promise.allSettled([access.assertCurrent(),access.assertCurrent()]);}))),expected('PRINCIPAL_REENTRANT'));
      await assert.rejects(captured(p=>transaction(db=>phase(db,p,async access=>{void access.assertCurrent().catch(()=>undefined);}))),expected('PRINCIPAL_DETACHED'));
    });
    await check('phase entry freshness and running SQL lifetime bounded',async()=>{
      await assert.rejects(captured(async p=>{await new Promise(resolve=>setTimeout(resolve,5050));await transaction(db=>phase(db,p,async()=>assert.fail()));}),expected('PRINCIPAL_EXPIRED'));
      await assert.rejects(captured(p=>transaction(db=>phase(db,p,async()=>{await new Promise(resolve=>setTimeout(resolve,5050));}))),expected('PRINCIPAL_EXPIRED'));
      await admin.query("UPDATE session SET updated_at=updated_at WHERE id='session-owner'");
    });
    await check('sequential fresh RC/RW phases and callback throw revocation',async()=>{
      await captured(async p=>{for(let i=0;i<2;i++) await transaction(db=>phase(db,p,async access=>{await access.assertCurrent();}));});
      let old!:WorkspaceRequestPrincipal;
      await assert.rejects(captured(async p=>{old=p;throw new Error('Deliberate callback failure.');}),/Deliberate callback/u);
      await transaction(db=>assert.rejects(phase(db,old,async()=>assert.fail()),expected('PRINCIPAL_REQUIRED')));
    });
    await check('undefined/null callback failures cannot erase poison',async()=>{
      for(const thrown of [undefined,null]) {
        await assert.rejects(captured(async()=>{throw thrown;}),expected('PRINCIPAL_INVALID'));
        await assert.rejects(captured(async p=>{
          await transaction(async db=>{await assert.rejects(phase(db,p,async()=>{throw thrown;}),expected('PRINCIPAL_INVALID'));});
        }),expected('PRINCIPAL_INVALID'));
      }
    });
    await check('genuine trusted Solo owner and unauthorized member',async()=>{
      const soloBody=Buffer.from(JSON.stringify({...claims,edition:'solo',seatLimit:1,quotas:{users:1},entitlementsVersion:7})).toString('base64url');
      process.env.CANVAS_LICENSE_CERT=`${header}.${soloBody}.${crypto.sign('RSA-SHA256',Buffer.from(`${header}.${soloBody}`),keys.privateKey).toString('base64url')}`;
      assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT,process.env.CANVAS_INSTANCE_ID!)).ok,true);
      const solo=await getLicenseStatus();assert.equal(solo.licensed,true);assert.equal(solo.edition,'solo');assert.equal(solo.seatLimit,1);
      await captured(p=>transaction(db=>phase(db,p,async access=>assert.equal(access.userId,'owner'))));
      await assert.rejects(captured(async()=>assert.fail(),'member'),expected('PRINCIPAL_AUTH_REVOKED'));
    });
    assert.equal(cases,46);
    assert.equal(fetches,0);
    console.log(`Workspace Request Principal PostgreSQL18: ${cases} genuine Cookie/Bearer/Team, scope, lifetime, revocation, predicate-lock and bounds matrix families passed; no API activation.`);
  } finally {
    globalThis.fetch=originalFetch;
    try { if(pool) await pool.end(); }
    finally {
      try { for(const client of clients) await client.end(); }
      finally {
        try { if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);} }
        finally {await control.end();await rm(dataRoot,{ recursive:true,force:true });
          for(const key of Object.keys(process.env)) if(!(key in environment)) delete process.env[key];Object.assign(process.env,environment);}
      }
    }
  }
}
main().catch(error=>{
  console.error('Owned Request Principal fixture failed:',{ stage,name:error instanceof Error?error.name:'unknown',
    code:error && typeof error==='object'?Reflect.get(error,'code')??null:null,
    }); process.exitCode=1;
});
