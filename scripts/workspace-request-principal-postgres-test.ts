import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import type { FileNode } from '../app/lib/files/types';
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
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(),'canvas-request-principal-')));
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
      const result = await admin.query(sql,values); await own(admin); return result;
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
    const { getPostgresRuntimeQueryable, openDb } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!,process.env.CANVAS_INSTANCE_ID!)).ok,true);
    const license = await getLicenseStatus(); assert.equal(license.licensed,true); assert.equal(license.edition,'team'); assert.equal(license.seatLimit,2);
    const { auth } = await import('../app/lib/auth');
    const { withWorkspaceRequestPrincipal: capture,withWorkspaceRequestPrincipalOnConnection: phase,
      WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
    const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
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
            if(!sql.includes('AS permission_can_create_public_links')
              || values[0]!== (mode==='selected'?team.workspaceId:'principal-org') || values[1]!=='member'||++permissionReads!==1)return original;
            return Promise.resolve(original).then(async result=>{
              const teamRow=result.rows.find((row:{id:string})=>row.id===team.workspaceId);assert(teamRow);
              assert.equal(teamRow.permission_can_create_public_links,1);
              assert.equal(teamRow.team_present,null,'The same SQL snapshot must still observe the absent team membership.');
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
    for(const mode of ['confirmed-busy','rollback-ack-lost','release-ack-lost','rollback-and-discard-ack-lost',
      'swallowed-busy','swallowed-detached'] as const)
    await check(`actual member factory and lifecycle error precedence ${mode}`,async()=>{
      const blocker=await ownClient(),lockPath=`principal-error-precedence-${crypto.randomUUID()}`;
      const rollbackAckError=new Error('Owned member fixture lost the actual ROLLBACK acknowledgement.');
      const releaseAckError=new Error('Owned member fixture failed after the actual checkout release.');
      const loseRollbackAck=mode==='rollback-ack-lost'||mode==='rollback-and-discard-ack-lost';
      const loseReleaseAck=mode==='release-ack-lost'||mode==='rollback-and-discard-ack-lost';
      const swallow=mode==='swallowed-busy'||mode==='swallowed-detached';
      let blockerPid=0,writerPid=0,checkouts=0,phaseCallbacks=0,commits=0,rollbacks=0,rollbackAcknowledged=false;
      let closes=0,released=false,published=false,recoveries=0,actualSqlError:unknown,phaseError:unknown,callbackError:unknown;
      const closeArguments:Array<Error|undefined>=[];
      try{
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',['org-space',lockPath]);
        blockerPid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const outcome=await captured(async principal=>{
          try{
            return await executeLifecycleTransaction({
              openConnection:async():Promise<SqlConnection>=>{
                const actual=await openDb();checkouts++;
                writerPid=Number((await actual.get('SELECT pg_backend_pid() AS pid') as {pid:number}).pid);
                assert(Number.isSafeInteger(writerPid)&&writerPid>0);assert.notEqual(writerPid,blockerPid);
                // Delegate every actual SQL query and every original close
                // argument. Only delivery after real completion may fail.
                return {...actual,run:async(sql,values)=>{
                  if(sql==='COMMIT')commits++;
                  if(sql==='ROLLBACK')rollbacks++;
                  const result=await actual.run(sql,values);
                  if(sql==='ROLLBACK'){
                    rollbackAcknowledged=true;
                    if(loseRollbackAck)throw rollbackAckError;
                  }
                  return result;
                },close:async(error?:Error)=>{
                  closes++;closeArguments.push(error);assert.equal(closes,1);
                  await actual.close(error);released=true;
                  if(loseReleaseAck)throw releaseAckError;
                }};
              },
              execute:async database=>{
                await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
                try{
                  return await phase(database,principal,async access=>{
                    phaseCallbacks++;
                    assert.equal(access.userId,'owner');assert.equal(access.sessionId,'session-owner');
                    assert.equal(access.workspace.workspaceId,'org-space');
                    if(mode==='swallowed-detached'){
                      // The original phase must drain this genuine SQL check
                      // and poison its factory even when the caller catches it.
                      void access.assertCurrent().catch(()=>undefined);
                      return 'a detached phase must never publish this';
                    }
                    try{
                      await database.get('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',['org-space',lockPath]);
                    }catch(error){actualSqlError=error;throw error;}
                    assert.fail('The original held advisory lock must produce an actual PostgreSQL 55P03.');
                  });
                }catch(error){phaseError=error;throw error;}
              },
              recoverCommitted:async()=>{recoveries++;assert.fail('Failed principal execution must never enter COMMIT recovery.');},
            });
          }catch(error){
            callbackError=error;
            if(swallow)return 'a poisoned factory must never publish this';
            throw error;
          }
        }).then(value=>{published=true;return {ok:true as const,value};},error=>({ok:false as const,error}));
        assert.equal(outcome.ok,false,'Even a swallowed phase poison must reject the original member factory.');
        if(outcome.ok)assert.fail('A poisoned principal unexpectedly published a value.');
        const error:unknown=outcome.error;
        assert(phaseError instanceof WorkspaceRequestPrincipalError);
        assert.equal(phaseError.code,mode==='swallowed-detached'?'PRINCIPAL_DETACHED':'PRINCIPAL_BUSY');
        assert.equal(checkouts,1);assert.equal(phaseCallbacks,1);assert.equal(published,false);
        assert.equal(commits,0);assert.equal(rollbacks,1);assert.equal(rollbackAcknowledged,true);
        assert.equal(closes,1);assert.equal(released,true);assert.equal(recoveries,0);
        if(mode==='swallowed-detached')assert.equal(actualSqlError,undefined);
        else{
          assert(actualSqlError&&typeof actualSqlError==='object');
          assert.equal(Reflect.get(actualSqlError,'code'),'55P03');
        }
        if(loseRollbackAck){
          assert(closeArguments[0] instanceof Error);assert.equal(closeArguments[0].cause,rollbackAckError);
          await waitForPrincipalRegression(async()=>(await admin.query(
            'SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent',[writerPid])).rows[0].absent===true,
          'The actually discarded principal backend must leave PostgreSQL.');
        }else{
          assert.deepEqual(closeArguments,[undefined],'A clean ROLLBACK must keep the original ordinary release argument.');
          await waitForPrincipalRegression(async()=>{
            const rows=(await admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[writerPid])).rows;
            return rows.length===0||rows[0].state==='idle'&&rows[0].xact_start===null;
          },'An ordinarily released principal backend must retain no open transaction.');
        }
        await waitForPrincipalRegression(()=>runtime.totalCount===runtime.idleCount&&runtime.waitingCount===0,
          'The genuine principal lifecycle must leave no runtime checkout or pool waiter behind.');
        // Emit the genuine SQL/rollback/release witness before checking error
        // precedence, so the original RED cannot masquerade as a setup failure.
        console.log('Actual member principal error-precedence witness:',JSON.stringify({mode,blockerPid,writerPid,
          sqlCode:mode==='swallowed-detached'?null:'55P03',checkouts,rollbacks,rollbackAcknowledged,closes,
          discarded:loseRollbackAck,released,commits,recoveries,published,
          callbackErrorName:callbackError instanceof Error?callbackError.name:typeof callbackError,
          propagatedErrorName:error instanceof Error?error.name:typeof error,
          propagatedCode:error&&typeof error==='object'?Reflect.get(error,'code')??null:null}));
        if(loseRollbackAck){
          assert(callbackError instanceof AggregateError,'The real lifecycle helper must first aggregate its actual failures.');
          assert.deepEqual(callbackError.errors,loseReleaseAck?[phaseError,rollbackAckError,releaseAckError]:[phaseError,rollbackAckError]);
          assert(error instanceof AggregateError,'A later failed ROLLBACK acknowledgement must not collapse to the earlier principal poison.');
          assert.equal(error,callbackError);
        }else if(loseReleaseAck){
          assert.equal(callbackError,releaseAckError);
          assert.equal(error,releaseAckError,'A real later checkout release failure must not collapse to PRINCIPAL_BUSY.');
        }else{
          assert.equal(callbackError,phaseError);
          assert.equal(error,phaseError,'Confirmed busy and swallowed poison must retain the original actual principal error.');
        }
      }finally{
        await blocker.query('ROLLBACK').catch(()=>undefined);await endClient(blocker);
      }
    });
    // Integration stays on the original request factory and runtime pool. These
    // rows are fixture data in the same owned schema, never Principal grants.
    const { updateWorkspaceFileMetadata,metadataFileWriteFailure,enrichWorkspaceFileNodes } = await import('../app/lib/files/workspace-file-metadata');
    const { PATCH: metadataPatch } = await import('../app/api/files/metadata/route');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { collaborationAdmissionActionDigest } = await import('../app/lib/collaboration/room-admission-contract');
    const { createCollaborationRoomOwnerSession, assertCollaborationRoomOwnerFence } = await import('../app/lib/collaboration/room-owner');
    const { withWorkspaceFileLifecycleGuard } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const workspace = await captured(principal=>transaction(db=>phase(db,principal,async access=>access.workspace)));
    assert.equal(workspace.workspaceId,'org-space');assert.equal(workspace.organizationId,'principal-org');
    await mkdir(workspace.rootPath,{recursive:true});
    const metadataOpenConnection = async ():Promise<SqlConnection> => {
      const client=await ownClient();
      return {...connection(client),close:async()=>endClient(client)};
    };
    const admission = createCollaborationAdmissionService({openConnection:metadataOpenConnection});
    const nativeTarget = async (filePath:string) => {
      const documentId=`metadata-${crypto.randomUUID()}`,lineageId=`metadata-lineage-${crypto.randomUUID()}`;
      const doc=new Y.Doc();let update:Buffer,vector:Buffer;
      try{doc.getText('content').insert(0,'Native metadata fixture.');update=Buffer.from(Y.encodeStateAsUpdate(doc));vector=Buffer.from(Y.encodeStateVector(doc));}
      finally{doc.destroy();}
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,'org-space','organization','principal-org',$2,'active',100)`,[lineageId,filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'org-space','organization','principal-org',$3,'yjs',7,'initialized','active',100,100)`,[documentId,lineageId,filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,'org-space','principal-org',$2,'plain_text',1,1,$3,$4,7,100,7,100,'fixture','fixture','lf',0,0,'active')`,[documentId,filePath,update!,vector!]);
      return {expectedTarget:{version:1 as const,workspaceId:'org-space',path:filePath,kind:'native_file' as const,documentId,lifecycleGeneration:1},
        scope:{documentId,workspaceId:'org-space',organizationId:'principal-org',path:filePath,representation:'plain_text' as const,lifecycleGeneration:1,schemaVersion:1},lineageId};
    };
    const physicalTarget = async (filePath:string,entryType:'file'|'directory'='file') => {
      const absolute=path.join(workspace.rootPath,filePath);await mkdir(path.dirname(absolute),{recursive:true});
      if(entryType==='directory')await mkdir(absolute);else await writeFile(absolute,'Physical metadata fixture.');
      return {version:1 as const,workspaceId:'org-space',path:filePath,kind:'filesystem' as const,fileVersion:filesystemFileVersion(await stat(absolute)),entryType};
    };
    const metadataRows = async (filePath:string) => ({
      title:(await admin.query('SELECT * FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',['org-space',filePath])).rows,
      users:(await admin.query('SELECT * FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 ORDER BY user_id',['org-space',filePath])).rows,
    });
    const nativeRows = async (documentId:string) => ({
      registry:(await admin.query('SELECT * FROM collaboration_documents WHERE id=$1',[documentId])).rows,
      lineage:(await admin.query('SELECT l.* FROM file_collaboration_lineages l JOIN collaboration_documents d ON d.lineage_id=l.id WHERE d.id=$1',[documentId])).rows,
      state:(await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1',[documentId])).rows,
    });
    const metadataWrite = async (target:Record<string,unknown>,fields:Record<string,unknown>,userId='owner',cookie=false) =>
      updateWorkspaceFileMetadata(await request(userId,cookie),{path:target.path,...fields,expectedTarget:target});
    const metadataRoute = async (input:unknown,userId='owner',cookie=false) => {
      const authenticated=await request(userId,cookie),headers=new Headers(authenticated.headers);headers.set('content-type','application/json');
      return metadataPatch(new NextRequest(authenticated.url,{method:'PATCH',headers,body:JSON.stringify(input)}));
    };
    const metadataReject = async (input:unknown,code:string,userId='owner') =>
      assert.rejects(updateWorkspaceFileMetadata(await request(userId),input),error=>{
        if(!expected(code)(error))return false;
        return !code.startsWith('FILE_METADATA_')&&!code.startsWith('SIDE_EFFECT_WRITER_')
          || Reflect.get(error as object,'status')===(code==='FILE_METADATA_INVALID'?400:409);
      });
    await check('metadata original Cookie/Bearer service atomically commits native and physical annotations',async()=>{
      const target=await nativeTarget('metadata-native.md'),before=await nativeRows(target.scope.documentId);
      for(const cookie of [true,false]){
        const returned=await metadataWrite(target.expectedTarget,{title:'  Native   title ',isFavorite:true,pinned:true},'owner',cookie);
        assert.equal(returned.workspaceId,'org-space');assert.equal(returned.actor?.userId,'owner');
        const rows=await metadataRows(target.scope.path);assert.equal(rows.title[0]?.title,'Native title');
        assert.equal(rows.users.length,1);assert.equal(rows.users[0].user_id,'owner');assert.equal(Number(rows.users[0].is_favorite),1);assert(Number(rows.users[0].pinned_at)>0);
      }
      const response=await metadataRoute({path:target.scope.path,title:'Native title',isFavorite:true,pinned:true,expectedTarget:target.expectedTarget},'owner',true);
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true});
      assert.deepEqual(await nativeRows(target.scope.documentId),before,'Metadata must leave every native state/registry field unchanged.');
      for(const entryType of ['file','directory'] as const){
        const physical=await physicalTarget(`metadata-physical-${entryType}${entryType==='file'?'.txt':''}`,entryType);
        const absolute=path.join(workspace.rootPath,physical.path),beforeStat=await stat(absolute);
        const beforeBytes=entryType==='file'?await readFile(absolute):null;
        await metadataWrite(physical,{title:'Physical title',isFavorite:true,pinned:true});
        assert.equal((await metadataRows(physical.path)).title[0]?.title,'Physical title');
        assert.equal(filesystemFileVersion(await stat(absolute)),filesystemFileVersion(beforeStat));
        if(beforeBytes)assert.deepEqual(await readFile(absolute),beforeBytes);
      }
    });
    await check('metadata expected target and field validation reject before any annotation mutation',async()=>{
      const target=await nativeTarget('metadata-invalid.md'),before=await metadataRows(target.scope.path);
      const physical=await physicalTarget('metadata-invalid-array.txt'),physicalBefore=await metadataRows(physical.path);
      const base={path:target.scope.path,title:'Rejected',expectedTarget:target.expectedTarget};
      for(const input of [null,[],{path:target.scope.path,title:'Missing identity'},
        {...base,expectedTarget:{...target.expectedTarget,version:2}},
        {...base,title:4},{...base,isFavorite:'true'},{...base,pinned:null},
        {path:target.scope.path,expectedTarget:target.expectedTarget},
        {...base,title:'x'.repeat(161)}, {...base,path:'../escape.md'},
        // A physical field set makes each coercible array reach the former
        // physical dispatch branch, rather than fail on unrelated missing keys.
        ...[['native_file'],['filesystem']].map(kind=>({path:physical.path,title:'Rejected array kind',expectedTarget:{...physical,kind}})),
        {path:physical.path,title:'Rejected array entry type',expectedTarget:{...physical,entryType:['file']}},
      ]){
        await metadataReject(input,'FILE_METADATA_INVALID');assert.deepEqual(await metadataRows(target.scope.path),before);
        assert.deepEqual(await metadataRows(physical.path),physicalBefore);
      }
      assert.equal(filesystemFileVersion(await stat(path.join(workspace.rootPath,physical.path))),physical.fileVersion);
      const response=await metadataRoute({path:target.scope.path,title:'Missing target'});
      assert.equal(response.status,400);assert.equal((await response.json()).code,'FILE_METADATA_INVALID');
    });
    await check('metadata stale native generation path and replacement identities fail closed',async()=>{
      const target=await nativeTarget('metadata-stale.md'),replacement=await nativeTarget('metadata-replacement.md');
      const before=await metadataRows(target.scope.path);
      for(const changed of [
        {...target.expectedTarget,lifecycleGeneration:2},
        {...target.expectedTarget,path:'metadata-no-longer-here.md'},
        {...target.expectedTarget,documentId:replacement.scope.documentId},
        {...target.expectedTarget,workspaceId:'personal-owner'},
      ]){await metadataReject({path:changed.path,title:'Stale',isFavorite:true,expectedTarget:changed},'FILE_METADATA_SCOPE_CHANGED');}
      await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1',[target.scope.documentId]);
      try{await metadataReject({path:target.scope.path,title:'Stale',expectedTarget:target.expectedTarget},'FILE_METADATA_SCOPE_CHANGED');}
      finally{await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=1 WHERE document_id=$1',[target.scope.documentId]);}
      assert.deepEqual(await metadataRows(target.scope.path),before);
      const physical=await physicalTarget('metadata-stale-physical.txt'),absolute=path.join(workspace.rootPath,physical.path);
      await rename(absolute,`${absolute}.original`);await writeFile(absolute,'Replacement physical metadata fixture.');
      assert.notEqual(filesystemFileVersion(await stat(absolute)),physical.fileVersion);
      await metadataReject({path:physical.path,title:'Stale physical',expectedTarget:physical},'FILE_METADATA_SCOPE_CHANGED');
      assert.deepEqual(await metadataRows(physical.path),{title:[],users:[]});
      await rm(absolute);await rename(`${absolute}.original`,absolute);
      const whitespace={...physical,path:` ${physical.path} `};
      await metadataReject({path:whitespace.path,title:'Wrong trimmed target',expectedTarget:whitespace},'FILE_METADATA_SCOPE_CHANGED');
      assert.deepEqual(await metadataRows(physical.path),{title:[],users:[]});
      const response=await metadataRoute({path:target.scope.path,title:'Stale',expectedTarget:{...target.expectedTarget,lifecycleGeneration:2}});
      assert.equal(response.status,409);assert.equal((await response.json()).code,'FILE_METADATA_SCOPE_CHANGED');
    });
    await check('metadata genuine exact and subtree admission reservations block only intersecting targets',async()=>{
      const target=await nativeTarget('metadata-admission/target.md'),unrelated=await nativeTarget('metadata-unrelated.md');
      for(const subtree of [false,true]){
        const actionPayloadText=JSON.stringify({source:target.scope.path,destination:'metadata-moved.md'});
        const reserved={requestId:crypto.randomUUID(),actorId:'owner',action:'move' as const,actionPayloadText,
          actionDigest:collaborationAdmissionActionDigest('move',actionPayloadText),
          scopes:[{workspaceId:'org-space',organizationId:'principal-org',path:subtree?'metadata-admission':target.scope.path,kind:subtree?'subtree' as const:'exact' as const}],
          expectedDocuments:[{...target.scope,status:'active' as const}]};
        await admission.reserve(reserved);
        try{
          await metadataReject({path:target.scope.path,title:'Blocked',isFavorite:true,expectedTarget:target.expectedTarget},'SIDE_EFFECT_WRITER_BUSY');
          assert.deepEqual(await metadataRows(target.scope.path),{title:[],users:[]});
          await metadataWrite(unrelated.expectedTarget,{title:'Unrelated remains available'});
        }finally{await admission.cancel(reserved,1);}
      }
      await metadataWrite(target.expectedTarget,{title:'After genuine cancellation'});
    });
    await check('metadata active genuine room owner permits content growth without identity drift',async()=>{
      const target=await nativeTarget('metadata-active-owner.md'),ownerClient=await ownClient();
      const owner=await createCollaborationRoomOwnerSession(ownerClient),fence=await owner.acquire(target.scope);
      const originalQuery=Client.prototype.query,release=principalRegressionSignal();
      let paused=false,metadataPid:number|undefined;
      Client.prototype.query=function(this:Client,...args:unknown[]){
        const sql=typeof args[0]==='string'?args[0]:'',values=Array.isArray(args[1])?args[1]:[];
        if(!paused&&/^\s*INSERT INTO (?:"[^"]+"\.)?workspace_file_metadata\b/iu.test(sql)&&values.includes(target.scope.path)){
          paused=true;metadataPid=Number(Reflect.get(this,'processID'));
          return release.promise.then(()=>Reflect.apply(originalQuery,this,args));
        }
        return Reflect.apply(originalQuery,this,args);
      } as typeof Client.prototype.query;
      const writing=observePrincipalRegression(metadataWrite(target.expectedTarget,{title:'Room remains writable'}));
      try{
        await waitForPrincipalRegression(()=>paused||writing.isSettled(),'Actual metadata DML did not reach its room-owner barrier.');
        assert(paused);assert(metadataPid);assert.notEqual(metadataPid,Number(Reflect.get(ownerClient,'processID')));
        owner.assertActive(fence);await ownerClient.query('BEGIN');
        try{
          const row=(await ownerClient.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE',[target.scope.documentId])).rows[0];
          await assertCollaborationRoomOwnerFence(connection(ownerClient),row,fence);
          const doc=new Y.Doc();
          try{
            Y.applyUpdate(doc,row.yjs_state);doc.getText('content').insert(doc.getText('content').length,' Room update.');
            await ownerClient.query(`UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,document_sequence=document_sequence+1,persisted_at=101 WHERE document_id=$1`,
              [target.scope.documentId,Buffer.from(Y.encodeStateAsUpdate(doc)),Buffer.from(Y.encodeStateVector(doc))]);
          }finally{doc.destroy();}
          await ownerClient.query('UPDATE collaboration_documents SET state_version=state_version+1 WHERE id=$1',[target.scope.documentId]);
          await ownerClient.query('COMMIT');
        }catch(error){await ownerClient.query('ROLLBACK').catch(()=>undefined);throw error;}
        release.release();const result=await writing.done;if(!result.ok)throw result.error;
        assert.equal((await metadataRows(target.scope.path)).title[0]?.title,'Room remains writable');
        const state=(await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1',[target.scope.documentId])).rows[0];
        assert.equal(Number(state.document_sequence),8);assert.equal(Number(state.lifecycle_generation),1);assert.equal(state.room_owner_token,fence.token);
        const doc=new Y.Doc();try{Y.applyUpdate(doc,state.yjs_state);assert.equal(doc.getText('content').toString(),'Native metadata fixture. Room update.');}finally{doc.destroy();}
      }finally{
        release.release();await writing.done;Client.prototype.query=originalQuery;await owner.close();clients.delete(ownerClient);
      }
    });
    await check('metadata personal fields are current-user only and read-only members cannot alter titles',async()=>{
      const target=await nativeTarget('metadata-two-users.md');
      await metadataWrite(target.expectedTarget,{title:'Owner title',isFavorite:true,pinned:true},'owner',true);
      await metadataWrite(target.expectedTarget,{isFavorite:true,pinned:true},'member',false);
      const before=await metadataRows(target.scope.path);assert.deepEqual(before.users.map(row=>row.user_id),['member','owner']);
      await metadataReject({path:target.scope.path,title:'Forbidden',isFavorite:false,pinned:false,expectedTarget:target.expectedTarget},'PRINCIPAL_ACCESS_DENIED','member');
      const response=await metadataRoute({path:target.scope.path,title:'Forbidden',expectedTarget:target.expectedTarget},'member',true);
      assert.equal(response.status,403);assert.equal((await response.json()).code,'PRINCIPAL_ACCESS_DENIED');
      assert.deepEqual(await metadataRows(target.scope.path),before,'A denied title must not partly change the personal fields.');
      await metadataWrite(target.expectedTarget,{isFavorite:false,pinned:false},'member',true);
      const after=await metadataRows(target.scope.path);assert.equal(after.title[0]?.title,'Owner title');
      assert.deepEqual(after.users,[before.users.find(row=>row.user_id==='owner')]);
    });
    await check('metadata disjoint favorite and pin patches preserve both commits for missing and existing rows',async()=>{
      const diagnosticOriginalQuery=Client.prototype.query;
      let diagnosticSubcase='not-started',diagnosticPhase='fixture-setup';
      const queryCategory=(sql:string):string=>{
        const normalized=sql.trim().replace(/\s+/gu,' ');
        if(normalized.includes('pg_advisory_xact_lock(hashtext($1), hashtext($2))'))return 'metadata-path-advisory-lock';
        if(normalized.includes('pg_try_advisory_xact_lock_shared('))return 'native-shared-lifecycle-fence';
        if(/^LOCK TABLE\b/iu.test(normalized))return 'principal-foundation-table-lock';
        if(/\bFOR SHARE NOWAIT\b/iu.test(normalized))return 'principal-foundation-row-lock';
        if(/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"[^"]+"\.)?workspace_file_user_states\b/iu.test(normalized))return 'metadata-user-state-DML';
        if(/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"[^"]+"\.)?workspace_file_metadata\b/iu.test(normalized))return 'metadata-title-DML';
        if(/^BEGIN\b/iu.test(normalized))return 'transaction-begin';
        if(/^COMMIT\b/iu.test(normalized))return 'transaction-commit';
        if(/^ROLLBACK\b/iu.test(normalized))return 'transaction-rollback';
        if(/^SET\b/iu.test(normalized))return 'transaction-configuration';
        if(/^SELECT\b/iu.test(normalized)&&normalized.includes('pg_blocking_pids('))return 'fixture-path-waiter-observation';
        if(/^SELECT\b/iu.test(normalized))return 'read-query';
        return 'other-query';
      };
      Client.prototype.query=function(this:Client,...args:unknown[]){
        const sql=typeof args[0]==='string'?args[0]:args[0]&&typeof args[0]==='object'?String(Reflect.get(args[0],'text')??''):'';
        const category=queryCategory(sql),subcase=diagnosticSubcase,startedInPhase=diagnosticPhase,startedAt=performance.now();
        const backendPid=Number(Reflect.get(this,'processID'));
        const observeLockFailure=(error:unknown):void=>{
          // Observe the original query rejection only. Never print SQL, values,
          // credentials, or replace the original result/error with this witness.
          try{
            if(!error||typeof error!=='object'||Reflect.get(error,'code')!=='55P03')return;
            console.error('Actual metadata concurrency 55P03 witness:',JSON.stringify({
              subcase,category,startedInPhase,observedInPhase:diagnosticPhase,
              elapsedMs:Math.round((performance.now()-startedAt)*100)/100,
              backendPid:Number.isSafeInteger(backendPid)&&backendPid>0?backendPid:null,
            }));
          }catch{/* Diagnostic output must not change the original query outcome. */}
        };
        try{
          const result=Reflect.apply(diagnosticOriginalQuery,this,args);
          if(result&&(typeof result==='object'||typeof result==='function')&&typeof Reflect.get(result,'then')==='function')void Promise.resolve(result).then(()=>undefined,observeLockFailure);
          return result;
        }catch(error){observeLockFailure(error);throw error;}
      } as typeof Client.prototype.query;
      try{
      for(const existing of [false,true])for(const favoriteFirst of [false,true]){
        diagnosticSubcase=existing?(favoriteFirst?'existing/favorite-first':'existing/pin-first')
          :(favoriteFirst?'missing/favorite-first':'missing/pin-first');
        diagnosticPhase='fixture-setup';
        console.log('Actual metadata concurrency subcase:',diagnosticSubcase);
        const target=await nativeTarget(`metadata-concurrency-${existing}-${favoriteFirst}.md`);
        diagnosticPhase='fixture-prepopulation';
        if(existing)await metadataWrite(target.expectedTarget,{isFavorite:true,pinned:true});
        // The original kernel lock genuinely permits awaited reentrant calls.
        // Hold it once so two actual service transactions reach the SQL path
        // lock; no synthetic ALS lease or authority object is installed.
        await withWorkspaceMutationLock('org-space',async()=>{
        const originalQuery=Client.prototype.query,release=principalRegressionSignal();
        let firstPid:number|undefined,paused=false;
        Client.prototype.query=function(this:Client,...args:unknown[]){
          const sql=typeof args[0]==='string'?args[0]:'',values=Array.isArray(args[1])?args[1]:[];
          if(!paused&&/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"[^"]+"\.)?workspace_file_user_states\b/iu.test(sql)&&values.includes(target.scope.path)){
            paused=true;firstPid=Number(Reflect.get(this,'processID'));
            return release.promise.then(()=>Reflect.apply(originalQuery,this,args));
          }
          return Reflect.apply(originalQuery,this,args);
        } as typeof Client.prototype.query;
        // Existing-row case removes both fields; missing-row case adds both.
        const favorite={isFavorite:!existing},pin={pinned:!existing};
        diagnosticPhase='first-service-request';
        const first=observePrincipalRegression(metadataWrite(target.expectedTarget,favoriteFirst?favorite:pin));
        let second:ReturnType<typeof observePrincipalRegression<Awaited<ReturnType<typeof metadataWrite>>>>|undefined;
        try{
          await waitForPrincipalRegression(()=>paused||first.isSettled(),'The first real user-state DML did not reach its barrier.');assert(paused);assert(firstPid);
          diagnosticPhase='overlap-before-path-lock-witness';
          second=observePrincipalRegression(metadataWrite(target.expectedTarget,favoriteFirst?pin:favorite));
          let waiter:Record<string,unknown>|undefined;
          await waitForPrincipalRegression(async()=>{
            waiter=(await admin.query(`SELECT pid,xact_start IS NOT NULL AS in_transaction,backend_xid IS NOT NULL AS xid_assigned
              FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))`,[firstPid])).rows[0];
            return waiter!==undefined||second!.isSettled();
          },'The second real service transaction did not reach its path-lock waiter.');
          diagnosticPhase=waiter?'path-lock-witness-observed':'second-request-settled-before-witness';
          assert(waiter,'The second partial patch must wait at the real PostgreSQL path lock.');
          assert.notEqual(waiter.pid,firstPid);assert.equal(waiter.in_transaction,true);assert.equal(waiter.xid_assigned,true);
          assert.equal((await admin.query('SELECT xact_start IS NOT NULL AS active FROM pg_stat_activity WHERE pid=$1',[firstPid])).rows[0]?.active,true);
          diagnosticPhase='first-DML-released-awaiting-original-outcomes';
          release.release();const outcomes=await Promise.all([first.done,second.done]);for(const outcome of outcomes)if(!outcome.ok)throw outcome.error;
          diagnosticPhase='original-outcomes-settled';
          const rows=await metadataRows(target.scope.path);
          if(existing)assert.deepEqual(rows.users,[],'Both independent removals must survive.');
          else{assert.equal(rows.users.length,1);assert.equal(Number(rows.users[0].is_favorite),1);assert(Number(rows.users[0].pinned_at)>0,'The omitted pin must survive the other patch.');}
        }finally{diagnosticPhase='draining-original-fixture-promises';release.release();await first.done;if(second)await second.done;Client.prototype.query=originalQuery;}
        });
      }
      }finally{Client.prototype.query=diagnosticOriginalQuery;}
    });
    await check('metadata genuine SQL failure rolls back title and personal changes together',async()=>{
      const target=await nativeTarget('metadata-rollback.md');await metadataWrite(target.expectedTarget,{title:'Before rollback'});
      const before=await metadataRows(target.scope.path),nativeBefore=await nativeRows(target.scope.documentId);
      await admin.query("ALTER TABLE workspace_file_user_states ADD CONSTRAINT metadata_fixture_reject CHECK(path<>'metadata-rollback.md')");
      try{await assert.rejects(metadataWrite(target.expectedTarget,{title:'Must roll back',isFavorite:true,pinned:true}),expected('23514'));}
      finally{await admin.query('ALTER TABLE workspace_file_user_states DROP CONSTRAINT metadata_fixture_reject');}
      assert.deepEqual(await metadataRows(target.scope.path),before);assert.deepEqual(await nativeRows(target.scope.documentId),nativeBefore);
      await metadataWrite(target.expectedTarget,{title:'After rollback',isFavorite:true,pinned:true});
      assert.equal((await metadataRows(target.scope.path)).title[0]?.title,'After rollback');
    });
    for(const mode of ['lost-ack','lost-ack-discard-throws','confirmed-commit-release-throws'] as const)
    await check(`metadata actual COMMIT/close ambiguity ${mode} reports named unconfirmed without replay`,async()=>{
      const target=await nativeTarget(`metadata-${mode}.md`),originalQuery=Client.prototype.query;
      const nativeBefore=await nativeRows(target.scope.documentId);
      const actualClients=new Map<Client,(error?:Error)=>void>();
      let pid:number|undefined,titleWrites=0,userUpserts=0,commits=0,rollbacks=0;
      let committed=false,released=false,releaseCalls=0,releaseHadError=false,releaseThrew=false;
      const injectedAck=Object.assign(new Error('Owned fixture lost the successful metadata COMMIT acknowledgement.'),{code:'ECONNRESET'});
      const injectedClose=new Error('Owned fixture threw only after the actual checkout release completed.');
      Client.prototype.query=function(this:Client,...args:unknown[]){
        const sql=(typeof args[0]==='string'?args[0]:'').trim(),values=Array.isArray(args[1])?args[1]:[];
        if(/^INSERT INTO (?:"[^"]+"\.)?workspace_file_metadata\b/iu.test(sql)&&values.includes(target.scope.path)){
          titleWrites++;pid=Number(Reflect.get(this,'processID'));
          if(!actualClients.has(this)){
            const release=Reflect.get(this,'release') as (error?:Error)=>void;assert.equal(typeof release,'function');
            actualClients.set(this,release);
            Reflect.set(this,'release',(error?:Error)=>{
              releaseCalls++;releaseHadError=error instanceof Error;
              const result=Reflect.apply(release,this,[error]);released=true;
              if(mode!=='lost-ack'){releaseThrew=true;throw injectedClose;}
              return result;
            });
          }
        }
        if(actualClients.has(this)&&/^INSERT INTO (?:"[^"]+"\.)?workspace_file_user_states\b/iu.test(sql))userUpserts++;
        if(actualClients.has(this)&&sql==='ROLLBACK')rollbacks++;
        if(actualClients.has(this)&&sql==='COMMIT'){
          commits++;
          return Promise.resolve(Reflect.apply(originalQuery,this,args)).then(result=>{
            committed=true;if(mode!=='confirmed-commit-release-throws')throw injectedAck;return result;
          });
        }
        return Reflect.apply(originalQuery,this,args);
      } as typeof Client.prototype.query;
      try{
        await assert.rejects(metadataWrite(target.expectedTarget,{title:'Actually committed',isFavorite:true,pinned:true}),error=>{
          assert.equal(committed,true);assert.equal(released,true,'The actual checkout release must precede the unconfirmed result.');
          assert.equal(releaseHadError,mode!=='confirmed-commit-release-throws');assert.equal(releaseThrew,mode!=='lost-ack');
          assert.equal((error as Error).name,'WorkspaceFileMetadataWriteError');assert(expected('FILE_METADATA_COMMIT_UNCONFIRMED')(error));
          assert.equal(Reflect.get(error as object,'status'),503);
          const failure=metadataFileWriteFailure(error);assert.equal(failure?.code,'FILE_METADATA_COMMIT_UNCONFIRMED');assert.equal(failure?.status,503);return true;
        });
        assert(pid);assert.equal(actualClients.size,1);assert.equal(commits,1);assert.equal(titleWrites,1);assert.equal(userUpserts,1);assert.equal(rollbacks,0);assert.equal(releaseCalls,1);
        if(mode!=='confirmed-commit-release-throws'){
          await waitForPrincipalRegression(async()=>(await admin.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent',[pid])).rows[0].absent===true,
            'The actually discarded metadata backend did not leave PostgreSQL.');
        }
        const rows=await metadataRows(target.scope.path);assert.equal(rows.title[0]?.title,'Actually committed');
        assert.equal(rows.users.length,1);assert.equal(Number(rows.users[0].is_favorite),1);assert(Number(rows.users[0].pinned_at)>0);
        assert.deepEqual(await nativeRows(target.scope.documentId),nativeBefore);
      }finally{
        Client.prototype.query=originalQuery;for(const [client,release] of actualClients)Reflect.set(client,'release',release);
      }
    });
    await check('metadata actual exclusive lifecycle guard rejects nested ordinary writer without partial fields',async()=>{
      const target=await nativeTarget('metadata-exclusive.md'),before=await metadataRows(target.scope.path);
      await withWorkspaceFileLifecycleGuard({workspaceId:'org-space',paths:[target.scope.path]},async()=>{
        await metadataReject({path:target.scope.path,title:'Nested ordinary writer',isFavorite:true,expectedTarget:target.expectedTarget},'SIDE_EFFECT_WRITER_REENTRANT');
        assert.deepEqual(await metadataRows(target.scope.path),before);
      },metadataOpenConnection);
      await metadataWrite(target.expectedTarget,{title:'Exclusive guard released'});
      assert.equal((await metadataRows(target.scope.path)).title[0]?.title,'Exclusive guard released');
      const physical=await physicalTarget('metadata-exclusive-physical.txt');
      await withWorkspaceFileLifecycleGuard({workspaceId:'org-space',paths:[physical.path]},async()=>{
        await metadataReject({path:physical.path,title:'Nested physical writer',isFavorite:true,expectedTarget:physical},'SIDE_EFFECT_WRITER_BUSY');
        assert.deepEqual(await metadataRows(physical.path),{title:[],users:[]});
      },metadataOpenConnection);
      await metadataWrite(physical,{title:'Physical exclusive guard released'});
    });
    await check('metadata actual enrichment retains one old snapshot while a genuine atomic title and personal patch commits',async()=>{
      const target=await nativeTarget('metadata-coherent-snapshot.md');
      await metadataWrite(target.expectedTarget,{title:'Snapshot before',isFavorite:false,pinned:false});
      const nativeBefore=await nativeRows(target.scope.documentId),originalQuery=Client.prototype.query,release=principalRegressionSignal();
      const node:FileNode={name:target.scope.path,path:target.scope.path,type:'file'};
      let intercepted=false,paused=false,readerPid:number|undefined,writerPid:number|undefined;
      Client.prototype.query=function(this:Client,...args:unknown[]){
        const sql=(typeof args[0]==='string'?args[0]:'').trim().replace(/\s+/gu,' '),values=Array.isArray(args[1])?args[1]:[];
        if(!intercepted&&/^SELECT path, title FROM (?:"[^"]+"\.)?workspace_file_metadata\b/u.test(sql)&&values.includes(target.scope.path)){
          intercepted=true;readerPid=Number(Reflect.get(this,'processID'));
          // Run the unchanged actual query first, then retain its real result.
          // The writer commits only while this result delivery is paused.
          return Promise.resolve(Reflect.apply(originalQuery,this,args)).then(async result=>{
            assert.equal(result.rows.find((row:{path:string})=>row.path===target.scope.path)?.title,'Snapshot before');
            paused=true;await release.promise;return result;
          });
        }
        if(/^INSERT INTO (?:"[^"]+"\.)?workspace_file_metadata\b/u.test(sql)&&values.includes(target.scope.path))writerPid=Number(Reflect.get(this,'processID'));
        return Reflect.apply(originalQuery,this,args);
      } as typeof Client.prototype.query;
      const reading=observePrincipalRegression(enrichWorkspaceFileNodes({nodes:[node],workspace,userId:'owner'}));
      let writing:ReturnType<typeof observePrincipalRegression<Awaited<ReturnType<typeof metadataWrite>>>>|undefined;
      try{
        await waitForPrincipalRegression(()=>paused||reading.isSettled(),'The real title SELECT did not reach its completed-query barrier.');
        assert(paused);assert(readerPid);assert(Number.isSafeInteger(readerPid));assert.equal(reading.isSettled(),false);
        writing=observePrincipalRegression(metadataWrite(target.expectedTarget,{title:'Snapshot after',isFavorite:true,pinned:true},'owner',true));
        await waitForPrincipalRegression(()=>writing!.isSettled(),'The real atomic PATCH must commit while the old read remains paused.');
        const written=await writing.done;if(!written.ok)throw written.error;
        assert(writerPid);assert.notEqual(writerPid,readerPid,'Read and writer must use distinct genuine PostgreSQL backends.');
        const committed=await metadataRows(target.scope.path);assert.equal(committed.title[0]?.title,'Snapshot after');
        assert.equal(committed.users.length,1);assert.equal(Number(committed.users[0].is_favorite),1);assert(Number(committed.users[0].pinned_at)>0);
        assert.equal(reading.isSettled(),false);release.release();
        const read=await reading.done;if(!read.ok)throw read.error;
        assert.equal(read.value.length,1);assert.equal(read.value[0].title,'Snapshot before');
        assert.equal(read.value[0].isFavorite,false,'An old title must not combine with a newer committed favorite.');
        assert.equal(read.value[0].pinnedAt,null,'An old title must not combine with a newer committed pin.');
        const fresh=await enrichWorkspaceFileNodes({nodes:[node],workspace,userId:'owner'});
        assert.equal(fresh[0].title,'Snapshot after');assert.equal(fresh[0].isFavorite,true);assert.equal(fresh[0].pinnedAt,committed.users[0].pinned_at);
        assert.deepEqual(await nativeRows(target.scope.documentId),nativeBefore);
      }finally{release.release();await reading.done;if(writing)await writing.done;Client.prototype.query=originalQuery;}
    });
    await check('metadata actual enrichment preserves exact native spaced paths at root and in nested children without neighbor leaks',async()=>{
      const paths=[' metadata-space.md ','metadata-space.md','metadata-nested/ metadata-space.md ','metadata-nested/metadata-space.md'];
      const targets:Awaited<ReturnType<typeof nativeTarget>>[]=[];
      const annotations=new Map<string,{title:string|null;isFavorite:boolean;pinnedAt:unknown}>();
      for(const [index,filePath] of paths.entries()){
        const target=await nativeTarget(filePath);targets.push(target);
        const spaced=index%2===0,title=`Exact native annotation ${index}`;
        await metadataWrite(target.expectedTarget,{title,isFavorite:spaced,pinned:!spaced});
        const rows=await metadataRows(filePath);assert.equal(rows.title[0]?.title,title);assert.equal(rows.users.length,1);
        annotations.set(filePath,{title,isFavorite:spaced,pinnedAt:rows.users[0].pinned_at});
      }
      const missing=await nativeTarget('  metadata-space.md  ');
      const file=(filePath:string):FileNode=>({name:filePath.split('/').at(-1)!,path:filePath,type:'file'});
      const nodes:FileNode[]=[file(paths[0]),file(paths[1]),file(missing.scope.path),
        {name:'metadata-nested',path:'metadata-nested',type:'directory',children:[file(paths[2]),file(paths[3]),file('metadata-nested/missing.md')]}];
      const originalNodes=structuredClone(nodes);
      const assertAnnotations=(actual:FileNode[],personal=true)=>{
        assert.equal(actual.length,nodes.length);
        const visit=(entries:FileNode[])=>{
          for(const entry of entries){
            const expected=annotations.get(entry.path);
            assert.equal(entry.title,expected?.title??null,`Exact title lookup for ${JSON.stringify(entry.path)}`);
            assert.equal(entry.isFavorite,personal?(expected?.isFavorite??false):false);
            assert.equal(entry.pinnedAt,personal?(expected?.pinnedAt??null):null);
            if(entry.children)visit(entry.children);
          }
        };
        visit(actual);assert.deepEqual(nodes,originalNodes,'Real enrichment must not mutate the input nodes.');
        assert.deepEqual(actual.map(entry=>entry.path),nodes.map(entry=>entry.path));
        assert.deepEqual(actual[3].children?.map(entry=>entry.path),nodes[3].children?.map(entry=>entry.path));
      };
      assertAnnotations(await enrichWorkspaceFileNodes({nodes,workspace,userId:'owner'}));
      assertAnnotations(await enrichWorkspaceFileNodes({nodes,workspace}),false);
      // Removing the spaced note's actual persisted annotations must expose
      // empty values, never the differently annotated trimmed neighbor.
      await metadataWrite(targets[0].expectedTarget,{title:null,isFavorite:false,pinned:false});
      annotations.delete(paths[0]);assert.deepEqual(await metadataRows(paths[0]),{title:[],users:[]});
      assert.deepEqual(await metadataRows(missing.scope.path),{title:[],users:[]});
      assertAnnotations(await enrichWorkspaceFileNodes({nodes,workspace,userId:'owner'}));
    });
    await check('genuine trusted Solo owner and unauthorized member',async()=>{
      const soloBody=Buffer.from(JSON.stringify({...claims,edition:'solo',seatLimit:1,quotas:{users:1},entitlementsVersion:7})).toString('base64url');
      process.env.CANVAS_LICENSE_CERT=`${header}.${soloBody}.${crypto.sign('RSA-SHA256',Buffer.from(`${header}.${soloBody}`),keys.privateKey).toString('base64url')}`;
      assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT,process.env.CANVAS_INSTANCE_ID!)).ok,true);
      const solo=await getLicenseStatus();assert.equal(solo.licensed,true);assert.equal(solo.edition,'solo');assert.equal(solo.seatLimit,1);
      await captured(p=>transaction(db=>phase(db,p,async access=>assert.equal(access.userId,'owner'))));
      await assert.rejects(captured(async()=>assert.fail(),'member'),expected('PRINCIPAL_AUTH_REVOKED'));
    });
    assert.equal(cases,66);
    assert.equal(fetches,0);
    console.log(`Workspace Request Principal PostgreSQL18: ${cases} genuine Cookie/Bearer/Team principal and actual metadata-service transaction, identity, admission, room-owner and partial-patch concurrency families passed.`);
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
