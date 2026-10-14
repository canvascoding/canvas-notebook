import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, type Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';

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
  const schema = `rich_mutation_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^rich_mutation_[a-f0-9]{32}$/u);
  const workspaceId = `rich-write-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-rich-migration-domain-'));
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=request-principal-fixture` });
    client.on('error',()=>undefined); // transaction_timeout may terminate this owned fixture client.
    clients.add(client); await client.connect(); return client;
  };
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
    const request = async (userId='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if (cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[userId],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/collaboration/session?path=note.md',{ headers });
    };
    {
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createPlainTextYDoc, createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { collaborationUpdateStateProof } = await import('../app/lib/collaboration/state-proof');
    const { advanceAuthenticatedRichRepresentationMigration: advance,
      changeAuthenticatedCollaborationRepresentation: legacy } = await import('../app/lib/collaboration/representation-migration');
    const { installRichMigrationRuntime,noteRichMigrationWorkerSuccess } = await import('../app/lib/collaboration/representation-migration-runtime');
    const { captureRichMigrationHttpRequest,readAuthenticatedRichMigrationNative,createAuthenticatedRichMigrationDomain } =
      await import('../app/lib/collaboration/rich-migration-domain');
    const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
    const { openDb } = await import('../app/lib/db');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { withWorkspaceFileLifecycleLeases } = await import('../app/lib/collaboration/file-lifecycle-admission-context');
    const stopRuntime=installRichMigrationRuntime(()=>0);
    await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
    type Seed = { documentId:string;lineageId:string;path:string;migration:{requestId:string;expectedDocumentId:string;
      expectedLifecycleGeneration:number;documentSequence:number;stateProof:string} };
    const seed=async(label:string,representation:'plain_text'|'tiptap_xml'='plain_text',markdown='# Native title\n\nFirst **bold** text.\n'):Promise<Seed>=>{
      const documentId=`migration-${crypto.randomUUID()}`,lineageId=`lineage-${crypto.randomUUID()}`,filePath=`${label}-${crypto.randomUUID()}.md`;
      const doc=representation==='plain_text'?createPlainTextYDoc(markdown):createRichMarkdownYDoc(markdown);
      const update=Buffer.from(Y.encodeStateAsUpdate(doc)),vector=Buffer.from(Y.encodeStateVector(doc));doc.destroy();
      const hash=crypto.createHash('sha256').update(markdown).digest('hex'),now=Date.now();
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','principal-org',$3,'active',$4)`,[lineageId,workspaceId,filePath,now]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,status,
        state_version,yjs_state_lifecycle,created_at,updated_at) VALUES($1,$2,$3,'organization','principal-org',$4,'yjs','active',0,'initialized',$5,$5)`,
      [documentId,lineageId,workspaceId,filePath,now]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
        schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,canonical_hash,serialized_hash,
        newline_style,has_bom,degraded,status) VALUES($1,$2,'principal-org',$3,$4,1,1,$5,$6,1,$7,$7,1,$8,$8,'lf',0,0,'active')`,
      [documentId,workspaceId,filePath,representation,update,vector,now,hash]);
      await admin.query(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,revision_id,
        canonical_hash,serialized_hash,finalized,updated_at) VALUES($1,1,1,$2,$3,$3,1,$4)`,[documentId,`revision-${documentId}`,hash,now]);
      const root=path.join(dataRoot,'organizations/principal-org/shared');await mkdir(root,{recursive:true});await writeFile(path.join(root,filePath),markdown);
      return {documentId,lineageId,path:filePath,migration:{requestId:crypto.randomUUID(),expectedDocumentId:documentId,
        expectedLifecycleGeneration:1,documentSequence:1,stateProof:collaborationUpdateStateProof(update,Y)!}};
    };
    const fingerprint=async(s:Seed)=>JSON.stringify((await admin.query(`SELECT representation,lifecycle_generation,document_sequence,
      encode(yjs_state,'hex') AS binary,encode(state_vector,'hex') AS vector FROM collaboration_yjs_states WHERE document_id=$1`,[s.documentId])).rows[0]);
    const backups=async(s:Seed)=>Number((await admin.query('SELECT count(*) AS n FROM collaboration_yjs_state_backups WHERE document_id=$1',[s.documentId])).rows[0].n);
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Authenticated migration mutation passed: ${name}`);};
    const modern=async(s:Seed,user='owner',cookie=false,cancel=false)=>{noteRichMigrationWorkerSuccess();return advance({request:await request(user,cookie),workspaceId,path:s.path,migration:s.migration,cancel});};
    const old=async(s:Seed,user='owner',representation:'tiptap_xml'|'tiptap_blocks'='tiptap_blocks')=>legacy({request:await request(user),workspaceId,
      path:s.path,expectedLifecycleGeneration:1,representation});
    const actualPool=runtime as unknown as Pool,originalConnect=actualPool.connect.bind(actualPool);
    let before:((client:PoolClient,sql:string,values:unknown[])=>Promise<void>)|undefined;
    let after:((client:PoolClient,sql:string,values:unknown[])=>Promise<void>)|undefined;
    let realmOverride:string|undefined;
    const clientRealms=new WeakMap<PoolClient,string>();
    const wrapped=new WeakSet<PoolClient>();
    const patchClient=(client:PoolClient)=>{
      if(wrapped.has(client))return client;wrapped.add(client);
      const query=client.query.bind(client);
      client.query=(async(...args:unknown[])=>{
        const selectedRealm=realmOverride??schema;
        if(clientRealms.get(client)!==selectedRealm){await query(`SET search_path="${selectedRealm}",pg_catalog`);clientRealms.set(client,selectedRealm);}
        const sql=typeof args[0]==='string'?args[0]:String((args[0] as {text?:unknown})?.text??'');
        const values=Array.isArray(args[1])?args[1]:[];
        if(before)await before(client,sql,values);
        const result=await (query as (...args:unknown[])=>Promise<unknown>)(...args);
        if(after)await after(client,sql,values);
        return result;
      }) as PoolClient['query'];
      return client;
    };
    actualPool.connect=((callback?: (error:Error|undefined,client:PoolClient|undefined,release:()=>void)=>void)=>{
      if(callback)return originalConnect((error,client,release)=>callback(error,client&&patchClient(client),release));
      return originalConnect().then(patchClient);
    }) as Pool['connect'];
    try{
      await check('orphan permanent quarantine is rejected before mapping or any native mutation',async()=>{
        const s=await seed('orphan-quarantine'),original=await fingerprint(s);
        await admin.query('UPDATE collaboration_yjs_states SET projection_error_permanent=1 WHERE document_id=$1',[s.documentId]);
        await assert.rejects(modern(s).then(async result=>{
          console.log('Unexpected accepted raw orphan quarantine:',{generation:result.state.lifecycleGeneration,status:result.migration.status,backups:await backups(s)});
          return result;
        }));
        assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
      });
      const rawInvalidTuples:Array<[string,Record<string,string|number|null>]>=[
        ['future-error-generation',{projection_error_code:'future',projection_error_sequence:1,projection_error_generation:2,projection_error_permanent:1}],
        ['future-error-sequence',{projection_error_code:'future',projection_error_sequence:2,projection_error_generation:1}],
        ['stale-permanent-generation',{lifecycle_generation:2,projection_error_code:'stale',projection_error_sequence:1,projection_error_generation:1,projection_error_permanent:1}],
        ['orphan-error-sequence',{projection_error_sequence:0}],
        ['orphan-error-generation',{projection_error_generation:1}],
        ['orphan-error-phase',{projection_error_phase:'materialize'}],
        ['empty-error-code',{projection_error_code:'',projection_error_sequence:1,projection_error_generation:1}],
        ['invalid-error-phase',{projection_error_code:'invalid',projection_error_sequence:1,projection_error_generation:1,projection_error_phase:'x'.repeat(257)}],
        ['invalid-permanent-flag',{projection_error_permanent:2}],
        ['invalid-bom-flag',{has_bom:2}],
        ['invalid-degraded-flag',{degraded:2}],
        ['checkpoint-ahead',{checkpoint_sequence:2}],
        ['negative-document-clock',{document_sequence:-1}],
        ['negative-checkpoint-clock',{checkpoint_sequence:-1}],
        ['negative-persisted-clock',{persisted_at:-1}],
        ['negative-checkpointed-clock',{checkpointed_at:-1}],
        ['unsafe-document-clock',{document_sequence:'9007199254740992'}],
        ['unsafe-persisted-clock',{persisted_at:'9007199254740992'}],
        ['zero-generation',{lifecycle_generation:0}],
      ];
      for(const [name,tuple] of rawInvalidTuples)await check(`actual raw ${name} is rejected in discovery/current and both entries`,async()=>{
        const s=await seed(`raw-${name}`),actual=captureRichMigrationHttpRequest(await request(),workspaceId,s.path);
        const native=await readAuthenticatedRichMigrationNative(actual,workspaceId,s.path);
        const domain=createAuthenticatedRichMigrationDomain(actual,{workspaceId,path:s.path,migration:s.migration,action:'advance'},native);
        const columns=Object.keys(tuple);for(const column of columns)assert.match(column,/^[a-z_]+$/u);
        await admin.query(`UPDATE collaboration_yjs_states SET ${columns.map((column,index)=>`${column}=$${index+2}`).join(',')} WHERE document_id=$1`,
          [s.documentId,...columns.map(column=>tuple[column])]);
        const original=await fingerprint(s);
        const invalid=(error:unknown)=>!!error&&typeof error==='object'&&Reflect.get(error,'code')==='ADMISSION_SCOPE_CHANGED';
        await assert.rejects(readAuthenticatedRichMigrationNative(actual,workspaceId,s.path),invalid);
        await assert.rejects(domain.read(),invalid);await assert.rejects(modern(s),invalid);await assert.rejects(old(s),invalid);
        assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
      });
      await check('actual invalid newline profile is rejected before mapper normalization',async()=>{
        const s=await seed('raw-newline'),original=await fingerprint(s);
        const constraints=(await admin.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid='collaboration_yjs_states'::regclass AND contype='c'`)).rows as Array<{conname:string;definition:string}>;
        const constraint=constraints.find(row=>row.definition.includes('newline_style'));assert(constraint);assert.match(constraint.conname,/^[a-z_]+$/u);
        await admin.query(`ALTER TABLE collaboration_yjs_states DROP CONSTRAINT "${constraint.conname}"`);
        try{await admin.query("UPDATE collaboration_yjs_states SET newline_style='invalid' WHERE document_id=$1",[s.documentId]);
          await assert.rejects(modern(s));await assert.rejects(old(s));assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
        }finally{await admin.query("UPDATE collaboration_yjs_states SET newline_style='lf' WHERE document_id=$1",[s.documentId]);
          await admin.query(`ALTER TABLE collaboration_yjs_states ADD CONSTRAINT "${constraint.conname}" ${constraint.definition}`);}
      });
      for(const kind of ['modern','legacy'] as const)await check(`actual ${kind} preflight-to-mapper row corruption is rejected before writes`,async()=>{
        const s=await seed(`mapper-row-${kind}`),original=await fingerprint(s);let fired=false;
        after=async(_client,sql,values)=>{if(sql.includes('SELECT octet_length(yjs_state) AS bytes')&&values[0]===s.documentId){
          after=undefined;fired=true;await admin.query('UPDATE collaboration_yjs_states SET projection_error_permanent=1 WHERE document_id=$1',[s.documentId]);
        }};
        try{await assert.rejects(kind==='modern'?modern(s):old(s));assert(fired);assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);}
        finally{after=undefined;}
      });
      for(const kind of ['modern','legacy'] as const)await check(`actual ${kind} final raw corruption rolls back all native and backup writes`,async()=>{
        const s=await seed(`raw-final-${kind}`),original=await fingerprint(s);let fired=false;
        after=async(client,sql,values)=>{if(sql.includes('UPDATE collaboration_yjs_states')&&values.includes(s.documentId)){
          after=undefined;fired=true;await client.query('UPDATE collaboration_yjs_states SET projection_error_permanent=1 WHERE document_id=$1',[s.documentId]);
        }};
        try{if(kind==='modern')assert.equal((await modern(s)).migration.status,'pending');else await assert.rejects(old(s));
          assert(fired);assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
          if(kind==='modern')assert.equal((await admin.query('SELECT outcome_text FROM collaboration_admission_requests WHERE request_id=$1',[s.migration.requestId])).rows[0].outcome_text,null);
        }finally{after=undefined;}
      });
      for(const reader of ['discovery','current'] as const)for(const change of ['acl','root','token'] as const)
        await check(`actual ${reader} read-COMMIT loss after ${change} change fails closed after B disposal`,async()=>{
          const s=await seed(`read-loss-${reader}-${change}`),original=await fingerprint(s),actual=captureRichMigrationHttpRequest(await request('member'),workspaceId,s.path);
          const native=reader==='current'?await readAuthenticatedRichMigrationNative(actual,workspaceId,s.path):undefined;
          const domain=native?createAuthenticatedRichMigrationDomain(actual,{workspaceId,path:s.path,migration:s.migration,action:'advance'},native):undefined;
          let armedBackend=0,lost=false,postLossQueries=0;
          before=async()=>{if(lost)postLossQueries++;};
          after=async(client,sql,values)=>{
            if(sql.includes('FROM collaboration_documents d FULL JOIN')&&values[1]===s.path)armedBackend=Number(Reflect.get(client,'processID'));
            if(sql==='COMMIT'&&armedBackend===Number(Reflect.get(client,'processID'))){
              after=undefined;lost=true;
              if(change==='acl')await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
              if(change==='root')await admin.query('UPDATE canvas_workspaces SET root_relative_path=$2 WHERE id=$1',[workspaceId,`organizations/principal-org/lost-${crypto.randomUUID()}`]);
              if(change==='token')await admin.query("UPDATE session SET token='rotated-before-recovery' WHERE id='session-member'");
              throw new Error('Lost genuine read COMMIT response after actual PostgreSQL COMMIT');
            }
          };
          try{await assert.rejects(domain?domain.read():readAuthenticatedRichMigrationNative(actual,workspaceId,s.path),
            error=>!!error&&typeof error==='object'&&Reflect.get(error,'code')==='ADMISSION_RECOVERY_REQUIRED');
            assert(lost);assert.equal(postLossQueries,0,'fail-closed read opens no C and publishes no cached current grant');
            let remaining=1;for(let i=0;i<40&&remaining;i++){remaining=Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE pid=$1',[armedBackend])).rows[0].n);
              if(remaining)await new Promise(resolve=>setTimeout(resolve,10));}
            assert.equal(remaining,0,'uncertain B backend is actually gone before caller can continue');
            assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
          }finally{before=undefined;after=undefined;await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
            await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared' WHERE id=$1",[workspaceId]);await seedSession('member');}
        });
      await check('original actual Workspace root cannot change between discovery and mutation',async()=>{
        const s=await seed('root-origin','plain_text','* one\n* two\n'),original=await fingerprint(s);let armed=false,fired=false;
        const changedRoot=`organizations/principal-org/changed-${crypto.randomUUID()}`;
        await mkdir(path.join(dataRoot,changedRoot),{recursive:true});
        after=async(_client,sql,values)=>{
          if(sql.includes('FROM collaboration_documents d FULL JOIN')&&values[1]===s.path)armed=true;
          if(sql==='COMMIT'&&armed){after=undefined;fired=true;await admin.query('UPDATE canvas_workspaces SET root_relative_path=$2 WHERE id=$1',[workspaceId,changedRoot]);}
        };
        try{await assert.rejects(modern(s).then(async result=>{
          console.log('Unexpected accepted cross-phase root drift:',{generation:result.state.lifecycleGeneration,status:result.migration.status,
            backups:await backups(s),oldRootBytesChanged:(await readFile(path.join(dataRoot,'organizations/principal-org/shared',s.path),'utf8'))!=='* one\n* two\n'});
          return result;
        }));assert(fired);assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
          assert.equal(await readFile(path.join(dataRoot,'organizations/principal-org/shared',s.path),'utf8'),'* one\n* two\n');}
        finally{after=undefined;await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared' WHERE id=$1",[workspaceId]);}
      });
      await check('actual Root drift after preprojection freshness cannot create a stale Root write',async()=>{
        const s=await seed('late-projection-origin','plain_text','* one\n* two\n');let armedBackend=0,fired=false,bytesAtSwitch='';
        const oldFile=path.join(dataRoot,'organizations/principal-org/shared',s.path);
        after=async(client,sql,values)=>{
          if(!armedBackend&&sql.includes('FROM collaboration_documents d FULL JOIN')&&values[1]===s.path
            &&Number((await admin.query('SELECT lifecycle_generation FROM collaboration_yjs_states WHERE document_id=$1',[s.documentId])).rows[0].lifecycle_generation)===2){
            armedBackend=Number(Reflect.get(client,'processID'));
          }
          if(sql==='COMMIT'&&armedBackend===Number(Reflect.get(client,'processID'))){
            after=undefined;fired=true;bytesAtSwitch=await readFile(oldFile,'utf8');
            await admin.query('UPDATE canvas_workspaces SET root_relative_path=$2 WHERE id=$1',[workspaceId,`organizations/principal-org/late-${crypto.randomUUID()}`]);
          }
        };
        try{await modern(s).catch(()=>undefined);assert(fired);const afterBytes=await readFile(oldFile,'utf8');
          if(afterBytes!==bytesAtSwitch)console.log('Unexpected stale post-freshness Root write:',{nativeGeneration:2,rootChangedBeforeWrite:true});
          assert.equal(afterBytes,bytesAtSwitch,'no file write after the protected Root scope is released');
        }finally{after=undefined;await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared' WHERE id=$1",[workspaceId]);}
      });
      await check('copied real Auth and Native rows in another actual schema cannot change the original realm',async()=>{
        const s=await seed('realm-origin'),original=await fingerprint(s),mirror=`${schema}_mirror`;let armed=false,fired=false;
        assert.match(mirror,/^rich_mutation_[a-f0-9]{32}_mirror$/u);
        await admin.query(`CREATE SCHEMA "${mirror}"`);
        try{
          const tables=(await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows as Array<{tablename:string}>;
          for(const {tablename} of tables){assert.match(tablename,/^[a-zA-Z_][a-zA-Z0-9_]*$/u);await admin.query(`CREATE TABLE "${mirror}"."${tablename}" (LIKE "${schema}"."${tablename}" INCLUDING ALL)`);}
          for(const {tablename} of tables){
            const columns=(await admin.query(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
              AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`,[`"${schema}"."${tablename}"`])).rows as Array<{attname:string}>;
            const names=columns.map(({attname})=>{assert.match(attname,/^[a-zA-Z_][a-zA-Z0-9_]*$/u);return `"${attname}"`;}).join(',');
            await admin.query(`INSERT INTO "${mirror}"."${tablename}" (${names}) OVERRIDING SYSTEM VALUE SELECT ${names} FROM "${schema}"."${tablename}"`);
          }
          // LIKE omits FKs. Recreate the real validated/enforced same-realm
          // constraints so genuine Principal auth succeeds in the copied realm.
          const foreignKeys=(await admin.query(`SELECT child.relname AS child,c.conname,pg_get_constraintdef(c.oid,true) AS definition
            FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid
            WHERE c.contype='f' AND child.relnamespace=$1::regnamespace`,[schema])).rows as Array<{child:string;conname:string;definition:string}>;
          await admin.query(`SET search_path="${mirror}",pg_catalog`);
          try{for(const fk of foreignKeys){assert.match(fk.child,/^[a-zA-Z_][a-zA-Z0-9_]*$/u);assert.match(fk.conname,/^[a-zA-Z_][a-zA-Z0-9_]*$/u);
            const definition=fk.definition.replaceAll(`"${schema}".`,`"${mirror}".`).replaceAll(`${schema}.`,`"${mirror}".`);
            await admin.query(`ALTER TABLE "${mirror}"."${fk.child}" ADD CONSTRAINT "${fk.conname}" ${definition}`);
          }}finally{await admin.query(`SET search_path="${schema}",pg_catalog`);}
          after=async(_client,sql,values)=>{
            if(sql.includes('FROM collaboration_documents d FULL JOIN')&&values[1]===s.path)armed=true;
            if(sql==='COMMIT'&&armed){after=undefined;fired=true;realmOverride=mirror;}
          };
          await assert.rejects(modern(s),error=>!!error&&typeof error==='object'&&Reflect.get(error,'code')==='ADMISSION_SCOPE_CHANGED');
          assert(fired);assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
          assert.equal(Number((await admin.query(`SELECT count(*) AS n FROM "${mirror}".collaboration_yjs_state_backups WHERE document_id=$1`,[s.documentId])).rows[0].n),0);
        }finally{after=undefined;realmOverride=undefined;assert.equal((await actualPool.query('SELECT current_schema() AS schema')).rows[0].schema,schema);await admin.query(`DROP SCHEMA "${mirror}" CASCADE`);}
      });
      await check('actual immutable Workspace owner cannot change across fresh phases',async()=>{
        const s=await seed('owner-origin'),original=await fingerprint(s);let armed=false,fired=false;
        after=async(_client,sql,values)=>{if(sql.includes('FROM collaboration_documents d FULL JOIN')&&values[1]===s.path)armed=true;
          if(sql==='COMMIT'&&armed){after=undefined;fired=true;await admin.query("UPDATE canvas_workspaces SET owner_user_id='member' WHERE id=$1",[workspaceId]);}};
        try{await assert.rejects(modern(s));assert(fired);assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);}
        finally{after=undefined;await admin.query('UPDATE canvas_workspaces SET owner_user_id=NULL WHERE id=$1',[workspaceId]);}
      });
      for(const kind of ['modern','legacy'] as const)await check(`actual ${kind} post-COMMIT Root drift cannot publish the old Root`,async()=>{
        const s=await seed(`projection-origin-${kind}`,'plain_text','* one\n* two\n');let armed=false,fired=false,projected=false;
        after=async(_client,sql,values)=>{
          if(sql.includes('UPDATE collaboration_yjs_states')&&values.includes(s.documentId))armed=true;
          if(sql==='COMMIT'&&armed){after=undefined;fired=true;await admin.query('UPDATE canvas_workspaces SET root_relative_path=$2 WHERE id=$1',[workspaceId,`organizations/principal-org/later-${crypto.randomUUID()}`]);}
        };
        try{
          if(kind==='modern')await assert.rejects(modern(s));
          else await assert.rejects(legacy({request:await request(),workspaceId,path:s.path,expectedLifecycleGeneration:1,representation:'tiptap_xml',
            normalizeSafeMarkdown:true,checkpoint:{materialize:async({state})=>{projected=true;return state;}}}));
          assert(fired);assert.equal(projected,false);assert.equal(await backups(s),1,'already accepted native COMMIT remains durable');
          const row=(await admin.query('SELECT lifecycle_generation,document_sequence,checkpoint_sequence FROM collaboration_yjs_states WHERE document_id=$1',[s.documentId])).rows[0];
          assert.equal(Number(row.lifecycle_generation),2);assert.equal(Number(row.document_sequence),2);assert.equal(Number(row.checkpoint_sequence),1);
          assert.equal(await readFile(path.join(dataRoot,'organizations/principal-org/shared',s.path),'utf8'),'* one\n* two\n');
        }finally{after=undefined;await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared' WHERE id=$1",[workspaceId]);}
      });
      for(const cookie of [false,true])await check(`actual ${cookie?'Cookie':'Bearer'} modern whole mutation and terminal retry`,async()=>{
        const s=await seed('modern');const result=await modern(s,'member',cookie);
        assert.equal(result.state.representation,'tiptap_blocks');assert.equal(result.state.lifecycleGeneration,2);
        assert.equal(await backups(s),1);const terminal=(await admin.query('SELECT status,outcome_text FROM collaboration_admission_requests WHERE request_id=$1',[s.migration.requestId])).rows[0];
        assert.equal(terminal.status,'committed');assert.equal(JSON.parse(terminal.outcome_text).version,1);
        const beforeRetry=await fingerprint(s);await modern(s,'member',cookie);assert.equal(await fingerprint(s),beforeRetry);assert.equal(await backups(s),1);
      });
      for(const representation of ['tiptap_xml','tiptap_blocks'] as const)await check(`legacy epoch-zero target ${representation}`,async()=>{
        const s=await seed('legacy');const result=await old(s,'member',representation);
        assert.equal(result.representation,representation);assert.equal(result.lifecycleGeneration,2);assert.equal(await backups(s),1);
      });
      await check('legacy XML-to-block tree preserves native data',async()=>{
        const s=await seed('legacy-xml','tiptap_xml');const result=await old(s);assert.equal(result.representation,'tiptap_blocks');assert.equal(await backups(s),1);
      });
      await check('legacy safe normalization projects only after confirmed native COMMIT',async()=>{
        const s=await seed('normalize','plain_text','* one\n* two\n'),actual=await request();let projected=false;
        const {materializeCollaborationCheckpoint}=await import('../app/lib/collaboration/checkpoint');
        const result=await legacy({request:actual,workspaceId,path:s.path,expectedLifecycleGeneration:1,representation:'tiptap_xml',
          normalizeSafeMarkdown:true,checkpoint:{materialize:async({state,workspace})=>{
            projected=true;assert.equal(state.lifecycleGeneration,2);assert.equal(await backups(s),1,'native COMMIT precedes projection');
            return (await materializeCollaborationCheckpoint({state,workspace,actorType:'user',actorUserId:'owner'})).state;
          }}});
        assert(projected);assert.equal(result.lifecycleGeneration,2);assert.equal(result.documentSequence,result.checkpointSequence);
        assert.equal(await readFile(path.join(dataRoot,'organizations/principal-org/shared',s.path),'utf8'),'- one\n- two\n');
      });
      await check('legacy projection failure preserves committed native lifecycle and pending journal gap',async()=>{
        const s=await seed('normalize-failure','plain_text','* one\n* two\n');let fired=false;
        await assert.rejects(legacy({request:await request(),workspaceId,path:s.path,expectedLifecycleGeneration:1,representation:'tiptap_xml',
          normalizeSafeMarkdown:true,checkpoint:{materialize:async()=>{fired=true;throw new Error('Owned projection failure after COMMIT');}}}),
        error=>!!error&&typeof error==='object'&&Reflect.get(error,'code')==='checkpoint_failed');
        assert(fired);const current=(await admin.query('SELECT lifecycle_generation,document_sequence,checkpoint_sequence FROM collaboration_yjs_states WHERE document_id=$1',[s.documentId])).rows[0];
        assert.equal(Number(current.lifecycle_generation),2);assert.equal(Number(current.document_sequence),2);assert.equal(Number(current.checkpoint_sequence),1);assert.equal(await backups(s),1);
      });
      await check('current Read without Write is denied by both actual entries',async()=>{
        const s=await seed('read-only'),original=await fingerprint(s);
        try{await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
          await assert.rejects(modern(s,'member'));await assert.rejects(old(s,'member'));
        }finally{await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");}
        assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
      });
      await check('initial private Request and command snapshot cannot drift across awaits',async()=>{
        const s=await seed('snapshot'),actual=await request('member'),migration={...s.migration};noteRichMigrationWorkerSuccess();
        const running=advance({request:actual,workspaceId,path:s.path,migration});actual.headers.set('authorization','Bearer forged');
        actual.headers.set('x-canvas-workspace-id','foreign');migration.expectedDocumentId='foreign';migration.stateProof=`yjs-snapshot-sha256-v1:${'f'.repeat(64)}`;
        assert.equal((await running).state.representation,'tiptap_blocks');
      });
      await check('actual current active Lineage and initialized Registry are mandatory',async()=>{
        for(const kind of ['lineage','marker','organization']){
          const s=await seed('scope'),original=await fingerprint(s);
          if(kind==='lineage')await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=$2 WHERE id=$1",[s.lineageId,Date.now()]);
          if(kind==='marker')await admin.query("UPDATE collaboration_documents SET yjs_state_lifecycle='legacy_unknown' WHERE id=$1",[s.documentId]);
          if(kind==='organization')await admin.query("UPDATE collaboration_documents SET organization_id=NULL WHERE id=$1",[s.documentId]);
          await assert.rejects(modern(s));assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
        }
      });
      await check('final genuine canWrite rolls back DA04 native, backup, target and LastOutcome writes',async()=>{
        const s=await seed('final-write'),original=await fingerprint(s);let fired=false,checkedLock=false;
        before=async(client,sql,values)=>{
          if(sql.includes("UPDATE collaboration_admission_requests SET status = 'committed'")&&values[0]===s.migration.requestId){
            before=undefined;fired=true;assert.equal((await client.query("SHOW lock_timeout")).rows[0].lock_timeout,'50ms');checkedLock=true;
            await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
          }
        };
        const result=await modern(s,'member');before=undefined;assert(fired&&checkedLock,'actual DA04 final window reached');
        assert.equal(result.migration.status,'pending');assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
        const row=(await admin.query('SELECT status,outcome_text FROM collaboration_admission_requests WHERE request_id=$1',[s.migration.requestId])).rows[0];
        assert.equal(row.status,'draining');assert.equal(row.outcome_text,null);
        assert.equal(Number((await admin.query("SELECT can_write_team_workspace FROM organization_user_permissions WHERE user_id='member'")).rows[0].can_write_team_workspace),1);
      });
      await check('legacy entire write rolls back on final Write-only loss',async()=>{
        const s=await seed('legacy-final'),original=await fingerprint(s);let fired=false;
        after=async(client,sql,values)=>{if(sql.includes('UPDATE collaboration_yjs_states')&&values.includes(s.documentId)){
          after=undefined;fired=true;assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout,'50ms');
          await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        }};
        await assert.rejects(old(s,'member'));after=undefined;assert(fired);assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
      });
      await check('actual same-B Registry drift after Native write rolls back complete DA04',async()=>{
        const s=await seed('registry-final'),original=await fingerprint(s);let fired=false;
        after=async(client,sql,values)=>{if(sql.includes("SET representation = 'tiptap_blocks'")&&values.includes(s.documentId)){
          after=undefined;fired=true;await client.query("UPDATE collaboration_documents SET organization_id=NULL WHERE id=$1",[s.documentId]);
        }};
        const result=await modern(s);after=undefined;assert(fired);assert.equal(result.migration.status,'pending');assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
      });
      await check('actual cancellation tombstone and delayed same-ID retry do not write native data',async()=>{
        const s=await seed('cancel'),original=await fingerprint(s);const result=await modern(s,'owner',false,true);
        assert.equal(result.migration.reason,'cancelled');assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
        await modern(s);assert.equal(await fingerprint(s),original);assert.equal((await admin.query('SELECT status FROM collaboration_admission_requests WHERE request_id=$1',[s.migration.requestId])).rows[0].status,'cancelled');
      });
      for(const point of ['reserve','proof','cancel','prepare'] as const)await check(`whole actual ${point} B rolls back on final Write loss`,async()=>{
        const s=await seed(`phase-${point}`),original=await fingerprint(s);let fired=false;
        before=async(client,sql,values)=>{
          const matches=point==='reserve'?sql.includes('INSERT INTO collaboration_admission_requests')&&values[0]===s.migration.requestId
            :point==='proof'?sql.includes("UPDATE collaboration_admission_targets SET status = 'released'")&&values[0]===s.migration.requestId
            :point==='cancel'?sql.includes("SET active = false, status = 'cancelled'")&&values[0]===s.migration.requestId
            :sql.includes('SELECT status FROM collaboration_agent_operations')&&values[0]===s.documentId;
          if(matches){before=undefined;fired=true;assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout,'50ms');
            await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");}
        };
        const result=await modern(s,'member',false,point==='cancel');before=undefined;assert(fired,`actual ${point} SQL reached`);
        assert.equal(result.migration.status,'pending');assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
        const header=(await admin.query('SELECT status,outcome_text FROM collaboration_admission_requests WHERE request_id=$1',[s.migration.requestId])).rows[0];
        if(point==='reserve')assert.equal(header,undefined);else{assert(header);assert.equal(header.outcome_text,null);assert.notEqual(header.status,'committed');
          // A failed, unstarted DA03 may retain the existing separately freshly
          // authorized CAS cancellation. That phase changes no native bytes.
          if(point!=='proof')assert.notEqual(header.status,'cancelled');}
      });
      await check('fresh C rejects revoked auth after a verified terminal read without changing committed native bytes',async()=>{
        const s=await seed('terminal-revoked');await modern(s);const original=await fingerprint(s);let fired=false;
        after=async(_client,sql,values)=>{if(sql.includes('SELECT * FROM collaboration_admission_requests')&&values[0]===s.migration.requestId){
          after=undefined;fired=true;await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        }};
        try{await assert.rejects(modern(s,'member'));assert(fired);assert.equal(await fingerprint(s),original);assert.equal(await backups(s),1);}
        finally{after=undefined;await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");}
      });
      await check('legacy actual owner epoch remains guarded even after normal release',async()=>{
        const s=await seed('legacy-owner'),original=await fingerprint(s),client=await ownClient();
        const {createCollaborationRoomOwnerSession}=await import('../app/lib/collaboration/room-owner');
        const owner=await createCollaborationRoomOwnerSession(client);
        try{const fence=await owner.acquire({documentId:s.documentId,workspaceId,organizationId:'principal-org',path:s.path,
          representation:'plain_text',lifecycleGeneration:1,schemaVersion:1});
          await assert.rejects(old(s));await owner.release(fence);await assert.rejects(old(s));
          assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
        }finally{await owner.close();clients.delete(client);}
      });
      await check('actual successful COMMIT reply loss recovers once only after destroyed B',async()=>{
        const s=await seed('lost-commit');let commitBackend=0,armed=false,lost=false,disposalProved=false;
        after=async(client,sql,values)=>{
          if(sql.includes("UPDATE collaboration_admission_requests SET status = 'committed'")&&values[0]===s.migration.requestId){armed=true;commitBackend=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);}
          if(sql==='COMMIT'&&armed){after=undefined;armed=false;lost=true;throw new Error('Lost actual successful migration COMMIT reply');}
        };
        before=async(_client,sql)=>{if(lost&&sql.includes('SELECT * FROM collaboration_admission_requests')){
          const row=(await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE pid=$1',[commitBackend])).rows[0];
          assert.equal(Number(row.n),0,'uncertain mutation backend destroyed before fresh recovery');disposalProved=true;
        }};
        const result=await modern(s);before=undefined;after=undefined;assert(lost&&disposalProved);assert.equal(result.state.lifecycleGeneration,2);assert.equal(await backups(s),1);
        await modern(s);assert.equal(await backups(s),1);
      });
      await check('actual rejected COMMIT retains pending admission and never invents migrated state',async()=>{
        const s=await seed('rejected-commit'),original=await fingerprint(s);let armed=false,rejected=false;
        after=async(_client,sql,values)=>{if(sql.includes("UPDATE collaboration_admission_requests SET status = 'committed'")&&values[0]===s.migration.requestId)armed=true;};
        before=async(_client,sql)=>{if(sql==='COMMIT'&&armed){before=undefined;after=undefined;armed=false;rejected=true;throw new Error('Rejected mutation COMMIT before PostgreSQL');}};
        const result=await modern(s);before=undefined;after=undefined;assert(rejected);assert.equal(result.migration.status,'pending');assert.equal(await fingerprint(s),original);assert.equal(await backups(s),0);
      });
      await check('current canonical moved-path terminal replay uses fresh genuine authority',async()=>{
        const s=await seed('moved');await modern(s);const newPath=`moved-${crypto.randomUUID()}.txt`;
        await admin.query('UPDATE collaboration_documents SET path=$2 WHERE id=$1',[s.documentId,newPath]);
        await admin.query('UPDATE file_collaboration_lineages SET path=$2 WHERE id=$1',[s.lineageId,newPath]);
        await admin.query('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',[s.documentId,newPath]);
        const result=await modern({...s,path:newPath});assert.equal(result.state.path,newPath);assert.equal(result.state.lifecycleGeneration,2);assert.equal(await backups(s),1);
      });
      await check('new strict B cannot borrow a shaped ALS lease or foreign admission holder',async()=>{
        const s=await seed('foreign-lock'),actual=captureRichMigrationHttpRequest(await request(),workspaceId,s.path);
        const native=await readAuthenticatedRichMigrationNative(actual,workspaceId,s.path);
        const domain=createAuthenticatedRichMigrationDomain(actual,{workspaceId,path:s.path,migration:s.migration,action:'advance'},native);
        const foreign=await ownClient();try{await foreign.query('SELECT pg_advisory_lock($1::bigint)',[collaborationAdmissionLockKey(workspaceId)]);
          await assert.rejects(withWorkspaceFileLifecycleLeases(new Map([[workspaceId,{active:true,verify:async()=>true}]]),()=>
            executeLifecycleTransaction({openConnection:openDb,execute:db=>domain.withMutationTransaction(db,async()=>assert.fail('foreign owner must block')),recoverCommitted:async()=>assert.fail('no uncertain commit')})));
        }finally{await foreign.end();clients.delete(foreign);}
      });
      assert.equal(fetches,0);
      console.log(`Authenticated migration domain PG18: ${cases} actual native mutation/auth-final/cancel/terminal/COMMIT-recovery families passed.`);
    }finally{before=undefined;after=undefined;actualPool.connect=originalConnect;stopRuntime();}
    }
  } finally {
    globalThis.fetch=originalFetch;
    try { if(pool) await pool.end(); }
    finally {
      try { for(const client of clients) await client.end(); }
      finally {
        try { if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);} }
        finally {await control.end();await rm(dataRoot,{recursive:true,force:true});
          for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}
      }
    }
  }
}
main().catch(error=>{console.error('Owned authenticated migration fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,message:error instanceof Error?error.message:'unknown'});process.exitCode=1;});
