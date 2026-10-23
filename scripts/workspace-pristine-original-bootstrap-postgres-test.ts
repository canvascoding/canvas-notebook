import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client,types } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { PristineOriginalWorkspaceFileRequest, MarkdownFileImportResult } from '../app/lib/collaboration/markdown-file-import-persistence';

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
  const schema = `original_bootstrap_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^original_bootstrap_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-original-bootstrap-'));
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async (int8Strings=false) => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      ...(int8Strings?{types:{getTypeParser:(oid:number,format?:'text'|'binary')=>oid===types.builtins.INT8?(value:string)=>value:types.getTypeParser(oid,format)}}:{}),
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=request-principal-fixture` });
    client.on('error',()=>undefined); // transaction_timeout may terminate this owned fixture client.
    clients.add(client); await client.connect(); return client;
  };
  const workspaceId = `bootstrap-space-${crypto.randomUUID()}`;
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
      VALUES('${workspaceId}','principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`);
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
    const { persistPristineOriginalWorkspaceFile: bootstrap,persistMarkdownFileImport } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { loadCollaborationStateOnConnection,serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot,authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { loadCollaborationProjectionStatus } = await import('../app/lib/collaboration/projection-repository');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { lockIdentity } = await import('../app/lib/collaboration/room-owner');
    const { collaborationAdmissionLockKey,collaborationAdmissionActionDigest } = await import('../app/lib/collaboration/room-admission-contract');
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { installCollaborationRoomInspector } = await import('../app/lib/collaboration/runtime-state');
    const { withWorkspaceFileLifecycleLeases } = await import('../app/lib/collaboration/file-lifecycle-admission-context');
    const { withWorkspaceRequestPrincipal:capture,withWorkspaceRequestPrincipalOnConnection:phase } = await import('../app/lib/workspaces/request-principal');
    const root = path.join(dataRoot,'organizations/principal-org/shared'); await mkdir(root,{recursive:true});
    const request = async (actor='member',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if(cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[actor],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[actor]}`);
      return new NextRequest('http://localhost/api/collaboration/session',{headers});
    };
    type Event = { step:string;backend:number;xid:string|null;isolation:string;readOnly:string;searchPath:string;schema:string;
      lockTimeout:string;transactionTimeout:string;discard?:boolean };
    type Fault = { commit?:'before'|'after';afterCommit?:()=>Promise<void>;afterState?:()=>Promise<void>;beforeReceipt?:()=>Promise<void>;
      beforeB?:()=>Promise<void>;rejectReceipt?:boolean;switchXid?:boolean;loseOwner?:boolean;shadow?:boolean;wrongRealm?:boolean;aliasOwner?:boolean;driftPath?:boolean;
      int8Strings?:boolean;recoveryAliasB?:boolean };
    const factory = (fault:Fault={}) => {
      const events:Event[]=[];let opened=0;let owner:SqlConnection|undefined,retainedMutation:Client|undefined;
      const openConnection = async ():Promise<SqlConnection> => {
        const ordinal=++opened;
        if(ordinal===2) {await fault.beforeB?.();if(fault.aliasOwner)return owner!;}
        if(ordinal===3&&fault.recoveryAliasB){assert(retainedMutation);const c=retainedMutation;
          return{get:async(sql,args)=>(await c.query(sql,args)).rows[0],all:async(sql,args)=>(await c.query(sql,args)).rows,run:async(sql,args)=>(await c.query(sql,args)).rows,
            close:async()=>{await c.end();clients.delete(c);}};}
        const client=await ownClient(fault.int8Strings);let closed=false,inserted=false;
        if(ordinal===2&&fault.wrongRealm)await client.query('SET search_path=pg_catalog');
        const inspect=async()=>{
          const row=(await client.query(`SELECT pg_backend_pid() AS backend,pg_current_xact_id_if_assigned()::text AS xid,
            current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS "readOnly",
            current_setting('search_path') AS "searchPath",current_schema() AS schema,
            current_setting('lock_timeout') AS "lockTimeout",current_setting('transaction_timeout') AS "transactionTimeout"`)).rows[0];
          return row as Omit<Event,'step'>;
        };
        const openedIdentity=await inspect();events.push({...openedIdentity,step:'open'});
        const query=async(sql:string,args:unknown[]=[])=>{
          assert(!closed);const command=sql.trimStart();
          const step=/^(?:INSERT INTO|UPDATE) file_collaboration_lineages\b/u.test(command)?'lineage':/^(?:INSERT INTO|UPDATE) collaboration_documents\b/u.test(command)?'registry'
            :/^INSERT INTO collaboration_yjs_states\b/u.test(command)?'state':/^INSERT INTO collaboration_markdown_file_import_receipts\b/u.test(command)?'receipt'
            :/^SELECT \* FROM collaboration_markdown_file_import_receipts\b/u.test(command)?'retry':/^BEGIN\b/iu.test(command)?'begin':/^COMMIT$/iu.test(command)?'commit'
            :/^ROLLBACK$/iu.test(command)?'rollback':undefined;
          const identity=step==='rollback'?openedIdentity:step?await inspect():undefined;
          if(step==='receipt') {inserted=true;await fault.beforeReceipt?.();}
          if(step==='commit'&&inserted&&fault.commit==='before'){delete fault.commit;events.push({...identity!,step:'commit-failed'});throw new Error('Owned rejected COMMIT');}
          const values=step==='receipt'&&fault.rejectReceipt?args.map((value,index)=>index===3?'x'.repeat(257):value):args;
          const rows=(await client.query(sql,values)).rows;
          if(sql.includes('pg_current_xact_id()::text AS transaction'))events.push({...await inspect(),step:'principal-identity'});
          if(step)events.push({...identity!,step});
          if(step==='begin'&&ordinal===2&&fault.shadow)await client.query('CREATE TEMP TABLE collaboration_documents(id text)');
          if(step==='state'){
            await fault.afterState?.();
            if(fault.switchXid){await client.query('ROLLBACK');await client.query('BEGIN');}
            if(fault.loseOwner)await admin.query('SELECT pg_terminate_backend($1)',[events[0].backend]);
            if(fault.driftPath)await client.query('SET LOCAL search_path=pg_catalog');
          }
          if(step==='commit'&&inserted&&fault.commit==='after'){delete fault.commit;await fault.afterCommit?.();events.push({...identity!,step:'commit-failed'});throw new Error('Owned lost COMMIT response');}
          return rows;
        };
        const db:SqlConnection={get:async(sql,args)=>(await query(sql,args))[0],all:query,run:query,
          close:async(error?:Error)=>{if(closed)return;closed=true;events.push({...openedIdentity,step:'close',discard:!!error});
            if(ordinal===2&&fault.recoveryAliasB){retainedMutation=client;events.push({...openedIdentity,step:'fault-retained-backend'});return;}
            await client.end();clients.delete(client);events.push({...openedIdentity,step:'disposed'});}};
        if(ordinal===1)owner=db;return db;
      };
      return {openConnection,events};
    };
    const direct = (client:Client):SqlConnection => ({get:async(sql,args)=>(await client.query(sql,args)).rows[0],all:async(sql,args)=>(await client.query(sql,args)).rows,
      run:async(sql,args)=>({changes:(await client.query(sql,args)).rowCount??0}),close:()=>assert.fail('Caller connection must remain owned.')});
    const selection=(filePath:string,target:PristineOriginalWorkspaceFileRequest['expectedTarget']={kind:'absent'}):PristineOriginalWorkspaceFileRequest=>({
      workspaceId,path:filePath,operationId:crypto.randomUUID(),requestId:crypto.randomUUID(),expectedTarget:target});
    const original=async(filePath:string,bytes:string|Uint8Array)=>{await mkdir(path.dirname(path.join(root,filePath)),{recursive:true});await writeFile(path.join(root,filePath),bytes);};
    const invoke=async(input:PristineOriginalWorkspaceFileRequest,fault:Fault={},actor='member',cookie=false)=>{
      const owned=factory(fault);return {result:await bootstrap(await request(actor,cookie),input,owned),events:owned.events};
    };
    const state=async(result:MarkdownFileImportResult)=>{const loaded=await loadCollaborationStateOnConnection(direct(admin),result.receipt.target.documentId,true);assert(loaded);return loaded;};
    const roundtrip=async(result:MarkdownFileImportResult,bytes:Uint8Array)=>{
      const stored=await state(result);const canonical=inspectPersistedNativeCollaborationSnapshot(stored,(doc,snapshot)=>snapshot.content.kind==='plain_text'?snapshot.content.text:richMarkdownFromYDoc(doc));
      assert(Buffer.from(serializeCanonicalText(canonical,stored)).equals(Buffer.from(bytes)));
      assert.equal(result.receipt.sourceHash,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(result.receipt.sourceBytes,bytes.byteLength);
      assert.equal(stored.checkpointedAt,null);assert.equal((await loadCollaborationProjectionStatus(stored)).projectionFinalized,false);assert.equal(stored.canonicalHash,null);assert.equal(stored.serializedHash,null);
      assert.equal(result.receipt.checkpointRequired,true);assert(!JSON.stringify(result).includes(tokens.member));
      assert((await readFile(path.join(root,stored.path))).equals(Buffer.from(bytes)));return stored;
    };
    const empty = async(input:PristineOriginalWorkspaceFileRequest)=>{
      for(const table of ['collaboration_documents','collaboration_yjs_states','file_collaboration_lineages'])
        assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1 AND path=$2`,[workspaceId,input.path])).rows[0].count,0,table);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,input.operationId])).rows[0].count,0);
    };
    const code=(...codes:string[])=>(error:unknown)=>!!error&&typeof error==='object'&&codes.includes(String(Reflect.get(error,'code')));
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Original bootstrap fixture passed: ${name}`);};
    const pristine=async(filePath:string,marker='never_initialized',provider='yjs',version=0,lineage:string|null=null)=>{
      const id=`collab-${crypto.randomUUID()}`;await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
        VALUES($1,$2,'principal-org',$3,'organization',$4,$5,'active',$6,1,1,$7)`,[id,lineage,workspaceId,filePath,provider,version,marker]);return selection(filePath,{kind:'pristine',documentId:id});
    };
    await check('genuine read-only member cookie/bearer imports original .md/.txt/.markdown',async()=>{
      const profile=Buffer.from('\uFEFF---\r\ntitle: Original\r\n---\r\n\r\n# Heading\r\n\r\nText.\r\n');
      for(const [extension,cookie]of [['md',true],['txt',false],['markdown',false]]as const){const input=selection(`profile.${extension}`);await original(input.path,profile);
        const {result}=await invoke(input,{},'member',cookie);assert.equal(result.disposition,'applied');const stored=await roundtrip(result,profile);
        assert.equal(stored.representation,extension==='txt'?'plain_text':'tiptap_blocks');assert.equal(stored.hasBom,true);assert.equal(stored.newlineStyle,'crlf');}
    });
    await check('exact XML choice, empty-body metadata and source fallback retain bytes',async()=>{
      for(const [file,body]of [['xml.md','# Heading\n\nBody.\n'],['metadata.md','---\ntitle: Empty body\n---\n'],['source.md','<custom>source</custom>\n']]as const){
        const input={...selection(file),richFormat:'tiptap_xml' as const};const bytes=Buffer.from(body);await original(file,bytes);const {result}=await invoke(input);await roundtrip(result,bytes);
        assert.equal(result.receipt.target.representation,file==='source.md'?'plain_text':'tiptap_xml');}
    });
    await check('native registry/state/new lineage/ledger use SAME B backend/XID',async()=>{
      const input=selection('atomic.md');await original(input.path,'# Atomic\n');const{result,events}=await invoke(input);
      const writes=events.filter(event=>['lineage','registry','state','receipt'].includes(event.step));assert.deepEqual(writes.map(event=>event.step),['lineage','registry','state','receipt']);
      assert.equal(new Set(writes.map(e=>e.backend)).size,1);assert.equal(new Set(writes.map(e=>e.xid)).size,1);assert(writes[0].xid);
      assert(writes.every(e=>e.isolation==='read committed'&&e.readOnly==='off'));assert.notEqual(writes[0].backend,events[0].backend);
      assert(writes.every(e=>e.lockTimeout==='50ms'&&e.transactionTimeout==='5s'));
      const principalEvents=events.filter(e=>e.step==='principal-identity');assert(principalEvents.length>2);
      assert(principalEvents.every(e=>e.searchPath===`${schema}, pg_catalog, pg_temp`&&e.schema===schema));
      const rows=(await admin.query(`SELECT xmin::text AS xid FROM collaboration_documents WHERE id=$1 UNION ALL SELECT xmin::text FROM collaboration_yjs_states WHERE document_id=$1
        UNION ALL SELECT xmin::text FROM file_collaboration_lineages WHERE id=$2 UNION ALL SELECT xmin::text FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$3 AND operation_id=$4`,
      [result.receipt.target.documentId,result.receipt.target.lineageId,workspaceId,input.operationId])).rows;
      assert.equal(rows.length,4);assert(rows.every(row=>row.xid===writes[0].xid));
    });
    await check('registered pristine plus exact unbound legacy lineage preserved without revisions',async()=>{
      const id=`legacy-${crypto.randomUUID()}`,file='legacy.md';await original(file,'Legacy original\n');
      await admin.query(`INSERT INTO file_collaboration_lineages(id,organization_id,workspace_id,workspace_type,path,status,created_at) VALUES($1,'principal-org',$2,'organization',$3,'active',11)`,[id,workspaceId,file]);
      const before=(await admin.query('SELECT to_jsonb(l) AS row FROM file_collaboration_lineages l WHERE id=$1',[id])).rows[0].row;
      const input=await pristine(file,'never_initialized','yjs',0,id);const{result,events}=await invoke(input);assert.equal(result.receipt.target.lineageId,id);
      assert.deepEqual((await admin.query('SELECT to_jsonb(l) AS row FROM file_collaboration_lineages l WHERE id=$1',[id])).rows[0].row,before);
      assert(!events.some(e=>e.step==='lineage'));assert.equal((await admin.query('SELECT count(*)::int AS count FROM file_revisions WHERE lineage_id=$1',[id])).rows[0].count,0);
    });
    await check('nonnull foreign legacy scope and any previous native association conflict',async()=>{
      for(const field of ['customer_id','project_id']as const){const file=`foreign-${field}.txt`,id=`legacy-${crypto.randomUUID()}`;await original(file,'Original\n');
        await admin.query(`INSERT INTO file_collaboration_lineages(id,organization_id,workspace_id,workspace_type,path,status,created_at,${field}) VALUES($1,'principal-org',$2,'organization',$3,'active',11,'foreign')`,[id,workspaceId,file]);
        await assert.rejects(invoke(selection(file)),code('MARKDOWN_IMPORT_TARGET_CHANGED'));
        assert.equal((await admin.query(`SELECT ${field} AS value FROM file_collaboration_lineages WHERE id=$1`,[id])).rows[0].value,'foreign');}
      const file='associated-legacy.txt',id=`legacy-${crypto.randomUUID()}`;await original(file,'Original\n');
      await admin.query(`INSERT INTO file_collaboration_lineages(id,organization_id,workspace_id,workspace_type,path,status,created_at) VALUES($1,'principal-org',$2,'organization',$3,'active',11)`,[id,workspaceId,file]);
      await pristine('previous-native.txt','never_initialized','yjs',0,id);
      await assert.rejects(invoke(selection(file)),code('MARKDOWN_IMPORT_LIFECYCLE_REQUIRED'));
    });
    await check('canonical case and meaningful name spaces remain exact',async()=>{
      const input=selection(' Dir / Note .md');const bytes=Buffer.from('Exact path\n');await original(input.path,bytes);const{result}=await invoke(input);assert.equal(result.receipt.target.path,input.path);await roundtrip(result,bytes);
      await assert.rejects(invoke(selection(' Dir / note .md')));assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',[workspaceId,' Dir / note .md'])).rows[0].count,0);
    });
    await check('two concurrent initializers produce one seed/receipt and loser TargetChanged',async()=>{
      const input=selection('concurrent.txt'),bytes=Buffer.from('Winner original\n');await original(input.path,bytes);
      const attempts=await Promise.allSettled([invoke(input),invoke({...input,operationId:crypto.randomUUID(),requestId:crypto.randomUUID()})]);
      const winner=attempts.find(result=>result.status==='fulfilled'),loser=attempts.find(result=>result.status==='rejected');
      assert(winner?.status==='fulfilled'&&loser?.status==='rejected');assert(code('MARKDOWN_IMPORT_TARGET_CHANGED')(loser.reason));await roundtrip(winner.value.result,bytes);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2',[workspaceId,input.path])).rows[0].count,1);
      assert.equal((await admin.query(`SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND private_result->'target'->>'path'=$2`,[workspaceId,input.path])).rows[0].count,1);
      await assert.rejects(invoke(input),code('MARKDOWN_IMPORT_TARGET_CHANGED'));
      assert.equal((await state(winner.value.result)).documentSequence,0);
    });
    await check('exact 5MiB text boundary remains plain and unchanged',async()=>{
      const input=selection('boundary.txt'),bytes=Buffer.alloc(5*1024*1024,65);await original(input.path,bytes);const{result}=await invoke(input);await roundtrip(result,bytes);assert.equal(result.receipt.target.representation,'plain_text');
    });
    await check('input/request snapshots precede await, unknown selectors never grant',async()=>{
      const input=selection('copied.txt');await original(input.path,'Copied\n');const actual=await request();const pending=bootstrap(actual,input,factory());
      input.path='forged.md';input.workspaceId='foreign';actual.headers.set('authorization','Bearer forged');const result=await pending;assert.equal(result.receipt.target.path,'copied.txt');assert.equal(result.receipt.target.workspaceId,workspaceId);
      for(const invalid of [{...selection('invalid.md'),expectedTarget:{kind:'initialized'}},{...selection('invalid.md'),active:true},{...selection('invalid.docx')},{...selection('../invalid.md')}])
        await assert.rejects(bootstrap(await request(),invalid as PristineOriginalWorkspaceFileRequest,factory()),code('MARKDOWN_IMPORT_INVALID_INPUT'));
    });
    await check('unauthenticated, foreign workspace, banned and revoked current rights reject',async()=>{
      const input=selection('denied.txt');await original(input.path,'Denied\n');
      await assert.rejects(bootstrap(new NextRequest('http://localhost/api/collaboration/session'),input,factory()),code('PRINCIPAL_AUTH_REVOKED'));
      await assert.rejects(invoke({...input,workspaceId:`foreign-${crypto.randomUUID()}`}),code('PRINCIPAL_ACCESS_DENIED','PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(invoke(input,{beforeB:()=>admin.query('UPDATE "user" SET banned=1,ban_expires=1 WHERE id=\'member\'').then(()=>undefined)}),code('SEAT_ACCESS_INACTIVE'));
      await admin.query('UPDATE "user" SET banned=0,ban_expires=NULL WHERE id=\'member\'');await empty(input);
    });
    await check('all providers, invalid pristine marker/version and initialized missing state fail closed',async()=>{
      for(const[marker,provider,version]of[['legacy_unknown','yjs',0],['initialized','yjs',0],['never_initialized','excalidraw',0],['never_initialized','yjs',1]]as const){
        const file=`invalid-${crypto.randomUUID()}.md`;await original(file,'Original\n');const input=await pristine(file,marker,provider,version);
        await assert.rejects(invoke(input));assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE document_id=$1',[input.expectedTarget.kind==='pristine'?input.expectedTarget.documentId:''])).rows[0].count,0);}
      const file='other-provider.md';await original(file,'Original\n');await pristine(file,'never_initialized','excalidraw');await assert.rejects(invoke(selection(file)),code('MARKDOWN_IMPORT_TARGET_CHANGED'));
    });
    await check('state backup/agent history and historical native path cannot become fresh original',async()=>{
      const file='backup.md';await original(file,'Original\n');const input=await pristine(file);assert(input.expectedTarget.kind==='pristine');const id=input.expectedTarget.documentId;
      await admin.query(`INSERT INTO collaboration_yjs_state_backups(backup_id,document_id,lifecycle_generation,schema_version,representation,yjs_state,state_vector,document_sequence,reason,created_at,expires_at)
        VALUES($1,$2,1,1,'plain_text',$3,$4,0,'compaction',1,9999999999999)`,[crypto.randomUUID(),id,Buffer.from([0,0]),Buffer.from([0])]);await assert.rejects(invoke(input));
      const agentFile='agent.md';await original(agentFile,'Original\n');const agent=await pristine(agentFile);assert(agent.expectedTarget.kind==='pristine');
      await admin.query(`INSERT INTO collaboration_agent_operations(operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at)
        VALUES($1,$2,$3,'member','agent-fixture','original-history','synthetic','applied',$4,1,1)`,[crypto.randomUUID(),agent.expectedTarget.documentId,workspaceId,Buffer.from([0])]);await assert.rejects(invoke(agent));
      const archived='archived.txt';await original(archived,'Original\n');const archivedInput=await pristine(archived);assert(archivedInput.expectedTarget.kind==='pristine');await admin.query('UPDATE collaboration_documents SET status=\'archived\' WHERE id=$1',[archivedInput.expectedTarget.documentId]);
      await assert.rejects(invoke(selection(archived)),code('MARKDOWN_IMPORT_LIFECYCLE_REQUIRED'));
    });
    await check('genuine live and ghost room keys deny pristine seed',async()=>{
      const file='ghost.md';await original(file,'Original\n');const input=await pristine(file);assert(input.expectedTarget.kind==='pristine');const id=input.expectedTarget.documentId;
      const release=installCollaborationRoomInspector(doc=>doc===id?1:0);try{await assert.rejects(invoke(input),code('MARKDOWN_IMPORT_BUSY'));}finally{release();}
      const holder=await ownClient();try{await holder.query('SELECT pg_advisory_lock($1::bigint)',[lockIdentity(id).key]);await assert.rejects(invoke(input),code('MARKDOWN_IMPORT_BUSY'));}finally{await holder.end();clients.delete(holder);}
    });
    await check('persisted path reservation and actual exclusive owner are busy',async()=>{
      const file='reserved.md';await original(file,'Original\n');const input=selection(file),owned=factory();const admission=createCollaborationAdmissionService(owned);
      const actionPayloadText=JSON.stringify({originalBootstrapFixture:true});const reservation={requestId:crypto.randomUUID(),actorId:'member',action:'rename' as const,actionPayloadText,
        actionDigest:collaborationAdmissionActionDigest('rename',actionPayloadText),scopes:[{workspaceId,organizationId:'principal-org',path:file,kind:'exact' as const}],expectedDocuments:[]};
      const reserved=await admission.reserve(reservation);try{await assert.rejects(invoke(input));}finally{await admission.cancel(reservation,reserved.revision);}
      const holder=await ownClient();try{await holder.query('SELECT pg_advisory_lock($1::bigint)',[collaborationAdmissionLockKey(workspaceId)]);await assert.rejects(invoke(input));}finally{await holder.end();clients.delete(holder);}
      await empty(input);
    });
    await check('geared inherited lease and matching owner object never mint bootstrap',async()=>{
      const input=selection('inherited.txt');await original(input.path,'Original\n');await assert.rejects(withWorkspaceFileLifecycleLeases(new Map([[workspaceId,{active:true,verify:async()=>true}]]),()=>invoke(input)),code('MARKDOWN_IMPORT_BUSY'));
      await assert.rejects(withWorkspaceFileLifecycleLeases(new Map([[`foreign-${crypto.randomUUID()}`,{active:true,verify:async()=>true}]]),()=>invoke(input)),code('MARKDOWN_IMPORT_BUSY'));
      await assert.rejects(invoke(input,{aliasOwner:true}),code('MARKDOWN_IMPORT_INVALID_INPUT'));await empty(input);
    });
    await check('actual wrong realm/XID switch/owner loss and active searchpath drift rollback',async()=>{
      for(const fault of [{wrongRealm:true},{switchXid:true},{loseOwner:true},{driftPath:true}]){const input=selection(`backend-${crypto.randomUUID()}.txt`);await original(input.path,'Original\n');await assert.rejects(invoke(input,fault));await empty(input);}
    });
    await check('explicit trusted schema precedes pg_temp shadow without reading its fake rows',async()=>{
      const input=selection('shadow-order.txt'),bytes=Buffer.from('Original\n');await original(input.path,bytes);const{result,events}=await invoke(input,{shadow:true});await roundtrip(result,bytes);
      assert(events.filter(e=>e.step==='principal-identity').every(e=>e.schema===schema&&e.searchPath===`${schema}, pg_catalog, pg_temp`));
    });
    await check('symlink, hardlink, oversized source and unsupported UTF8/newlines reject',async()=>{
      const linkInput=selection('symlink.md');await original('target.md','Original\n');await symlink(path.join(root,'target.md'),path.join(root,linkInput.path));await assert.rejects(invoke(linkInput),code('unsafe-physical-source'));await empty(linkInput);
      const hard=selection('hard.md');await link(path.join(root,'target.md'),path.join(root,hard.path));await assert.rejects(invoke(hard),code('unsafe-physical-source'));await empty(hard);
      for(const[bytes,error]of[[Buffer.alloc(5*1024*1024+1,65),'source-too-large'],[Buffer.from([0xff]),'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED'],[Buffer.from('a\r\nb\n'),'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED'],[Buffer.from('a\rb'),'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED']]as const){
        const input=selection(`encoding-${crypto.randomUUID()}.txt`);await original(input.path,bytes);await assert.rejects(invoke(input),code(error));await empty(input);}
    });
    await check('source/ancestor replacement after native write rolls whole transaction back',async()=>{
      for(const ancestor of [false,true]){const input=selection(ancestor?'ancestor/source.txt':'replaced.txt');await original(input.path,'Original\n');
        await assert.rejects(invoke(input,{afterState:async()=>{if(ancestor){await rename(path.join(root,'ancestor'),path.join(root,'old-ancestor'));await mkdir(path.join(root,'ancestor'));await writeFile(path.join(root,input.path),'Original\n');}
          else{await rm(path.join(root,input.path));await writeFile(path.join(root,input.path),'Replacement\n');}}}),code('physical-source-changed','physical-scope-changed'));await empty(input);}
    });
    await check('receipt SQL rejection and pre-COMMIT failure leave no native/lineage/ledger rows',async()=>{
      for(const fault of [{rejectReceipt:true},{commit:'before' as const}]){const input=selection(`rollback-${crypto.randomUUID()}.md`);await original(input.path,'# Rollback\n');await assert.rejects(invoke(input,fault));await empty(input);}
    });
    await check('lost COMMIT disposes B before fresh C; historical receipt differs from current peer state',async()=>{
      const input=selection('recovery.txt'),bytes=Buffer.from('Initial\r\n');await original(input.path,bytes);let peerProof='';
      const{result,events}=await invoke(input,{commit:'after',afterCommit:async()=>{
        const row=(await admin.query('SELECT document_id FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2',[workspaceId,input.path])).rows[0];
        const loaded=await loadCollaborationStateOnConnection(direct(admin),row.document_id,true);assert(loaded);const doc=new Y.Doc();
        try{Y.applyUpdate(doc,loaded.yjsState);doc.getText('content').insert(doc.getText('content').length,'Peer\n');const update=Y.encodeStateAsUpdate(doc),vector=Y.encodeStateVector(doc);const updated={...loaded,yjsState:update,stateVector:vector,documentSequence:1,persistedAt:Date.now()};
          peerProof=authoritativeNativeCollaborationSnapshot(updated).version.stateProof;await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=1,persisted_at=$3 WHERE document_id=$4',[Buffer.from(update),Buffer.from(vector),updated.persistedAt,row.document_id]);
        }finally{doc.destroy();}
        // Recovery confirms receipt/native state; it must not reread source.
        await rm(path.join(root,input.path));
      }});assert.equal(result.disposition,'commit-recovered');assert.equal(result.receipt.target.initialSequence,0);assert.equal(result.currentObservation.documentSequence,1);assert.equal(result.currentObservation.stateProof,peerProof);assert.notEqual(peerProof,result.receipt.target.initialStateProof);
      const failed=events.findIndex(e=>e.step==='commit-failed'),disposed=events.findIndex((e,i)=>i>failed&&e.step==='disposed'),reopened=events.findIndex((e,i)=>i>disposed&&e.step==='open');assert(failed>=0&&disposed>failed&&reopened>disposed);
      const recovery=events.find((e,i)=>i>reopened&&e.step==='retry');assert(recovery&&recovery.backend!==events[failed].backend&&recovery.readOnly==='off'&&recovery.isolation==='read committed');
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1',[input.operationId])).rows[0].count,1);
    });
    await check('fresh recovery rejects revoked actual session; committed ledger remains historical',async()=>{
      const input=selection('revoked-recovery.txt');await original(input.path,'Initial\n');
      try{await assert.rejects(invoke(input,{commit:'after',afterCommit:async()=>{await admin.query('DELETE FROM session WHERE id=\'session-member\'');}}),code('PRINCIPAL_AUTH_REVOKED'));}
      finally{await seedSession('member');}
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1',[input.operationId])).rows[0].count,1);
    });
    await check('fresh C cannot alias discarded B backend through a different SQL wrapper',async()=>{
      const input=selection('alias-recovery.txt');await original(input.path,'Initial\n');const owned=factory({commit:'after',recoveryAliasB:true});
      await assert.rejects(bootstrap(await request(),input,owned),code('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'));
      assert(owned.events.some(event=>event.step==='fault-retained-backend'));assert.equal(owned.events.filter(event=>event.step==='state').length,1);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1',[input.operationId])).rows[0].count,1);
    });
    await check('actual INT8-string driver preserves BOM in recovered current native observation',async()=>{
      const input=selection('string-recovery.txt'),bytes=Buffer.from('\uFEFFOriginal\r\n');await original(input.path,bytes);
      const{result}=await invoke(input,{commit:'after',int8Strings:true});assert.equal(result.disposition,'commit-recovered');assert.equal(result.receipt.target.hasBom,true);await roundtrip(result,bytes);
    });
    await check('unknown native SQL flags/unsafe clocks and zero native sizes reject before recovery promotion',async()=>{
      for(const[field,value]of[['has_bom',2],['degraded',2],['projection_error_permanent',2],['document_sequence','9007199254740992'],['yjs_state',Buffer.alloc(0)],['state_vector',Buffer.alloc(0)]]as const){
        const input=selection(`sql-flag-${field}.txt`);await original(input.path,'Initial\n');
        await assert.rejects(invoke(input,{commit:'after',int8Strings:true,afterCommit:async()=>{await admin.query(`UPDATE collaboration_yjs_states SET ${field}=$1 WHERE workspace_id=$2 AND path=$3`,[value,workspaceId,input.path]);}}),code('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'));
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1',[input.operationId])).rows[0].count,1);
      }
    });
    await check('permanent or malformed projection error cannot disappear in mapper',async()=>{
      for(const patch of [
        "projection_error_permanent=1",
        "projection_error_permanent=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_sequence=0,projection_error_generation=2",
        "projection_error_permanent=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_sequence=0,projection_error_generation=NULL",
        "projection_error_code='',projection_error_sequence=0,projection_error_generation=1",
        "projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_sequence=-1,projection_error_generation=1",
        "projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_sequence=0,projection_error_generation=1,projection_error_phase=repeat('x',257)",
      ]){const input=selection(`projection-${crypto.randomUUID()}.txt`);await original(input.path,'Initial\n');
        await assert.rejects(invoke(input,{commit:'after',int8Strings:true,afterCommit:async()=>{await admin.query(`UPDATE collaboration_yjs_states SET ${patch} WHERE workspace_id=$1 AND path=$2`,[workspaceId,input.path]);}}),code('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'));
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1',[input.operationId])).rows[0].count,1);
      }
    });
    await check('fresh recovery refuses corrupt/quarantined current native state without replay',async()=>{
      for(const corruption of ['bytes','quarantine']as const){const input=selection(`recovery-${corruption}.txt`);await original(input.path,'Initial\n');
        await assert.rejects(invoke(input,{commit:'after',int8Strings:true,afterCommit:async()=>{if(corruption==='bytes')await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE workspace_id=$2 AND path=$3',[Buffer.from([255]),workspaceId,input.path]);
          else await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_phase='validate',projection_error_sequence=0,projection_error_generation=1,projection_error_permanent=1 WHERE workspace_id=$1 AND path=$2",[workspaceId,input.path]);}}));
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1',[input.operationId])).rows[0].count,1);}
    });
    await check('fresh recovery rejects same-binary raw unknown XML attrs and Plain roots',async()=>{
      for(const representation of ['tiptap_xml','plain_text']as const){const input={...selection(`unknown-${representation}.${representation==='plain_text'?'txt':'md'}`),richFormat:'tiptap_xml' as const};await original(input.path,'Original\n');
        await assert.rejects(invoke(input,{commit:'after',afterCommit:async()=>{
          const row=(await admin.query('SELECT document_id FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2',[workspaceId,input.path])).rows[0];
          const loaded=await loadCollaborationStateOnConnection(direct(admin),row.document_id,true);assert(loaded);const doc=new Y.Doc();
          try{Y.applyUpdate(doc,loaded.yjsState);if(representation==='plain_text')doc.getMap('futureRoot').set('unknown','owned-fixture');
            else{const first=doc.getXmlFragment('body').toArray()[0];assert(first instanceof Y.XmlElement);first.setAttribute('futureNativeAttr','owned-fixture');}
            await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=1 WHERE document_id=$3',[Buffer.from(Y.encodeStateAsUpdate(doc)),Buffer.from(Y.encodeStateVector(doc)),row.document_id]);
          }finally{doc.destroy();}
        }}));assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1',[input.operationId])).rows[0].count,1);
      }
    });
    await check('general import still requires canWrite and does not accept txt',async()=>{
      const actual=await request();let workspace!:Parameters<typeof persistMarkdownFileImport>[0]['workspace'];
      await capture(actual,{permission:'canRead',workspaceId},async p=>{const c=await ownClient();await c.query('BEGIN');try{await phase(direct(c),p,async access=>{workspace=structuredClone(access.workspace);});}finally{await c.query('ROLLBACK');await c.end();clients.delete(c);}});
      assert.equal(workspace.permissions.canWrite,false);
      await assert.rejects(persistMarkdownFileImport({workspace,path:'generic.md',operationId:crypto.randomUUID(),requestId:crypto.randomUUID(),actorUserId:'member',actorSessionId:'session-member',bytes:Buffer.from('# Generic\n'),expectedTarget:{kind:'absent'},validateAuthority:async()=>undefined},factory()),error=>!!error&&typeof error==='object'&&Reflect.get(error,'status')===403);
      await capture(await request('owner'),{permission:'canWrite',workspaceId},async p=>{const c=await ownClient();await c.query('BEGIN');try{await phase(direct(c),p,async access=>{workspace=structuredClone(access.workspace);});}finally{await c.query('ROLLBACK');await c.end();clients.delete(c);}});
      await assert.rejects(persistMarkdownFileImport({workspace,path:'generic.txt',operationId:crypto.randomUUID(),requestId:crypto.randomUUID(),actorUserId:'owner',actorSessionId:'session-owner',bytes:Buffer.from('Generic\n'),expectedTarget:{kind:'absent'},validateAuthority:async()=>undefined},factory()),code('MARKDOWN_IMPORT_INVALID_INPUT'));
    });
    assert.equal(fetches,0);console.log(`Pristine Original Bootstrap PG18: ${cases} real Auth/Team/PG/FS matrix families passed; no session/API activation.`);
  } finally {
    globalThis.fetch=originalFetch;
    try {if(pool)await pool.end();}
    finally {try{for(const client of clients)await client.end();}
      finally {try{if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);}}
        finally{await control.end();await rm(dataRoot,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}}}
  }
}
main().catch(error=>{console.error('Owned Original Bootstrap fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  frames:error instanceof Error?error.stack?.split('\n').slice(1).filter(line=>line.includes('/app/lib/')||line.includes('/scripts/')):undefined});process.exitCode=1;});
