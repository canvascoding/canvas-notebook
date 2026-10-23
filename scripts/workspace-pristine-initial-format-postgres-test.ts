import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  const schema = `initial_format_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^initial_format_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-initial-format-'));
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
  const workspaceId = `initial-format-space-${crypto.randomUUID()}`;
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
    const { persistPristineOriginalWorkspaceFile: bootstrap } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { loadCollaborationStateOnConnection,serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { loadCollaborationProjectionStatus } = await import('../app/lib/collaboration/projection-repository');
    const { withWorkspaceRequestPrincipal,withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
    const root = path.join(dataRoot,'organizations/principal-org/shared'); await mkdir(root,{recursive:true});
    const request = async(cookie=false) => {
      const headers = new Headers({'x-canvas-workspace-id':workspaceId});
      if(cookie)headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens.member,process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens.member}`);
      return new NextRequest('http://localhost/api/collaboration/session',{headers});
    };
    const direct=(client:Client):SqlConnection=>({get:async(sql,args)=>(await client.query(sql,args)).rows[0],all:async(sql,args)=>(await client.query(sql,args)).rows,
      run:async(sql,args)=>(await client.query(sql,args)).rows,close:()=>assert.fail('Principal must not close caller-owned connection.')});
    type Format=NonNullable<PristineOriginalWorkspaceFileRequest['initialRepresentation']>;
    type Fault={lostCommit?:boolean;afterCommit?:()=>Promise<void>};
    const factory=(fault:Fault={})=>{
      const events:Array<{step:string;backend:number;discard?:boolean}> = [];let opens=0;
      const openConnection=async():Promise<SqlConnection>=>{
        opens++;const c=await ownClient(true);let closed=false,inserted=false;
        const backend=Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);events.push({step:'open',backend});
        const query=async(sql:string,args:unknown[]=[])=>{
          assert(!closed);if(/^INSERT INTO collaboration_markdown_file_import_receipts/u.test(sql.trimStart()))inserted=true;
          const rows=(await c.query(sql,args)).rows;
          if(/^COMMIT$/iu.test(sql)&&inserted&&fault.lostCommit){delete fault.lostCommit;await fault.afterCommit?.();events.push({step:'lost-commit',backend});throw new Error('Owned lost format COMMIT response.');}
          return rows;
        };
        return{get:async(sql,args)=>(await query(sql,args))[0],all:query,run:query,close:async(error?:Error)=>{if(closed)return;closed=true;
          events.push({step:'close',backend,discard:!!error});await c.end();clients.delete(c);events.push({step:'disposed',backend});}};
      };
      return{openConnection,events,get opens(){return opens;}};
    };
    const selection=(filePath:string,options:Partial<Pick<PristineOriginalWorkspaceFileRequest,'initialRepresentation'|'richFormat'>>={}):PristineOriginalWorkspaceFileRequest=>({
      workspaceId,path:filePath,operationId:crypto.randomUUID(),requestId:crypto.randomUUID(),expectedTarget:{kind:'absent'},...options});
    const original=async(input:PristineOriginalWorkspaceFileRequest,bytes:string|Uint8Array)=>writeFile(path.join(root,input.path),bytes);
    const invoke=async(input:PristineOriginalWorkspaceFileRequest,fault:Fault={},cookie=false)=>{const owned=factory(fault);
      return{result:await bootstrap(await request(cookie),input,owned),owned};};
    const code=(value:string)=>(error:unknown)=>!!error&&typeof error==='object'&&Reflect.get(error,'code')===value;
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Initial format fixture passed: ${name}`);};
    const noSeed=async(input:PristineOriginalWorkspaceFileRequest)=>{
      for(const table of ['collaboration_documents','collaboration_yjs_states','file_collaboration_lineages'])
        assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1 AND path=$2`,[workspaceId,input.path])).rows[0].count,0,table);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,input.operationId])).rows[0].count,0);
    };
    const roundtrip=async(result:MarkdownFileImportResult,bytes:Uint8Array,representation:Exclude<Format,'auto'>)=>{
      assert.equal(result.receipt.target.representation,representation);assert.equal(result.receipt.target.initialSequence,0);assert.equal(result.receipt.target.lifecycleGeneration,1);
      assert.equal(result.receipt.sourceHash,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(result.receipt.sourceBytes,bytes.byteLength);
      const state=await loadCollaborationStateOnConnection(direct(admin),result.receipt.target.documentId,true);assert(state);assert.equal(state.representation,representation);
      const text=inspectPersistedNativeCollaborationSnapshot(state,(doc,snapshot)=>snapshot.content.kind==='plain_text'?snapshot.content.text:richMarkdownFromYDoc(doc));
      assert(Buffer.from(serializeCanonicalText(text,state)).equals(Buffer.from(bytes)));assert((await readFile(path.join(root,state.path))).equals(Buffer.from(bytes)));
      assert.equal(state.checkpointedAt,null);assert.equal(state.canonicalHash,null);assert.equal(state.serializedHash,null);assert.equal((await loadCollaborationProjectionStatus(state)).projectionFinalized,false);
      assert.equal(result.currentObservation.documentSequence,0);assert.equal(result.currentObservation.stateProof,result.receipt.target.initialStateProof);
      assert(!JSON.stringify(result).includes(tokens.member));return state;
    };
    const rich=Buffer.from('# Heading\n\nOriginal **rich** text.\n');
    await check('genuine Cookie/Bearer read-only principal retains canRead bootstrap authority',async()=>{
      for(const cookie of [true,false])await withWorkspaceRequestPrincipal(await request(cookie),{workspaceId,permission:'canRead'},async p=>{
        const c=await ownClient();try{await c.query('BEGIN');await withWorkspaceRequestPrincipalOnConnection(direct(c),p,async access=>{
          assert.equal(access.userId,'member');assert.equal(access.sessionId,'session-member');assert.equal(access.workspace.permissions.canWrite,false);await access.assertCurrent();});}
        finally{await c.query('ROLLBACK');await c.end();clients.delete(c);}
      });
    });
    await check('omitted and explicit Auto preserve default Blocks and XML/Blocks flavor',async()=>{
      for(const [name,options,expected] of [
        ['omitted',{},'tiptap_blocks'],['auto',{initialRepresentation:'auto'},'tiptap_blocks'],
        ['legacy-xml',{richFormat:'tiptap_xml'},'tiptap_xml'],['auto-xml',{initialRepresentation:'auto',richFormat:'tiptap_xml'},'tiptap_xml'],
        ['auto-blocks',{initialRepresentation:'auto',richFormat:'tiptap_blocks'},'tiptap_blocks'],
      ] as const){const input=selection(`${name}.md`,options);await original(input,rich);const{result}=await invoke(input,{},name==='auto-xml');await roundtrip(result,rich,expected);}
    });
    await check('explicit Plain preserves rich-capable Markdown; explicit XML/Blocks stay exact',async()=>{
      for(const format of ['plain_text','tiptap_xml','tiptap_blocks'] as const){const input=selection(`explicit-${format}.md`,{initialRepresentation:format});await original(input,rich);const{result}=await invoke(input);await roundtrip(result,rich,format);}
    });
    await check('explicit Rich Source-only rejection creates no registry/lineage/state/ledger and changes no bytes',async()=>{
      for(const format of ['tiptap_xml','tiptap_blocks'] as const)for(const [name,content]of[['html','<custom>source</custom>\n'],['frontmatter','---\ntitle: [\n---\n\nBody\n']]as const){
        const input=selection(`unsupported-${format}-${name}.md`,{initialRepresentation:format}),bytes=Buffer.from(content);await original(input,bytes);
        await assert.rejects(invoke(input),code('MARKDOWN_IMPORT_RICH_UNAVAILABLE'));await noSeed(input);assert((await readFile(path.join(root,input.path))).equals(bytes));
      }
    });
    await check('Auto XML and Blocks continue exact Source-only fallback to Plain',async()=>{
      for(const richFormat of ['tiptap_xml','tiptap_blocks']as const){const input=selection(`source-auto-${richFormat}.md`,{initialRepresentation:'auto',richFormat}),bytes=Buffer.from('<custom>source</custom>\n');
        await original(input,bytes);const{result}=await invoke(input);await roundtrip(result,bytes,'plain_text');}
    });
    await check('empty seq0 and BOM/CRLF remain exact in every explicit representation',async()=>{
      const profile=Buffer.from('\uFEFF---\r\ntitle: Byte profile\r\n---\r\n\r\n# Heading\r\n');
      for(const format of ['plain_text','tiptap_xml','tiptap_blocks']as const)for(const bytes of [Buffer.alloc(0),profile]){
        const input=selection(`profile-${format}-${bytes.length}.md`,{initialRepresentation:format});await original(input,bytes);const{result}=await invoke(input);const state=await roundtrip(result,bytes,format);
        assert.equal(state.hasBom,bytes.length>0);assert.equal(state.newlineStyle,bytes.length>0?'crlf':'lf');}
    });
    await check('5MiB explicit Plain Markdown and TXT are exact; oversize creates no seed',async()=>{
      const bytes=Buffer.alloc(5*1024*1024,65);
      for(const extension of ['md','txt']as const){const input=selection(`boundary.${extension}`,{initialRepresentation:'plain_text'});await original(input,bytes);const{result}=await invoke(input);await roundtrip(result,bytes,'plain_text');}
      const input=selection('oversized.md',{initialRepresentation:'plain_text'});await original(input,Buffer.alloc(bytes.length+1,65));await assert.rejects(invoke(input),code('source-too-large'));await noSeed(input);
    });
    await check('invalid/contradictory mode options reject before any checkout or accessor evaluation',async()=>{
      const input=selection('invalid-options.md');await original(input,rich);let evaluated=0;
      const getter=selection(input.path);Object.defineProperty(getter,'initialRepresentation',{enumerable:true,get(){evaluated++;return'plain_text';}});
      const nonenumerable=selection(input.path);Object.defineProperty(nonenumerable,'initialRepresentation',{value:'plain_text',enumerable:false});
      const inherited=Object.assign(Object.create({initialRepresentation:'plain_text'}),selection(input.path));
      const unknown=selection(input.path);Reflect.set(unknown,Symbol('mode'),'plain_text');
      const malformed:unknown[]=[getter,nonenumerable,inherited,unknown,
        {...input,initialRepresentation:'unknown'},{...input,initialRepresentation:null},
        {...input,initialRepresentation:'tiptap_xml',richFormat:'tiptap_blocks'},
        {...input,initialRepresentation:'tiptap_xml',richFormat:'tiptap_xml'},
        {...input,initialRepresentation:'plain_text',richFormat:'tiptap_blocks'},
        {...input,path:'invalid.txt',initialRepresentation:'tiptap_xml'},
        {...input,path:'invalid.txt',initialRepresentation:'tiptap_blocks'},
      ];
      for(const value of malformed){const owned=factory();await assert.rejects(bootstrap(await request(),value as PristineOriginalWorkspaceFileRequest,owned),code('MARKDOWN_IMPORT_INVALID_INPUT'));assert.equal(owned.opens,0);}
      assert.equal(evaluated,0);await noSeed(input);assert((await readFile(path.join(root,input.path))).equals(rich));
    });
    await check('new initial mode and original auth request are copied before first await',async()=>{
      const input=selection('copied-mode.md',{initialRepresentation:'plain_text'});await original(input,rich);const actual=await request();const pending=bootstrap(actual,input,factory());
      input.initialRepresentation='tiptap_blocks';input.richFormat='tiptap_xml';actual.headers.set('authorization','Bearer forged');const result=await pending;await roundtrip(result,rich,'plain_text');
    });
    await check('TXT stays Plain for omitted/Auto/explicit Plain and legacy auto flavor',async()=>{
      for(const [name,options]of[['omitted',{}],['auto',{initialRepresentation:'auto'}],['plain',{initialRepresentation:'plain_text'}],['legacy-xml',{richFormat:'tiptap_xml'}]]as const){
        const input=selection(`txt-${name}.txt`,options);await original(input,rich);const{result}=await invoke(input);await roundtrip(result,rich,'plain_text');}
    });
    await check('lost COMMIT recovers exact initial representation/gen/BOM through INT8-string driver',async()=>{
      const bytes=Buffer.from('\uFEFF# Original\r\n');
      for(const format of ['plain_text','tiptap_xml','tiptap_blocks']as const){const input=selection(`recovered-${format}.md`,{initialRepresentation:format});await original(input,bytes);
        const{result,owned}=await invoke(input,{lostCommit:true});assert.equal(result.disposition,'commit-recovered');await roundtrip(result,bytes,format);
        const failed=owned.events.findIndex(e=>e.step==='lost-commit'),disposed=owned.events.findIndex((e,i)=>i>failed&&e.step==='disposed'),opened=owned.events.findIndex((e,i)=>i>disposed&&e.step==='open');
        assert(failed>=0&&disposed>failed&&opened>disposed);assert.notEqual(owned.events[failed].backend,owned.events[opened].backend);
        const receipt=(await admin.query('SELECT private_result FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,input.operationId])).rows[0].private_result;
        assert.deepEqual(receipt,result.receipt);assert.equal(receipt.target.representation,format);assert.equal(receipt.target.lifecycleGeneration,1);
      }
    });
    await check('lost COMMIT never promotes a different representation or generation',async()=>{
      for(const [field,value]of[['representation','tiptap_xml'],['lifecycle_generation',2]]as const){const input=selection(`drift-${field}.md`,{initialRepresentation:'plain_text'});await original(input,rich);
        await assert.rejects(invoke(input,{lostCommit:true,afterCommit:async()=>{await admin.query(`UPDATE collaboration_yjs_states SET ${field}=$1 WHERE workspace_id=$2 AND path=$3`,[value,workspaceId,input.path]);}}),code('MARKDOWN_IMPORT_TARGET_CHANGED'));
        const rows=(await admin.query('SELECT private_result FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,input.operationId])).rows;
        assert.equal(rows.length,1);assert.equal(rows[0].private_result.target.representation,'plain_text');assert.equal(rows[0].private_result.target.lifecycleGeneration,1);assert((await readFile(path.join(root,input.path))).equals(rich));
      }
    });
    assert.equal(fetches,0);console.log(`Pristine Initial Format PG18: ${cases} genuine Auth/Team/native/FS matrix families passed; no session/API activation.`);
  } finally {
    globalThis.fetch=originalFetch;
    try {if(pool)await pool.end();}
    finally{try{for(const client of clients)await client.end();}
      finally{try{if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);}}
        finally{await control.end();await rm(dataRoot,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}}}
  }
}
main().catch(error=>{console.error('Owned Initial Format fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  frames:error instanceof Error?error.stack?.split('\n').slice(1).filter(line=>line.includes('/app/lib/')||line.includes('/scripts/')):undefined});process.exitCode=1;});
