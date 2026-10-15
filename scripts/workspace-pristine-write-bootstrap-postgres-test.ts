import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsPromises, { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  const schema = `write_original_bootstrap_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^write_original_bootstrap_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-write-original-bootstrap-'));
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
    const { persistPristineOriginalWorkspaceFileForWrite: bootstrap, persistPristineOriginalWorkspaceFile: readBootstrap } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { loadCollaborationStateOnConnection,serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { loadCollaborationProjectionStatus } = await import('../app/lib/collaboration/projection-repository');
    const root = path.join(dataRoot,'organizations/principal-org/shared'); await mkdir(root,{recursive:true});
    const request = async (actor='member',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if(cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[actor],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[actor]}`);
      return new NextRequest('http://localhost/api/collaboration/session',{headers});
    };
    type Event = { step:string;backend:number;xid:string|null;isolation:string;readOnly:string;searchPath:string;schema:string;
      lockTimeout:string;transactionTimeout:string;discard?:boolean };
    type Fault = { commit?:'before'|'after';afterCommit?:()=>Promise<void>;afterState?:()=>Promise<void>; afterStateClient?:(client:Client)=>Promise<void>;beforeReceipt?:()=>Promise<void>;
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
            await fault.afterState?.(); await fault.afterStateClient?.(client);
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
    const invoke=async(input:PristineOriginalWorkspaceFileRequest,fault:Fault={},actor='owner',cookie=false)=>{
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
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Write original bootstrap fixture passed: ${name}`);};
    const pristine=async(filePath:string,marker='never_initialized',provider='yjs',version=0,lineage:string|null=null)=>{
      const id=`collab-${crypto.randomUUID()}`;await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
        VALUES($1,$2,'principal-org',$3,'organization',$4,$5,'active',$6,1,1,$7)`,[id,lineage,workspaceId,filePath,provider,version,marker]);return selection(filePath,{kind:'pristine',documentId:id});
    };
    const permission = async (write: boolean) => admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=$1 WHERE organization_id='principal-org' AND user_id='member'", [write ? 1 : 0]);
    const { GET: infoRoute } = await import('../app/api/files/info/route');
    const infoVersion = async (filePath: string, cookie = false): Promise<string> => {
      const authenticated = await request('owner', cookie);
      const response = await infoRoute(new NextRequest(`http://localhost/api/files/info?${new URLSearchParams({ path: filePath })}`,
        { headers: authenticated.headers }));
      assert.equal(response.status, 200);
      const target = (await response.json()).data.metadataTarget;
      assert.equal(target.kind, 'filesystem'); assert.equal(target.entryType, 'file');
      assert.equal(target.workspaceId, workspaceId); assert.equal(target.path, filePath);
      assert.equal(typeof target.fileVersion, 'string'); return target.fileVersion;
    };
    await check('actual Info physical target pins absent/pristine bootstrap and cannot silently adopt an initialized winner', async () => {
      for (const registered of [false, true]) {
        const input = registered ? await pristine('info-pristine.md') : selection('info-absent.md');
        const bytes = Buffer.from('# Exact Info target\n'); await original(input.path, bytes);
        input.expectedFileVersion = await infoVersion(input.path, registered);
        const { result } = await invoke(input, {}, 'owner', registered); await roundtrip(result, bytes);
        const before = await state(result);
        await assert.rejects(bootstrap(await request('owner'), input, factory()), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
        assert.deepEqual((await state(result)).yjsState, before.yjsState);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1', [input.operationId])).rows[0].count, 1);
      }
    });
    await check('stale actual Info fileVersion rejects current replacement bytes before any native birth', async () => {
      const input = selection('stale-info.md'); await original(input.path, '# Before\n');
      input.expectedFileVersion = await infoVersion(input.path);
      await original(input.path, '# A different file version after Info\n');
      const owned = factory();
      await assert.rejects(bootstrap(await request('owner'), input, owned), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
      assert(!owned.events.some(event => ['lineage','registry','state','receipt'].includes(event.step)));
      await empty(input); assert.equal(await readFile(path.join(root,input.path),'utf8'), '# A different file version after Info\n');
    });
    await check('actual descriptor identity rejects a source change after the initial Info CAS observation', async () => {
      const input = selection('descriptor-info.md'); await original(input.path, '# Before descriptor\n');
      input.expectedFileVersion = await infoVersion(input.path);
      // The production descriptor is opened below realpath(workspace.rootPath).
      // macOS /var and /tmp aliases must not bypass this real filesystem race.
      const fullPath = await fsPromises.realpath(path.join(root,input.path)), originalOpen = fsPromises.open;
      let changed = false;
      fsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
        if (!changed && args[0] === fullPath) {
          changed = true; await writeFile(fullPath, '# Changed immediately before actual descriptor open\n');
        }
        return originalOpen(...args);
      }) as typeof fsPromises.open;
      const owned = factory();
      try { await assert.rejects(bootstrap(await request('owner'), input, owned), code('physical-source-changed','physical-scope-changed')); }
      finally { fsPromises.open = originalOpen; }
      assert.equal(changed, true); await empty(input);
      assert(!owned.events.some(event => ['lineage','registry','state','receipt'].includes(event.step)));
      assert.equal(await readFile(fullPath,'utf8'), '# Changed immediately before actual descriptor open\n');
    });
    await check('malformed expected file versions reject before bootstrap connections while omitted version keeps its prior contract', async () => {
      for (const value of [null,1,'','1:2:3','1:2:3:4:5:6','1:2:3:4:NaN','1:2:3:4:5\n','x'.repeat(1025)]) {
        const input = { ...selection('bad-info.md'), expectedFileVersion: value } as unknown as PristineOriginalWorkspaceFileRequest;
        const owned = factory();
        await assert.rejects(bootstrap(await request('owner'), input, owned), code('MARKDOWN_IMPORT_INVALID_INPUT'));
        assert.equal(owned.events.length, 0); await empty(input);
      }
    });
    await check('FIXED canWrite refuses an actual CanRead member before native initialization', async () => {
      const input = selection('read-member.md'); await original(input.path, '# Original\n');
      const owned = factory();
      await assert.rejects(bootstrap(await request('member'), input, owned), code('PRINCIPAL_ACCESS_DENIED'));
      assert.equal(owned.events.length, 0); await empty(input);
      const read = await readBootstrap(await request('member'), input, factory());
      assert.equal(read.disposition, 'applied');
      const before = await state(read);
      await permission(true);
      await assert.rejects(bootstrap(await request('member'), input, factory()), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
      assert.deepEqual((await state(read)).yjsState, before.yjsState);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1', [input.operationId])).rows[0].count, 1);
      await permission(false);
    });
    await check('actual Cookie/Bearer write bootstrap preserves exact path, explicit format and Original bytes', async () => {
      const bytes = Buffer.from('\uFEFF---\r\ntitle: Original\r\n---\r\n\r\n# Heading\r\n\r\nText.\r\n');
      for (const [name, representation, cookie] of [
        [' leading/plain.md', 'plain_text', true], [' leading/xml.markdown', 'tiptap_xml', false],
        [' leading/blocks.md', 'tiptap_blocks', false], [' leading/auto.txt', 'auto', true],
      ] as const) {
        const input = { ...selection(name), initialRepresentation: representation };
        await original(input.path, bytes);
        const { result } = await invoke(input, {}, 'owner', cookie);
        const stored = await roundtrip(result, bytes);
        assert.equal(stored.path, name); assert.equal(stored.representation, representation === 'auto' ? 'plain_text' : representation);
        assert.equal(stored.hasBom, true); assert.equal(stored.newlineStyle, 'crlf');
      }
    });
    await check('genuine write B owns registry, lineage, native state and immutable receipt on one backend/XID', async () => {
      const input = selection('atomic-write.md'); await original(input.path, '# Atomic\n');
      const { result, events } = await invoke(input);
      const writes = events.filter(e => ['lineage', 'registry', 'state', 'receipt'].includes(e.step));
      assert.deepEqual(writes.map(e => e.step), ['lineage', 'registry', 'state', 'receipt']);
      assert.equal(new Set(writes.map(e => e.backend)).size, 1); assert.equal(new Set(writes.map(e => e.xid)).size, 1);
      assert(writes[0].xid, 'native writes need a real assigned transaction');
      assert.notEqual(writes[0].backend, events[0].backend);
      assert(writes.every(e => e.isolation === 'read committed' && e.readOnly === 'off' && e.lockTimeout === '50ms' && e.transactionTimeout === '5s'));
      const rows = (await admin.query(`SELECT xmin::text AS xid FROM collaboration_documents WHERE id=$1
        UNION ALL SELECT xmin::text FROM collaboration_yjs_states WHERE document_id=$1
        UNION ALL SELECT xmin::text FROM file_collaboration_lineages WHERE id=$2
        UNION ALL SELECT xmin::text FROM collaboration_markdown_file_import_receipts WHERE operation_id=$3`,
      [result.receipt.target.documentId, result.receipt.target.lineageId, input.operationId])).rows;
      assert.equal(rows.length, 4); assert(rows.every(row => row.xid === writes[0].xid));
      assert(events.filter(e => e.step === 'close').every(e => events.some(d => d.step === 'disposed' && d.backend === e.backend)));
    });
    await check('write loss after enrollment but before B refuses seed and closes the owner', async () => {
      await permission(true); const input = selection('loss-before-b.md'); await original(input.path, 'Original\n');
      const owned = factory({ beforeB: async () => { await permission(false); } });
      await assert.rejects(bootstrap(await request('member'), input, owned), code('PRINCIPAL_ACCESS_DENIED'));
      await empty(input); assert(owned.events.some(e => e.step === 'disposed'));
      assert(!owned.events.some(e => e.step === 'state')); await permission(false);
    });
    await check('SAME B write downgrade after native INSERT is caught by final genuine ACL and rolls back all writes', async () => {
      await permission(true); const input = selection('loss-in-b.md'); await original(input.path, 'Original\n');
      const owned = factory({ afterStateClient: async client => {
        await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE organization_id='principal-org' AND user_id='member'");
      } });
      await assert.rejects(bootstrap(await request('member'), input, owned), code('PRINCIPAL_ACCESS_DENIED'));
      assert.equal(owned.events.filter(e => e.step === 'state').length, 1);
      const mutationBackend = owned.events.find(e => e.step === 'state')!.backend;
      assert(!owned.events.some(e => e.step === 'commit' && e.backend === mutationBackend));
      assert(owned.events.some(e => e.step === 'rollback' && e.backend === mutationBackend));
      await empty(input); await permission(false);
    });
    await check('actual peer ACL writer is blocked by the genuine write principal held locks', async () => {
      await permission(true); const input = selection('peer-locked.md'); await original(input.path, '# Original\n');
      const owned = factory({ afterState: async () => {
        await admin.query("SET lock_timeout='50ms'");
        try { await assert.rejects(permission(false), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === '55P03'); }
        finally { await admin.query("SET lock_timeout='100ms'"); }
      } });
      const result = await bootstrap(await request('member'), input, owned); assert.equal(result.disposition, 'applied');
      await permission(false);
    });
    await check('lost COMMIT acknowledgement discards B before genuine write confirmation on a fresh C', async () => {
      const input = selection('lost-write.txt'); const bytes = Buffer.from('\uFEFFOriginal\r\n'); await original(input.path, bytes);
      const { result, events } = await invoke(input, { commit: 'after', int8Strings: true });
      assert.equal(result.disposition, 'commit-recovered'); await roundtrip(result, bytes);
      const opens = events.filter(e => e.step === 'open'); assert.equal(opens.length, 3);
      assert.equal(new Set(opens.map(e => e.backend)).size, 3);
      const bClose = events.findIndex(e => e.step === 'disposed' && e.backend === opens[1].backend);
      const cOpen = events.findIndex(e => e.step === 'open' && e.backend === opens[2].backend);
      assert(bClose >= 0 && cOpen > bClose, 'discard B before opening C');
      assert.equal(events.filter(e => e.step === 'state').length, 1);
    });
    await check('fresh recovery C requires current canWrite after actual committed permission loss and never replays', async () => {
      await permission(true); const input = selection('lost-write-revoked.txt'); await original(input.path, 'Original\n');
      const owned = factory({ commit: 'after', afterCommit: async () => { await permission(false); } });
      await assert.rejects(bootstrap(await request('member'), input, owned), code('PRINCIPAL_ACCESS_DENIED'));
      assert.equal(owned.events.filter(e => e.step === 'state').length, 1);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1', [input.operationId])).rows[0].count, 1);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2', [workspaceId, input.path])).rows[0].count, 1);
      assert((await readFile(path.join(root, input.path))).equals(Buffer.from('Original\n')));
    });
    await check('rejected COMMIT leaves no native seed or receipt and is never retried as a new import', async () => {
      const input = selection('commit-rejected.txt'); await original(input.path, 'Original\n');
      const owned = factory({ commit: 'before' }); await assert.rejects(bootstrap(await request('owner'), input, owned), code('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED'));
      await empty(input); assert.equal(owned.events.filter(e => e.step === 'state').length, 1);
    });
    await check('registered pristine writes once; initialized concurrent winner is adopted only by an existing-only caller', async () => {
      const input = await pristine('registered-write.md'); await original(input.path, '# Registered\n');
      const { result } = await invoke(input); assert.equal(result.receipt.target.documentId, input.expectedTarget.kind === 'pristine' ? input.expectedTarget.documentId : 'invalid');
      const before = await state(result);
      await assert.rejects(bootstrap(await request('owner'), selection(input.path), factory()), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
      assert.deepEqual((await state(result)).yjsState, before.yjsState); assert.equal((await state(result)).lifecycleGeneration, 1);
    });
    assert.equal(fetches,0);console.log(`Write Original Bootstrap PG18: ${cases} real Auth/Team/PG/FS matrix families passed; fixed write seed and fresh confirmation; no route activation.`);
  } finally {
    globalThis.fetch=originalFetch;
    try {if(pool)await pool.end();}
    finally {try{for(const client of clients)await client.end();}
      finally {try{if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);}}
        finally{await control.end();await rm(dataRoot,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}}}
  }
}
main().catch(error=>{const actual=error&&typeof error==='object'?Reflect.get(error,'actual'):undefined;
  console.error('Owned Original Bootstrap fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  message:error instanceof Error?error.message:undefined,actual:actual&&typeof actual==='object'?{name:Reflect.get(actual,'name'),code:Reflect.get(actual,'code')??null}:undefined,
  frames:error instanceof Error?error.stack?.split('\n').slice(1).filter(line=>line.includes('/app/lib/')||line.includes('/scripts/')):undefined});process.exitCode=1;});
