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
import type { RichMigrationWriteAttempt, RichMigrationWriteRequestAccess, RichMigrationWriteRequestInput } from '../app/lib/collaboration/rich-migration-write-request';

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
  const schema = `rich_write_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^rich_write_[a-f0-9]{32}$/u);
  const workspaceId = `rich-write-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-rich-migration-write-'));
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
    const { withWorkspaceRequestPrincipal: capture,withWorkspaceRequestPrincipalOnConnection: originalPhase } = await import('../app/lib/workspaces/request-principal');
    const request = async (userId='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if (cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[userId],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/collaboration/session?path=note.md',{ headers });
    };
    const transaction = async <T>(operation:(db:SqlConnection,client:Client)=>Promise<T>,begin='BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') => {
      const client = await ownClient(); await client.query(begin);
      try { return await operation(connection(client),client); }
      finally { await client.query('ROLLBACK').catch(()=>undefined); await endClient(client); }
    };
    const check = async (name:string,operation:()=>Promise<void>) => { stage=name; await operation(); cases++; console.log(`Rich migration Write Request passed: ${name}`); };
    const expected = (code:string) => (error:unknown) => !!error && typeof error==='object' && Reflect.get(error,'code')===code;

    const { withRichMigrationWriteRequest: captureWrite, withRichMigrationWriteRequestOnConnection: writePhase } = await import('../app/lib/collaboration/rich-migration-write-request');
    const input = (): RichMigrationWriteRequestInput => ({ workspaceId,path:'Notes/Start.md',action:'advance',migration:{
      requestId:crypto.randomUUID(),expectedDocumentId:`expected-${crypto.randomUUID()}`,expectedLifecycleGeneration:1,
      documentSequence:7,stateProof:`yjs-snapshot-sha256-v1:${'a'.repeat(64)}` } });
    const write = async <T>(operation:(attempt:RichMigrationWriteAttempt)=>Promise<T>,userId='owner',cookie=false,command=input()) =>
      captureWrite(await request(userId,cookie),command,operation);
    await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
    await check('genuine trusted Team Cookie/Bearer FIX-canWrite and actual B callback facts',async()=>{
      for(const user of ['owner','member'])for(const cookie of [true,false]){
        const actual=await request(user,cookie),command=input();
        assert.equal((await auth.api.getSession({headers:actual.headers}))?.session.id,`session-${user}`);
        await captureWrite(actual,command,attempt=>transaction(async(db,client)=>{
          assert.equal(JSON.stringify(attempt),'{}');const backend=Reflect.get(client,'processID');
          let retained!:RichMigrationWriteRequestAccess;
          await writePhase(db,attempt,async access=>{
            retained=access;assert.equal(access.userId,user);assert.equal(access.sessionId,`session-${user}`);
            assert.equal(access.workspace.workspaceId,workspaceId);assert.equal(access.workspace.permissions.canWrite,true);
            assert.deepEqual(access.input,command);assert(Object.isFrozen(access));assert(Object.isFrozen(access.input));
            assert(Object.isFrozen(access.input.migration));assert(Object.isFrozen(access.workspace));
            assert.equal(Number((await db.get('SELECT pg_backend_pid() AS pid') as {pid:number}).pid),backend);
            await access.assertCurrent();assert(!JSON.stringify(access).includes(tokens[user]));
          });
          // Values retained as data cannot be refreshed through a closed facade.
          assert(retained);
        }));
      }
    });
    await check('genuine read-only access cannot mint Write Request or borrow a read Principal',async()=>{
      try{await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        await capture(await request('member'),{permission:'canRead'},p=>transaction(db=>originalPhase(db,p,async access=>{
          assert.equal(access.workspace.permissions.canRead,true);assert.equal(access.workspace.permissions.canWrite,false);
        })));
        await assert.rejects(write(async()=>assert.fail(),'member'),expected('PRINCIPAL_ACCESS_DENIED'));
      }finally{await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");}
      await capture(await request(),{permission:'canRead'},p=>transaction(db=>assert.rejects(
        writePhase(db,p as unknown as RichMigrationWriteAttempt,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_REQUIRED'))));
    });
    await check('real invalid Cookie/Bearer/API-key/guest inputs have no capability',async()=>{
      for(const headers of [{authorization:'Bearer forged'},{cookie:'better-auth.session_token=forged'},{'x-api-key':'forged'},{'x-canvas-guest-token':'forged'}] as Array<Record<string,string>>)
        await assert.rejects(captureWrite(new NextRequest('http://localhost/api/files/collaboration/session',{headers}),input(),async()=>assert.fail()),expected('PRINCIPAL_AUTH_REVOKED'));
    });
    await check('headers and strict copied command survive mutation after first await',async()=>{
      const actual=await request(),command={...input(),migration:{...input().migration}},before=structuredClone(command);
      const running=captureWrite(actual,command,attempt=>transaction(db=>writePhase(db,attempt,async access=>assert.deepEqual(access.input,before))));
      actual.headers.set('authorization','Bearer forged');actual.headers.set('x-canvas-workspace-id','foreign');
      command.workspaceId='foreign';command.path='../foreign';command.action='cancel';command.migration.expectedDocumentId='foreign';
      await running;
    });
    await check('unknown/accessor/malformed command is rejected without invoking its getters',async()=>{
      let getters=0;const accessor={...input()};Object.defineProperty(accessor,'path',{enumerable:true,get:()=>{getters++;return 'Notes/Start.md';}});
      const nested={...input(),migration:{...input().migration}};Object.defineProperty(nested.migration,'stateProof',{enumerable:true,get:()=>{getters++;return `yjs-snapshot-sha256-v1:${'a'.repeat(64)}`;}});
      for(const invalid of [null,{},accessor,nested,{...input(),actorId:'owner'},{...input(),path:'/absolute'},
        {...input(),path:'../escape'},{...input(),action:'read'},{...input(),migration:{...input().migration,documentSequence:-1}}])
        await assert.rejects(captureWrite(await request(),invalid as RichMigrationWriteRequestInput,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_INVALID'));
      assert.equal(getters,0);
    });
    await check('forged/copied/retained attempts cannot enter a B phase',async()=>{
      let retained!:RichMigrationWriteAttempt;await write(async attempt=>{retained=attempt;});
      await transaction(db=>assert.rejects(writePhase(db,retained,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_REQUIRED')));
      await assert.rejects(write(attempt=>transaction(async db=>{
        await assert.rejects(writePhase(db,{...attempt} as RichMigrationWriteAttempt,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_REQUIRED'));
      })),expected('RICH_MIGRATION_WRITE_REQUIRED'));
    });
    await check('wrong/foreign Request context poisons both real request lifetimes',async()=>{
      await assert.rejects(write(async outer=>{
        await assert.rejects(write(inner=>transaction(async db=>{
          assert(inner);await assert.rejects(writePhase(db,outer,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_REQUIRED'));
        })),expected('RICH_MIGRATION_WRITE_REQUIRED'));
      }),expected('RICH_MIGRATION_WRITE_REQUIRED'));
    });
    await check('caught malformed B/operation and nested invalid capture poison the actual outer callback',async()=>{
      for(const invalid of [null,{},'foreign']) await assert.rejects(write(async attempt=>{
        await assert.rejects(writePhase(invalid as unknown as SqlConnection,attempt,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_INVALID'));
      }),expected('RICH_MIGRATION_WRITE_INVALID'));
      await assert.rejects(write(attempt=>transaction(async db=>{
        await assert.rejects(writePhase(db,attempt,null as unknown as ()=>Promise<void>),expected('RICH_MIGRATION_WRITE_INVALID'));
      })),expected('RICH_MIGRATION_WRITE_INVALID'));
      await assert.rejects(write(async()=>{await assert.rejects(captureWrite(await request(),{} as RichMigrationWriteRequestInput,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_INVALID'));}),expected('RICH_MIGRATION_WRITE_INVALID'));
    });
    await check('RC/RW is mandatory without admission/room/lifecycle/commit statements',async()=>{
      for(const begin of ['BEGIN READ ONLY','BEGIN ISOLATION LEVEL REPEATABLE READ','BEGIN ISOLATION LEVEL SERIALIZABLE'])
        await assert.rejects(write(attempt=>transaction(db=>writePhase(db,attempt,async()=>assert.fail()),begin)),expected('PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(write(async attempt=>{const client=await ownClient();try{await writePhase(connection(client),attempt,async()=>assert.fail());}finally{await endClient(client);}}),expected('PRINCIPAL_SCOPE_CHANGED'));
      await write(attempt=>transaction(async(_db,client)=>{
        const commands:string[]=[];const db:SqlConnection={...connection(client),run:async(sql,args)=>{commands.push(sql);return {changes:(await client.query(sql,args)).rowCount??0};}};
        await writePhase(db,attempt,async access=>{await access.assertCurrent();});
        assert(!commands.some(sql=>/^(?:BEGIN|COMMIT|ROLLBACK)|advisory|collaboration_/iu.test(sql)));
      }));
    });
    for(const [name,sql,restore,code,user] of [
      ['session token CAS',"UPDATE session SET token='replaced' WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED','owner'],
      ['session expires',"UPDATE session SET expires_at=1 WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED','owner'],
      ['session revoked',"DELETE FROM session WHERE id='session-owner'",null,'PRINCIPAL_AUTH_REVOKED','owner'],
      ['banned despite past ban expiry',"UPDATE \"user\" SET banned=1,ban_expires=1 WHERE id='owner'","UPDATE \"user\" SET banned=0,ban_expires=NULL WHERE id='owner'",'SEAT_ACCESS_INACTIVE','owner'],
      ['pure Write loss with Read retained',"UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'","UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'",'PRINCIPAL_ACCESS_DENIED','member'],
      ['seat rank changed',"UPDATE team_memberships SET status='active' WHERE id='inactive-seat'; UPDATE organization_user_permissions SET status='active' WHERE user_id='inactive'","UPDATE team_memberships SET status='suspended' WHERE id='inactive-seat'; UPDATE organization_user_permissions SET status='disabled' WHERE user_id='inactive'",'SEAT_LIMIT_EXCEEDED','member'],
    ] as const)await check(`actual fresh ${name} before B admission`,async()=>{
      try{await assert.rejects(write(async attempt=>{await admin.query(sql);await transaction(db=>writePhase(db,attempt,async()=>assert.fail()));},user),expected(code));}
      finally{if(restore)await admin.query(restore);await seedSession(user);}
    });
    await check('same B Write-only revocation is rejected by the final genuine canWrite check',async()=>{
      await assert.rejects(write(attempt=>transaction(async(db,client)=>{
        await writePhase(db,attempt,async access=>{
          assert.equal(access.workspace.permissions.canWrite,true);
          await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        });
      }),'member'),expected('PRINCIPAL_ACCESS_DENIED'));
      assert.equal(Number((await admin.query("SELECT can_write_team_workspace FROM organization_user_permissions WHERE user_id='member'")).rows[0].can_write_team_workspace),1);
    });
    await check('caught same B session invalidation cannot complete a phase',async()=>{
      await assert.rejects(write(attempt=>transaction(async(db,client)=>{
        await writePhase(db,attempt,async access=>{await client.query("UPDATE session SET expires_at=1 WHERE id='session-owner'");
          await assert.rejects(access.assertCurrent(),expected('PRINCIPAL_AUTH_REVOKED'));});
      })),expected('PRINCIPAL_AUTH_REVOKED'));
    });
    await check('same object cannot change backend/XID/schema or raw workspace during phase',async()=>{
      for(const mode of ['backend','xid','schema','workspace'])await assert.rejects(write(attempt=>transaction(async(_db,client)=>{
        const peer=await ownClient();await peer.query('BEGIN');let active=client;
        const db:SqlConnection={get:async(sql,args)=>(await active.query(sql,args)).rows[0],all:async(sql,args)=>(await active.query(sql,args)).rows,
          run:async(sql,args)=>({changes:(await active.query(sql,args)).rowCount??0}),close:()=>assert.fail()};
        try{await writePhase(db,attempt,async access=>{
          if(mode==='backend')active=peer;
          if(mode==='xid'){await client.query('COMMIT');await client.query('BEGIN');}
          if(mode==='schema')await client.query('SET LOCAL search_path=pg_catalog');
          if(mode==='workspace')await client.query('UPDATE canvas_workspaces SET status=$2 WHERE id=$1',[workspaceId,'unexpected']);
          await access.assertCurrent();
        });}finally{await peer.query('ROLLBACK');await endClient(peer);}
      })),expected('PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('simultaneous B calls and detached phases cannot leave authority',async()=>{
      await assert.rejects(write(attempt=>transaction(async db=>{
        await Promise.allSettled([writePhase(db,attempt,async()=>undefined),writePhase(db,attempt,async()=>assert.fail())]);
      })),expected('RICH_MIGRATION_WRITE_REENTRANT'));
      const client=await ownClient();try{
        await assert.rejects(write(async attempt=>{await client.query('BEGIN');void writePhase(connection(client),attempt,async()=>undefined).catch(()=>undefined);}),expected('RICH_MIGRATION_WRITE_DETACHED'));
      }finally{await client.query('ROLLBACK').catch(()=>undefined);await endClient(client);}
    });
    await check('facade getter/function is unavailable after callback even while outer request remains active',async()=>{
      for(const field of ['input','workspace','userId','sessionId','assertCurrent'])await assert.rejects(write(attempt=>transaction(async db=>{
        let retained!:RichMigrationWriteRequestAccess;await writePhase(db,attempt,async access=>{retained=access;});
        assert.throws(()=>Reflect.get(retained,field),expected('RICH_MIGRATION_WRITE_REQUIRED'));
      })),expected('RICH_MIGRATION_WRITE_REQUIRED'));
      await assert.rejects(write(attempt=>transaction(async db=>{
        let retained!:()=>Promise<void>;await writePhase(db,attempt,async access=>{retained=access.assertCurrent;});
        await assert.rejects(retained(),expected('RICH_MIGRATION_WRITE_REQUIRED'));
      })),expected('RICH_MIGRATION_WRITE_REQUIRED'));
    });
    await check('actual outer Principal final SQL window retains poison from closed facade or forged attempt',async()=>{
      for(const attack of ['getter','assert','forged','prior-getter'])await assert.rejects(write(attempt=>transaction(async(_db,client)=>{
        let armed=false,fired=false,retained!:RichMigrationWriteRequestAccess,prior!:RichMigrationWriteRequestAccess,retainedAssert!:()=>Promise<void>;
        const db:SqlConnection={...connection(client),get:async(sql,args)=>{const row=(await client.query(sql,args)).rows[0];
          if(armed&&!fired&&sql.includes('SELECT expires_at FROM')){fired=true;
            if(attack==='getter'||attack==='prior-getter')assert.throws(()=>Reflect.get(attack==='getter'?retained:prior,'workspace'),expected('RICH_MIGRATION_WRITE_REQUIRED'));
            if(attack==='assert')await assert.rejects(retainedAssert(),expected('RICH_MIGRATION_WRITE_REQUIRED'));
            if(attack==='forged')await assert.rejects(writePhase(db,{} as RichMigrationWriteAttempt,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_REQUIRED'));
          }return row;}};
        if(attack==='prior-getter')await writePhase(db,attempt,async access=>{prior=access;});
        try{await writePhase(db,attempt,async access=>{retained=access;retainedAssert=access.assertCurrent;armed=true;});}finally{assert.equal(fired,true);}
      })),expected('RICH_MIGRATION_WRITE_REQUIRED'));
    });
    await check('session expiry introduced only at real outer final SQL rejects returned result',async()=>{
      await assert.rejects(write(attempt=>transaction(async(_db,client)=>{
        let armed=false;const db:SqlConnection={...connection(client),get:async(sql,args)=>{
          if(armed&&sql.includes('SELECT expires_at FROM')){armed=false;await client.query("UPDATE session SET expires_at=1 WHERE id='session-owner'");}
          return (await client.query(sql,args)).rows[0];}};
        await writePhase(db,attempt,async()=>{armed=true;return 'must not escape';});
      })),expected('PRINCIPAL_AUTH_REVOKED'));
    });
    await check('unawaited/current checks and nullish callback errors cannot erase fatal state',async()=>{
      await assert.rejects(write(attempt=>transaction(db=>writePhase(db,attempt,async access=>{void access.assertCurrent().catch(()=>undefined);}))),
        error=>!!error&&typeof error==='object'&&['PRINCIPAL_DETACHED','RICH_MIGRATION_WRITE_REQUIRED'].includes(String(Reflect.get(error,'code'))));
      for(const thrown of [undefined,null]){
        await assert.rejects(write(async()=>{throw thrown;}),expected('RICH_MIGRATION_WRITE_INVALID'));
        await assert.rejects(write(attempt=>transaction(async db=>{await assert.rejects(writePhase(db,attempt,async()=>{throw thrown;}),expected('RICH_MIGRATION_WRITE_INVALID'));})),expected('RICH_MIGRATION_WRITE_INVALID'));
      }
    });
    await check('serial fresh B phases work but callback failure revokes the attempt',async()=>{
      await write(async attempt=>{for(let i=0;i<2;i++)await transaction(db=>writePhase(db,attempt,async access=>{await access.assertCurrent();}));});
      let old!:RichMigrationWriteAttempt;await assert.rejects(write(async attempt=>{old=attempt;throw new Error('Deliberate operation failure');}),/Deliberate operation failure/u);
      await transaction(db=>assert.rejects(writePhase(db,old,async()=>assert.fail()),expected('RICH_MIGRATION_WRITE_REQUIRED')));
    });
    await check('genuine trusted Solo owner still has canWrite and member is denied',async()=>{
      const soloBody=Buffer.from(JSON.stringify({...claims,edition:'solo',seatLimit:1,quotas:{users:1},entitlementsVersion:7})).toString('base64url');
      process.env.CANVAS_LICENSE_CERT=`${header}.${soloBody}.${crypto.sign('RSA-SHA256',Buffer.from(`${header}.${soloBody}`),keys.privateKey).toString('base64url')}`;
      assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT,process.env.CANVAS_INSTANCE_ID!)).ok,true);
      const solo=await getLicenseStatus();assert.equal(solo.licensed,true);assert.equal(solo.edition,'solo');
      await write(attempt=>transaction(db=>writePhase(db,attempt,async access=>assert.equal(access.workspace.permissions.canWrite,true))));
      await assert.rejects(write(async()=>assert.fail(),'member'),expected('PRINCIPAL_AUTH_REVOKED'));
    });
    assert.equal(fetches,0);
    console.log(`Rich migration Write Request PG18: ${cases} actual Cookie/Bearer/Team+Solo authority, B identity, final canWrite, lifetime and revocation families passed; no migration activation.`);
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
  console.error('Owned Rich migration Write Request fixture failed:',{ stage,name:error instanceof Error?error.name:'unknown',
    code:error && typeof error==='object'?Reflect.get(error,'code')??null:null,
    }); process.exitCode=1;
});
