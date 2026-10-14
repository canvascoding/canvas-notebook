import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, type Pool } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceRequestPrincipal } from '../app/lib/workspaces/request-principal';
import type { ExistingNativeCollaborationSession, ExistingNativeSessionIdentity } from '../app/lib/collaboration/native-session-state-reader';
import type { PristineOriginalRequestScopeExpectation } from '../app/lib/collaboration/markdown-file-import-persistence';

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
  const schema = `authenticated_http_session_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^authenticated_http_session_[a-f0-9]{32}$/u);
  const workspaceId = `native-auth-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-auth-native-http-'));
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
      CANVAS_TEST_NATIVE_TEXT_SESSION:'1',CANVAS_LICENSE_RUNTIME_ENVIRONMENT:'production',CANVAS_LICENSE_CONTROL_PLANE_URL:'https://control.example.test' });
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
    const { withWorkspaceRequestPrincipal:capture } = await import('../app/lib/workspaces/request-principal');
    const { withAuthenticatedExistingNativeCollaborationSessionOnConnection:readSession,
      assertExistingNativeCollaborationSessionCurrentOnConnection:current } = await import('../app/lib/collaboration/native-session-state-reader');
    const { createPlainTextYDoc,createRichMarkdownYDoc,validateRichMarkdownYDoc,richMarkdownSchemaExtensions } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const { getSchema } = await import('@tiptap/core');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
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
    const check=async(name:string,operation:()=>Promise<void>)=>{if(process.argv[2]&&!name.includes(process.argv[2]))return;stage=name;await operation();cases++;console.log(`Authenticated native HTTP session passed: ${name}`);};
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
    const { POST: webPost } = await import('../app/api/files/collaboration/session/route');
    const { POST: mobilePost } = await import('../app/api/mobile/v1/notebook/collaboration/session/route');
    const { createAuthenticatedTextCollaborationSessionGrant: createGrant, withAuthenticatedTextCollaborationSessionGrant: publishGrant } = await import('../app/lib/collaboration/authenticated-text-session-service');
    const { withAuthenticatedNativeSessionDiagnosisOnConnection: readDiagnosis, assertReadOnlyNativeSessionDiagnosisCurrentOnConnection: diagnosisCurrent } = await import('../app/lib/collaboration/native-session-state-reader');
    const { withAuthenticatedNativeSessionTransportOnConnection: transportPhase, disposeAuthenticatedNativeSessionTransport: disposeTransport } = await import('../app/lib/collaboration/authenticated-native-session-transport');
    const { consumeMobileCollaborationTicket, disposeMobileCollaborationTickets } = await import('../app/lib/mobile/collaboration-ticket');
    const { parseCollaborationSessionRequest } = await import('../app/lib/collaboration/session-service');
    const capabilities = { richTextSchemaVersion: 3, blockTreeFormatVersion: 1 };
    const root = path.join(dataRoot, 'organizations/principal-org/shared'); await mkdir(root, { recursive: true });
    const original = async (file: string, body: string | Uint8Array) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), body); };
    type Surface = 'web' | 'mobile';
    const post = async (surface: Surface, file: string, extra: Record<string, unknown> = {}, userId = 'owner', cookie = false) => {
      const actual = await request(userId, cookie), headers = new Headers(actual.headers); headers.set('content-type', 'application/json');
      const body = { path: file, ...capabilities, ...(surface === 'web' ? { provider: 'yjs', representation: 'auto' } : {}), ...extra };
      const http = new NextRequest(`http://localhost/api/${surface === 'web' ? 'files' : 'mobile/v1/notebook'}/collaboration/session`, { method: 'POST', headers, body: JSON.stringify(body) });
      const response = await (surface === 'web' ? webPost : mobilePost)(http);
      const wire = await response.json() as Record<string, unknown>;
      if (surface === 'mobile' && response.status === 200 && typeof wire.token === 'string') {
        const adopted = consumeMobileCollaborationTicket(wire.token); assert(adopted); assert(adopted.authenticatedTransport, 'actual native POST must adopt original transport');
        assert.equal(adopted.claims.documentId, wire.documentId); assert.equal(adopted.claims.permission, wire.permission);
        assert.equal(consumeMobileCollaborationTicket(String(wire.token)), null, 'ticket is single-use');
        await disposeTransport(adopted.authenticatedTransport);
      }
      return { status: response.status, headers: response.headers, wire };
    };
    const sessionInput = async (target: { identity: ExistingNativeSessionIdentity }, permission: 'read' | 'write' = 'write', userId = 'owner') => {
      const requested = parseCollaborationSessionRequest({ path: target.identity.path, provider: 'yjs', representation: 'auto', ...capabilities }); assert(requested && requested.provider === 'yjs');
      return { request: await request(userId), workspaceId, sessionRequest: requested, permission };
    };
    await check('real exported Web/Mobile POSTs authenticate Cookie/Bearer and open native Plain/XML/Blocks including seq0 without any file', async () => {
      for (const surface of ['web', 'mobile'] as const) for (const cookie of [true, false]) for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) for (const empty of [false, true]) {
        const target = await seed(`${surface}-${representation}-${cookie}-${empty}`, representation, { empty, profile: true }); const before = await stored(target.identity);
        const response = await post(surface, target.identity.path, {}, empty ? 'member' : 'owner', cookie);
        assert.equal(response.status, 200, JSON.stringify({ surface, representation, empty, code: response.wire.code, error: response.wire.error }));
        assert.equal(response.wire.documentId, target.identity.documentId); assert.equal(response.wire.representation, representation);
        assert.equal(response.wire.permission, empty ? 'read' : 'write'); assert.equal(response.wire.stateProof, target.proof);
        assert.equal(response.wire.stateVector, target.vector.toString('base64')); assert.equal(response.wire.documentSequence, empty ? 0 : 7);
        assert.equal(response.wire.projectionFinalized, false); assert.equal(response.wire.success, true);
        assert(response.headers.get('cache-control')?.includes('no-store')); assert.equal(typeof response.wire.token, 'string');
        assert(!/yjsState|canonicalHash|serializedHash|frontmatter|transport|tokenHash|authorization|cookie/u.test(JSON.stringify(response.wire)));
        assert(!JSON.stringify(response.wire).includes(tokens.owner)); assert.deepEqual(await stored(target.identity), before);
      }
    });
    await check('stale/source-only projection cannot override native representation or proof', async () => {
      const target = await seed('stale-source', 'tiptap_blocks'); await original(target.identity.path, '<custom>stale source</custom>\n');
      const before = await stored(target.identity);
      for (const surface of ['web', 'mobile'] as const) { const result = await post(surface, target.identity.path); assert.equal(result.status, 200); assert.equal(result.wire.representation, 'tiptap_blocks'); assert.equal(result.wire.stateProof, target.proof); }
      assert.deepEqual(await stored(target.identity), before); assert.equal(await readFile(path.join(root, target.identity.path), 'utf8'), '<custom>stale source</custom>\n');
    });
    await check('legal nonexportable colwidth remains native through both actual POSTs', async () => {
      const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| value |', 'tiptap_blocks');
      try { const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
        for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
        assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
        const target = await seed('unexportable', 'tiptap_blocks', { doc }), before = await stored(target.identity);
        for (const surface of ['web', 'mobile'] as const) { const result = await post(surface, target.identity.path); assert.equal(result.status, 200); assert.equal(result.wire.stateProof, target.proof); }
        assert.deepEqual(await stored(target.identity), before);
      } finally { doc.destroy(); }
    });
    await check('real XML tombstones and frontmatter-only metadata retain their binary identity', async () => {
      const deleted = createRichMarkdownYDoc('Delete this body', 'tiptap_xml'); deleted.getXmlFragment('body').delete(0, deleted.getXmlFragment('body').length);
      const metadata = createRichMarkdownYDoc('---\ntitle: Retained\n---\n\n', 'tiptap_xml');
      try { for (const [name, doc] of [['deleted', deleted], ['metadata', metadata]] as const) {
        const target = await seed(name, 'tiptap_xml', { doc, profile: true }), before = await stored(target.identity);
        const response = await post('web', target.identity.path); assert.equal(response.status, 200); assert.equal(response.wire.stateProof, target.proof); assert.deepEqual(await stored(target.identity), before);
      } } finally { deleted.destroy(); metadata.destroy(); }
    });
    await check('real manual original file and explicit modes seed once under genuine write and preserve BOM/CRLF', async () => {
      const body = Buffer.from('\uFEFF# Imported\r\n\r\nBody.\r\n');
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
        const file = ` leading/${representation}.markdown`; await original(file, body);
        const response = await post('web', file, { representation }); assert.equal(response.status, 200); assert.equal(response.wire.representation, representation);
        const row = (await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [response.wire.documentId])).rows[0];
        assert.equal(row.path, file); assert.equal(Number(row.document_sequence), 0); assert.equal(Number(row.has_bom), 1); assert.equal(row.newline_style, 'crlf');
        assert.equal(Number(row.checkpoint_sequence), 0); assert.equal(row.checkpointed_at, null); assert.equal(response.wire.projectionFinalized, false);
        assert((await readFile(path.join(root, file))).equals(body));
        const again = await post('mobile', file); assert.equal(again.status, 200); assert.equal(again.wire.documentId, response.wire.documentId);
        assert.deepEqual((await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [response.wire.documentId])).rows[0], row);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE private_result->\'target\'->>\'documentId\'=$1', [response.wire.documentId])).rows[0].count, 1);
      }
    });
    await check('Auto Source-only fallback and TXT stay plain; explicit Rich unsupported source produces no seed', async () => {
      for (const [surface, file] of [['web', 'source.md'], ['mobile', 'source.markdown'], ['mobile', 'text.txt']] as const) {
        await original(file, '<custom>Original</custom>\n'); const response = await post(surface, file); assert.equal(response.status, 200); assert.equal(response.wire.representation, 'plain_text');
      }
      await original('explicit-source.md', '<custom>Original</custom>\n');
      const denied = await post('web', 'explicit-source.md', { representation: 'tiptap_blocks' }); assert.equal(denied.status, 409); assert.equal(denied.wire.code, 'source_representation_required');
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [workspaceId, 'explicit-source.md'])).rows[0].count, 0);
    });
    await check('read-only original file cannot seed; caller write flags cannot grant a genuine CanRead actor', async () => {
      await original('read-original.md', '# Original\n'); const denied = await post('mobile', 'read-original.md', {}, 'member');
      assert.equal(denied.status, 409); assert.equal(denied.wire.code, 'NATIVE_SESSION_INITIALIZATION_REQUIRED'); assert.equal(Object.hasOwn(denied.wire, 'token'), false);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [workspaceId, 'read-original.md'])).rows[0].count, 0);
      const native = await seed('cannot-promote'); await assert.rejects(createGrant(await sessionInput(native, 'write', 'member')), code('PRINCIPAL_ACCESS_DENIED'));
    });
    await check('historically initialized missing state cannot fall back to original or reseed', async () => {
      const target = await seed('missing-state'); await admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId]); await original(target.identity.path, '# Replacement\n');
      const before = (await admin.query('SELECT * FROM collaboration_documents WHERE id=$1', [target.identity.documentId])).rows[0];
      const result = await post('web', target.identity.path); assert.equal(result.status, 409); assert.equal(Object.hasOwn(result.wire, 'token'), false);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId])).rows[0].count, 0);
      assert.deepEqual((await admin.query('SELECT * FROM collaboration_documents WHERE id=$1', [target.identity.documentId])).rows[0], before);
    });
    await check('actual concurrent original open has exactly one seed/receipt and both adopt native winner', async () => {
      const file = 'concurrent.md'; await original(file, '# Concurrent\n');
      const results = await Promise.all([post('web', file), post('mobile', file)]);
      // An admission contender may be Busy. It must never overwrite the winner.
      assert(results.some(result => result.status === 200)); assert(results.every(result => [200, 409].includes(result.status)));
      const rows = (await admin.query('SELECT document_id FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2', [workspaceId, file])).rows;
      assert.equal(rows.length, 1); const again = await post('web', file); assert.equal(again.status, 200); assert.equal(again.wire.documentId, rows[0].document_id);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND private_result->\'target\'->>\'path\'=$2', [workspaceId, file])).rows[0].count, 1);
    });
    await check('nonpermanent projection error remains editable and visible; equal zero clocks never certify projection', async () => {
      const target = await seed('projection-error', 'plain_text', { empty: true });
      await admin.query("UPDATE collaboration_yjs_states SET projection_error_code='roundtrip_unstable',projection_error_phase='codec',projection_error_sequence=0,projection_error_generation=1,projection_error_permanent=0 WHERE document_id=$1", [target.identity.documentId]);
      for (const surface of ['web', 'mobile'] as const) { const result = await post(surface, target.identity.path); assert.equal(result.status, 200); assert.equal(result.wire.permission, 'write'); assert.equal(result.wire.projectionFinalized, false); assert.equal((result.wire.projectionError as { permanent: boolean }).permanent, false); }
    });
    await check('actual finalized checkpoint receipt is required and registry lag or unfinished receipt never claims publication', async () => {
      const target = await seed('receipt-positive');
      const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
      const access = await requireRequestWorkspace(await request(), { workspaceId, permissions: 'canWrite' }); assert(!access.response);
      const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
      const { materializeCollaborationCheckpoint } = await import('../app/lib/collaboration/checkpoint');
      const state = await loadCollaborationStateOnConnection(connection(admin), target.identity.documentId, true); assert(state);
      await materializeCollaborationCheckpoint({ state, workspace: access.workspace, actorType: 'system' });
      assert.equal(await readFile(path.join(root, target.identity.path), 'utf8'), 'ABC');
      const healthy = await post('web', target.identity.path); assert.equal(healthy.status, 200); assert.equal(healthy.wire.projectionFinalized, true);
      await admin.query('UPDATE collaboration_file_projections SET finalized=0 WHERE document_id=$1', [target.identity.documentId]);
      const pending = await post('mobile', target.identity.path); assert.equal(pending.status, 200); assert.equal(pending.wire.projectionFinalized, false);
      await admin.query('UPDATE collaboration_file_projections SET finalized=1 WHERE document_id=$1', [target.identity.documentId]);
      await admin.query('UPDATE collaboration_documents SET state_version=0 WHERE id=$1', [target.identity.documentId]);
      const lag = await post('web', target.identity.path); assert.equal(lag.status, 200); assert.equal(lag.wire.projectionFinalized, false);
    });
    await check('permanent valid native quarantine produces only separate read diagnosis through both actual POSTs', async () => {
      const target = await seed('quarantine'); await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_ROUNDTRIP_UNSTABLE',projection_error_phase='codec',projection_error_sequence=7,projection_error_generation=1,projection_error_permanent=1 WHERE document_id=$1", [target.identity.documentId]);
      const before = await stored(target.identity);
      for (const surface of ['web', 'mobile'] as const) { const result = await post(surface, target.identity.path); assert.equal(result.status, 200, JSON.stringify({status:result.status,code:result.wire.code,error:result.wire.error})); assert.equal(result.wire.permission, 'read'); assert.equal(result.wire.degraded, true); assert.equal((result.wire.projectionError as { permanent: boolean }).permanent, true); }
      assert.deepEqual(await stored(target.identity), before);
      await assert.rejects(captured(p => transaction(db => readSession(db, p, input(target.identity), async () => assert.fail('normal editing reader cannot borrow diagnosis')))), code('NATIVE_SESSION_QUARANTINED'));
      await assert.rejects(publishGrant(await sessionInput(target), async publication => {
        const transport = publication.takeTransport(() => undefined);
        try { await assert.rejects(transaction(db => transportPhase(db, transport, { permission: 'canWrite', path: target.identity.path }, async () => assert.fail('diagnosis must have a read ceiling'))), code('NATIVE_TRANSPORT_ACCESS_DENIED')); }
        finally { await disposeTransport(transport); }
        throw new Error('Expected publication cleanup');
      }), error => error instanceof Error && error.message === 'Expected publication cleanup');
    });
    const requestSync = () => new NextRequest('http://localhost/api/files/collaboration/session', { method: 'POST', headers: { authorization: `Bearer ${tokens.owner}`, 'x-canvas-workspace-id': workspaceId } });
    await check('diagnosis capability is distinct, callback-bound and cannot be forged into the editing reader', async () => {
      const target = await seed('diag-cap'); await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_ROUNDTRIP_UNSTABLE',projection_error_sequence=7,projection_error_generation=1,projection_error_permanent=1 WHERE document_id=$1", [target.identity.documentId]);
      let retained!: Parameters<typeof diagnosisCurrent>[1];
      await transaction(db => readDiagnosis(db, requestSync(), { workspaceId, path: target.identity.path }, async cap => { retained = cap; assert.equal(cap.permission, 'read'); assert.equal((await diagnosisCurrent(db, cap)).documentId, target.identity.documentId); }));
      assert.throws(() => retained.snapshot); assert.throws(() => retained.permission);
      await assert.rejects(transaction(db => readDiagnosis(db, requestSync(), { workspaceId, path: target.identity.path }, async cap => {
        await assert.rejects(current(db, cap as unknown as ExistingNativeCollaborationSession), code('NATIVE_SESSION_REQUIRED'));
      })), code('NATIVE_SESSION_REQUIRED'));
    });
    await check('diagnosis retains raw schema/vector validation and unclassified degradation is always read-only', async () => {
      const legacy = await seed('legacy-degradation'); await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [legacy.identity.documentId]);
      const legacyRead = await post('mobile', legacy.identity.path, {}, 'member'); assert.equal(legacyRead.status, 200); assert.equal(legacyRead.wire.permission, 'read');
      for (const corruption of ['binary', 'vector', 'raw-schema', 'error-tuple'] as const) {
        const target = await seed(`diag-invalid-${corruption}`);
        await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_ROUNDTRIP_UNSTABLE',projection_error_sequence=7,projection_error_generation=1,projection_error_permanent=1 WHERE document_id=$1", [target.identity.documentId]);
        if (corruption === 'binary') await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE document_id=$2', [Buffer.from([255]), target.identity.documentId]);
        else if (corruption === 'vector') await admin.query('UPDATE collaboration_yjs_states SET state_vector=$1 WHERE document_id=$2', [Buffer.from([0]), target.identity.documentId]);
        else if (corruption === 'error-tuple') await admin.query('UPDATE collaboration_yjs_states SET projection_error_code=NULL WHERE document_id=$1', [target.identity.documentId]);
        else {
          const doc = new Y.Doc(); try { Y.applyUpdate(doc, target.update); doc.getMap('futureRoot').set('unsupported', true);
            await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2 WHERE document_id=$3', [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), target.identity.documentId]);
          } finally { doc.destroy(); }
        }
        const before = await stored(target.identity), denied = await post('web', target.identity.path);
        assert.equal(denied.status, 409); assert.equal(Object.hasOwn(denied.wire, 'token'), false); assert.deepEqual(await stored(target.identity), before);
      }
    });
    await check('original headers and path are captured before first await of service and actual POST', async () => {
      const target = await seed('snapshot-input'), actual = await sessionInput(target);
      const pending = createGrant(actual); actual.request.headers.set('authorization', `Bearer ${tokens.member}`); actual.sessionRequest.path = 'foreign.md';
      const result = await pending; assert.equal(result.identity.userId, 'owner'); assert.equal(result.grant.documentId, target.identity.documentId); assert.equal(result.grant.permission, 'write');
      const headers = new Headers((await request()).headers); headers.set('content-type', 'application/json');
      const http = new NextRequest('http://localhost/api/files/collaboration/session', { method: 'POST', headers, body: JSON.stringify({ path: target.identity.path, representation: 'auto', ...capabilities }) });
      const postPending = webPost(http); http.headers.set('authorization', `Bearer ${tokens.member}`);
      const response = await postPending, wire = await response.json(); assert.equal(response.status, 200); assert.equal(wire.user.id, 'owner'); assert.equal(wire.permission, 'write');
    });
    await check('private publication starts after COMMIT with no held workspace admission and transfers once', async () => {
      const target = await seed('publication'); let take!: (cleanup: () => void | Promise<void>) => unknown; let cleanup = 0;
      const transport = await publishGrant(await sessionInput(target), async publication => {
        const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(workspaceId)));
        const held = (await admin.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND granted AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=1", [Number(key >> BigInt(32)), Number(key & BigInt('0xffffffff'))])).rows[0].count;
        assert.equal(held, 0); take = publication.takeTransport;
        const owned = take(() => { cleanup++; }); assert.throws(() => take(() => undefined)); return owned;
      });
      assert.throws(() => take(() => undefined)); assert.equal(cleanup, 0);
      await disposeTransport(transport as Parameters<typeof disposeTransport>[0]);
      let removed = 0, failedTransport!: Parameters<typeof disposeTransport>[0];
      await assert.rejects(publishGrant(await sessionInput(target), async publication => { failedTransport = publication.takeTransport(() => { removed++; }); throw new Error('Expected publisher failure'); }), error => error instanceof Error && error.message === 'Expected publisher failure');
      assert.equal(removed, 1);
      await assert.rejects(transaction(db => transportPhase(db, failedTransport, { permission: 'canRead', path: target.identity.path }, async () => assert.fail())), code('NATIVE_TRANSPORT_DISPOSED'));
    });
    await check('actual enrollment COMMIT acknowledgement and pool release failures dispose minted original transport and publish no ticket', async () => {
      for (const fault of ['commit-ack', 'release'] as const) {
        const target = await seed(`enroll-${fault}`), oldQuery = Client.prototype.query, oldSet = WeakMap.prototype.set;
        let capturedTransport: Parameters<typeof disposeTransport>[0] | undefined, capturedBackend: number | undefined, commits = 0;
        WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
          const result = Reflect.apply(oldSet, this, [key, value]);
          const descriptors = value && typeof value === 'object' ? Object.getOwnPropertyDescriptors(value) : {};
          if (descriptors.workspaceId?.value === workspaceId
            && typeof descriptors.maxPermission?.value === 'string' && typeof descriptors.disposed?.value === 'boolean') {
            capturedTransport = key as Parameters<typeof disposeTransport>[0];
            capturedBackend = Number(Reflect.get(Reflect.get(descriptors.origin.value, 'backend'), 'pid'));
          }
          return result;
        } as typeof WeakMap.prototype.set;
        Client.prototype.query = function (this: Client, ...args: unknown[]) {
          const result = Reflect.apply(oldQuery, this, args);
          const sql = typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'text'));
          const options = String(Reflect.get(Reflect.get(this, 'connectionParameters'), 'options'));
          if (this !== admin && this !== control && options.includes(schema) && capturedTransport
            && Number(Reflect.get(this, 'processID')) === capturedBackend && /^COMMIT$/iu.test(sql.trim())) {
            return Promise.resolve(result).then(value => {
              if (++commits === 1) {
                if (fault === 'commit-ack') throw new Error('Owned lost enrollment COMMIT acknowledgement');
                const release = Reflect.get(this, 'release'); assert.equal(typeof release, 'function');
                Reflect.set(this, 'release', (...releaseArgs: unknown[]) => {
                  Reflect.apply(release, this, releaseArgs); throw new Error('Owned enrollment release failure');
                });
              }
              return value;
            });
          }
          return result;
        } as typeof Client.prototype.query;
        let response: Awaited<ReturnType<typeof post>>;
        try { response = await post('web', target.identity.path); }
        finally { Client.prototype.query = oldQuery; WeakMap.prototype.set = oldSet; }
        assert.equal(response!.status, fault === 'commit-ack' ? 503 : 500, JSON.stringify({fault,commits,code:response!.wire.code})); assert.equal(Object.hasOwn(response!.wire, 'token'), false);
        assert(capturedTransport, 'the genuine factory really minted the observed opaque transport');
        await assert.rejects(transaction(db => transportPhase(db, capturedTransport!, { permission: 'canRead', path: target.identity.path }, async () => assert.fail('failed enrollment must be disposed'))), code('NATIVE_TRANSPORT_DISPOSED'));
      }
    });
    await check('actual root and searchpath changes between scope COMMIT and next phase cannot reset native or pristine origin', async () => {
      for (const fault of ['root', 'searchpath'] as const) for (const pristine of [false, true]) {
        const target = pristine ? { identity: { path: `drift-${fault}.md` } } : await seed(`drift-existing-${fault}`);
        if (pristine) await original(target.identity.path, '# Old original\n');
        const oldQuery = Client.prototype.query; let commits = 0, observedScope = false, restoreSearchPath: (() => Promise<unknown>) | undefined;
        Client.prototype.query = function (this: Client, ...args: unknown[]) {
          const result = Reflect.apply(oldQuery, this, args);
          const sql = typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'text'));
          const options = String(Reflect.get(Reflect.get(this, 'connectionParameters'), 'options'));
          if (this !== admin && this !== control && options.includes(schema) && sql.includes('w.id,w.type,w.organization_id,w.project_id,w.customer_id')) observedScope = true;
          if (this !== admin && this !== control && options.includes(schema) && observedScope && /^COMMIT$/iu.test(sql.trim())) {
            return Promise.resolve(result).then(async value => {
              if (++commits === 1) {
                if (fault === 'root') {
                  await mkdir(path.join(dataRoot, 'organizations/principal-org/moved'), { recursive: true });
                  await writeFile(path.join(dataRoot, 'organizations/principal-org/moved', target.identity.path), '# Foreign original\n');
                  await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/moved' WHERE id=$1", [workspaceId]);
                } else {
                  restoreSearchPath = () => Promise.resolve(Reflect.apply(oldQuery, this, ["SELECT set_config('search_path',$1,false)", [`${schema},pg_catalog`]]));
                  await Reflect.apply(oldQuery, this, [`SET search_path=${schema},pg_catalog,pg_temp`]);
                }
              }
              return value;
            });
          }
          return result;
        } as typeof Client.prototype.query;
        let response: Awaited<ReturnType<typeof post>>;
        try { response = await post('web', target.identity.path); }
        finally {
          Client.prototype.query = oldQuery;
          await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared' WHERE id=$1", [workspaceId]);
          await restoreSearchPath?.();
        }
        assert.equal(response!.status, 409); assert.equal(Object.hasOwn(response!.wire, 'token'), false);
        if (pristine) assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2', [workspaceId, target.identity.path])).rows[0].count, 0);
      }
    });
    await check('real busy admission, corrupt native bytes and client format mismatch produce no ticket or seed', async () => {
      const target = await seed('busy'); const blocker = await ownClient(); await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
      try { const denied = await post('web', target.identity.path); assert.equal(denied.status, 409); assert.equal(Object.hasOwn(denied.wire, 'token'), false); }
      finally { await blocker.query('ROLLBACK'); await endClient(blocker); }
      await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE document_id=$2', [Buffer.from([255]), target.identity.documentId]);
      const corrupt = await post('mobile', target.identity.path); assert.equal(corrupt.status, 409); assert.equal(Object.hasOwn(corrupt.wire, 'token'), false);
      const blocks = await seed('format-mismatch', 'tiptap_blocks'); const mismatch = await post('web', blocks.identity.path, { richTextSchemaVersion: 2, blockTreeFormatVersion: 0 }); assert.equal(mismatch.status, 409); assert.equal(mismatch.wire.code, 'representation_mismatch');
    });
    await check('original full scope is checked before mutation B and fresh recovery C without replay after lost commit', async () => {
      const { persistPristineOriginalWorkspaceFileForWrite: bootstrap } = await import('../app/lib/collaboration/markdown-file-import-persistence');
      const { withWorkspaceRequestPrincipalOnConnection: principalPhase } = await import('../app/lib/workspaces/request-principal');
      await admin.query("INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at) VALUES('changed-customer','principal-org','Changed customer','changed-customer','active',100,100)");
      for (const phase of ['B', 'C'] as const) for (const fault of ['root', 'customer', 'searchpath', 'schemaOid', 'databaseOid'] as const) {
        if (phase === 'C' && ['schemaOid', 'databaseOid'].includes(fault)) continue;
        const filePath = `scope-${phase}-${fault}.txt`; await original(filePath, 'Bound original\n');
        const expected: PristineOriginalRequestScopeExpectation = await captured(principal => transaction(db => principalPhase(db, principal, async access => {
          const realm = await db.get(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
            (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,current_setting('search_path') AS search_path`) as Record<string, unknown>;
          const workspace = access.workspace;
          return { userId: access.userId, sessionId: access.sessionId, workspaceId, workspaceType: workspace.workspaceType,
            organizationId: workspace.organizationId ?? null, projectId: workspace.projectId ?? null, customerId: workspace.customerId ?? null,
            ownerUserId: workspace.ownerUserId ?? null, rootPath: workspace.rootPath, rootRelativePath: workspace.rootRelativePath!, legacy: false, status: 'active',
            schema: String(realm.schema), schemaOid: Number(realm.schema_oid) + (fault === 'schemaOid' ? 1 : 0),
            databaseOid: Number(realm.database_oid) + (fault === 'databaseOid' ? 1 : 0), searchPath: String(realm.search_path) };
        })));
        let opened = 0, mutationClosed = false;
        const drift = async (client: Client) => {
          if (fault === 'searchpath') await client.query(`SET search_path=${schema},pg_catalog,pg_temp`);
          else if (fault === 'root') await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/moved' WHERE id=$1", [workspaceId]);
          else if (fault === 'customer') await admin.query("UPDATE canvas_workspaces SET customer_id='changed-customer' WHERE id=$1", [workspaceId]);
        };
        const operationId = crypto.randomUUID(); let failureCode: unknown;
        try {
          await assert.rejects(bootstrap(await request(), { workspaceId, path: filePath, operationId, requestId: crypto.randomUUID(), expectedTarget: { kind: 'absent' } }, {
            expectedRequestScope: expected,
            openConnection: async () => {
              const client = await ownClient(), ordinal = ++opened, base = connection(client);
              if (ordinal === 3) assert.equal(mutationClosed, true, 'discard B before opening fresh recovery C');
              if (ordinal === (phase === 'B' ? 2 : 3)) await drift(client);
              return { ...base, run: async (sql, values) => {
                const result = await base.run(sql, values);
                if (phase === 'C' && ordinal === 2 && /^COMMIT$/iu.test(sql.trim())) throw new Error('Owned lost bound-scope bootstrap COMMIT acknowledgement');
                return result;
              }, close: async () => { await endClient(client); if (ordinal === 2) mutationClosed = true; } };
            },
          }), error => { failureCode = error && typeof error === 'object' ? Reflect.get(error, 'code') : null; return true; });
        } finally {
          await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared',customer_id=NULL WHERE id=$1", [workspaceId]);
        }
        assert(['MARKDOWN_IMPORT_TARGET_CHANGED', 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED', 'MARKDOWN_IMPORT_REQUEST_CONFLICT', 'PRINCIPAL_SCOPE_CHANGED'].includes(String(failureCode)), `${phase}/${fault}/${String(failureCode)}`);
        assert.equal(opened, phase === 'B' ? 2 : 3);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2', [workspaceId, filePath])).rows[0].count, phase === 'B' ? 0 : 1);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2', [workspaceId, operationId])).rows[0].count, phase === 'B' ? 0 : 1);
      }
    });
    await check('quarantine reenrollment binds original root customer and searchpath after diagnosis COMMIT before publication', async () => {
      await admin.query("INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at) VALUES('changed-customer','principal-org','Changed customer','changed-customer','active',100,100) ON CONFLICT(id) DO NOTHING");
      for (const surface of ['web', 'mobile'] as const) for (const fault of ['root', 'customer', 'searchpath'] as const) {
        const target = await seed(`quarantine-reenroll-${surface}-${fault}`);
        await admin.query("UPDATE collaboration_yjs_states SET degraded=1,projection_error_code='COLLABORATION_ROUNDTRIP_UNSTABLE',projection_error_phase='codec',projection_error_sequence=7,projection_error_generation=1,projection_error_permanent=1 WHERE document_id=$1", [target.identity.documentId]);
        const before = await stored(target.identity), oldQuery = Client.prototype.query, oldSet = WeakMap.prototype.set;
        let capturedReadTransport: Parameters<typeof disposeTransport>[0] | undefined;
        WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
          const result = Reflect.apply(oldSet, this, [key, value]);
          const descriptors = value && typeof value === 'object' ? Object.getOwnPropertyDescriptors(value) : {};
          if (descriptors.workspaceId?.value === workspaceId && descriptors.maxPermission?.value === 'canRead'
            && typeof descriptors.disposed?.value === 'boolean') capturedReadTransport = key as Parameters<typeof disposeTransport>[0];
          return result;
        } as typeof WeakMap.prototype.set;
        let diagnosisBackend: number | undefined, changed = false, restore: (() => Promise<unknown>) | undefined;
        Client.prototype.query = function (this: Client, ...args: unknown[]) {
          const result = Reflect.apply(oldQuery, this, args), sql = typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'text'));
          if (sql.includes('d.state_version>=y.checkpoint_sequence') && Array.isArray(args[1]) && args[1][0] === target.identity.documentId) diagnosisBackend = Number(Reflect.get(this, 'processID'));
          if (!changed && diagnosisBackend === Number(Reflect.get(this, 'processID')) && /^COMMIT$/iu.test(sql.trim())) return Promise.resolve(result).then(async value => {
            changed = true;
            if (fault === 'root') await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/moved' WHERE id=$1", [workspaceId]);
            else if (fault === 'customer') await admin.query("UPDATE canvas_workspaces SET customer_id='changed-customer' WHERE id=$1", [workspaceId]);
            else { restore = () => Promise.resolve(Reflect.apply(oldQuery, this, ["SELECT set_config('search_path',$1,false)", [`${schema},pg_catalog`]]));
              await Reflect.apply(oldQuery, this, ["SELECT set_config('search_path',$1,false)", [`${schema},pg_catalog,pg_temp`]]); }
            return value;
          });
          return result;
        } as typeof Client.prototype.query;
        let response: Awaited<ReturnType<typeof post>>;
        try { response = await post(surface, target.identity.path); }
        finally { Client.prototype.query = oldQuery; WeakMap.prototype.set = oldSet;
          await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared',customer_id=NULL WHERE id=$1", [workspaceId]); await restore?.(); }
        assert.equal(changed, true); assert.equal(response!.status, 409, `${surface}/${fault}`); assert.equal(Object.hasOwn(response!.wire, 'token'), false);
        assert(capturedReadTransport, 'genuine read reenrollment really minted the disposed opaque transport');
        await assert.rejects(transaction(db => transportPhase(db, capturedReadTransport!, { permission: 'canRead', path: target.identity.path }, async () => assert.fail('changed-origin enrollment must be disposed'))), code('NATIVE_TRANSPORT_DISPOSED'));
        assert.deepEqual(await stored(target.identity), before);
      }
    });
    const { installRichMigrationRuntime, noteRichMigrationWorkerSuccess } = await import('../app/lib/collaboration/representation-migration-runtime');
    const { collaborationUpdateStateProof } = await import('../app/lib/collaboration/state-proof');
    const { readAuthenticatedRichMigrationNative } = await import('../app/lib/collaboration/rich-migration-domain');
    const stopMigrationRuntime = installRichMigrationRuntime(() => 0);
    const migrationSeed = async (label: string, markdown = '# Native title\n\nFirst **bold** text.\n') => {
      const doc = createPlainTextYDoc(markdown); const target = await seed(label, 'plain_text', { doc }); doc.destroy();
      const hash = crypto.createHash('sha256').update(markdown).digest('hex');
      await admin.query(`UPDATE collaboration_yjs_states SET document_sequence=1,checkpoint_sequence=1,checkpointed_at=100,canonical_hash=$2,serialized_hash=$2 WHERE document_id=$1`, [target.identity.documentId, hash]);
      await admin.query('UPDATE collaboration_documents SET state_version=1 WHERE id=$1', [target.identity.documentId]);
      await admin.query(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,revision_id,canonical_hash,serialized_hash,finalized,updated_at)
        VALUES($1,1,1,$2,$3,$3,1,100)`, [target.identity.documentId, `revision-${target.identity.documentId}`, hash]);
      await original(target.identity.path, markdown);
      return { ...target, migration: { requestId: crypto.randomUUID(), expectedDocumentId: target.identity.documentId,
        expectedLifecycleGeneration: 1, documentSequence: 1, stateProof: collaborationUpdateStateProof(target.update, Y)! } };
    };
    try {
      await check('actual Web/Mobile POSTs run typed genuine modern migration and repeat the immutable ID without a second native write', async () => {
        const actualPool = runtime as unknown as Pool, leases = [];
        try {
          for (let index = 0; index < actualPool.totalCount; index++) leases.push(await actualPool.connect());
          const realms = await Promise.all(leases.map(client => client.query("SELECT current_setting('search_path') AS path")));
          assert(realms.every(result => result.rows[0].path === `${schema},pg_catalog`), JSON.stringify(realms.map(result => result.rows[0])));
        } finally { for (const client of leases) client.release(); }
        for (const surface of ['web', 'mobile'] as const) {
          const target = await migrationSeed(`modern-${surface}`); noteRichMigrationWorkerSuccess();
          await readAuthenticatedRichMigrationNative(await request('owner', surface === 'web'), workspaceId, target.identity.path);
          const result = await post(surface, target.identity.path, { migration: target.migration }, 'owner', surface === 'web');
          const observed = await stored(target.identity);
          assert.equal(result.status, 200, JSON.stringify({ wire: result.wire, representation: observed.representation, generation: observed.lifecycle_generation,
            permanent: observed.projection_error_permanent, degraded: observed.degraded, error: observed.projection_error_code })); assert.equal(result.wire.representation, 'tiptap_blocks'); assert.equal(result.wire.lifecycleGeneration, 2);
          assert.equal((result.wire.migration as { status: string }).status, 'migrated');
          assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_state_backups WHERE document_id=$1', [target.identity.documentId])).rows[0].count, 1);
          noteRichMigrationWorkerSuccess(); const repeated = await post(surface, target.identity.path, { migration: target.migration });
          assert.equal(repeated.status, 200); assert.equal(repeated.wire.lifecycleGeneration, 2);
          assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_state_backups WHERE document_id=$1', [target.identity.documentId])).rows[0].count, 1);
        }
      });
      await check('actual modern POST requires genuine write and cancellation keeps native identity without replay', async () => {
        for (const surface of ['web', 'mobile'] as const) {
          const target = await migrationSeed(`modern-denied-${surface}`); noteRichMigrationWorkerSuccess();
          const denied = await post(surface, target.identity.path, { migration: target.migration }, 'member'); assert.equal(denied.status, 403); assert.equal(Object.hasOwn(denied.wire, 'token'), false);
          const wrong = await post(surface, target.identity.path, { migration: { ...target.migration, expectedDocumentId: 'wrong-document' } });
          assert.equal(wrong.status, 409); assert.equal(wrong.wire.code, 'ADMISSION_SCOPE_CHANGED'); assert.equal(Object.hasOwn(wrong.wire, 'token'), false);
          assert.equal(Number((await stored(target.identity)).lifecycle_generation), 1);
          noteRichMigrationWorkerSuccess(); const cancelled = await post(surface, target.identity.path, { migration: target.migration, migrationAction: 'cancel' });
          assert.equal(cancelled.status, 200, JSON.stringify({ surface, status: cancelled.status, code: cancelled.wire.code, error: cancelled.wire.error, migration: cancelled.wire.migration })); assert.equal((cancelled.wire.migration as { reason: string }).reason, 'cancelled');
          noteRichMigrationWorkerSuccess(); const repeated = await post(surface, target.identity.path, { migration: target.migration });
          assert.equal(repeated.status, 200, JSON.stringify({ surface, status: repeated.status, code: repeated.wire.code, error: repeated.wire.error, migration: repeated.wire.migration }));
          const state = await stored(target.identity); assert.equal(Number(state.lifecycle_generation), 1); assert.deepEqual(state.yjs_state, target.update);
          assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_state_backups WHERE document_id=$1', [target.identity.documentId])).rows[0].count, 0);
        }
      });
      await check('actual Web legacy normalization uses genuine writer checkpoint and Mobile retains its explicit modern migration contract', async () => {
        for (const surface of ['web', 'mobile'] as const) for (const normalizable of [false, true]) {
          const target = await migrationSeed(`legacy-${surface}-${normalizable}`, normalizable ? '* one\n* two\n' : '# Legacy rich\n');
          const result = await post(surface, target.identity.path, { allowRichMigration: true, expectedLifecycleGeneration: 1,
            ...(surface === 'web' ? { blockTreeFormatVersion: 0 } : {}) });
          assert.equal(result.status, 200); assert.equal(result.wire.representation, surface === 'web' ? 'tiptap_xml' : 'plain_text'); assert.equal(result.wire.lifecycleGeneration, surface === 'web' ? 2 : 1);
          assert.equal(Number((await stored(target.identity)).lifecycle_generation), surface === 'web' ? 2 : 1);
          if (normalizable) assert.equal(result.wire.projectionFinalized, true);
        }
      });
    } finally { stopMigrationRuntime(); }
    assert.equal(fetches,0);
    disposeMobileCollaborationTickets();
    console.log(`Authenticated native HTTP session: ${cases} actual PostgreSQL18/BetterAuth/Team matrix families passed; actual exported Web/Mobile POSTs; product integration gate remains false.`);
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
  location:error instanceof Error?error.stack?.split('\n').filter(line=>line.includes('authenticated-text-session-postgres-test.ts') || line.includes('rich-migration-domain.ts')).map(line=>line.trim()):[],
  message:error instanceof Error&&error.name==='AssertionError'?error.message.slice(0,600):null,
  expected:error&&typeof error==='object'&&['string','number','boolean'].includes(typeof Reflect.get(error,'expected'))?Reflect.get(error,'expected'):null,
  actual:error&&typeof error==='object'&&['string','number','boolean'].includes(typeof Reflect.get(error,'actual'))?Reflect.get(error,'actual'):null,
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  constraint:error&&typeof error==='object'?Reflect.get(error,'constraint')??null:null});process.exitCode=1;});
