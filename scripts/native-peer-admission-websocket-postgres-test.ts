import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { WebSocket } from 'ws';
import { MessageType, Hocuspocus } from '@hocuspocus/server';
import { AuthMessageType } from '@hocuspocus/common';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { ExistingNativeSessionIdentity } from '../app/lib/collaboration/native-session-state-reader';

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
  const schema = `native_admission_socket_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_admission_socket_[a-f0-9]{32}$/u);
  const workspaceId = `native-transport-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-admission-socket-'));
  console.log('Own source-only RawWS fixture:', { pid: process.pid, schema, dataRoot });
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
      VALUES($1,'principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`,[workspaceId]);
    for (const userId of ['owner','member','inactive']) {
      await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
        VALUES($1,'principal-org','personal',$2,$2,$3,'active',100,100)`,[`personal-${userId}-${workspaceId}`,userId,`users/${userId}/workspace`]);
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
    (runtime as import('pg').Pool).on('connect',client=>{client.on('error',()=>undefined);});
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!,process.env.CANVAS_INSTANCE_ID!)).ok,true);
    const license = await getLicenseStatus(); assert.equal(license.licensed,true); assert.equal(license.edition,'team'); assert.equal(license.seatLimit,2);
    await import('../app/lib/auth');
    const { createPlainTextYDoc,createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const request = async (userId='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if(cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[userId],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/collaboration/session',{method:'POST',headers});
    };
    const check=async(name:string,operation:()=>Promise<void>)=>{if(process.env.CANVAS_TEST_NATIVE_SOCKET_CASE&&!name.includes(process.env.CANVAS_TEST_NATIVE_SOCKET_CASE))return;stage=name;await operation();cases++;console.log(`Native Socket passed: ${name}`);};
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
    const actualDb = await import('../app/lib/db');
    const transportApi = await import('../app/lib/collaboration/authenticated-native-session-transport');
    const { withAuthenticatedTextCollaborationSessionGrant: publishGrant } = await import('../app/lib/collaboration/authenticated-text-session-service');
    const serverDisposals = new Map<import('../app/lib/collaboration/authenticated-native-session-transport').AuthenticatedNativeSessionTransport, Promise<void>>();
    let finishAbort: { documentId: string; fired: boolean; cap?: import('../app/lib/collaboration/authenticated-native-session-transport').AuthenticatedNativeSessionTransport } | undefined;
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { NATIVE_PEER_ADMISSION_BUSY_REASON } = await import('../app/lib/collaboration/failure');
    const mobile = await import('../app/lib/mobile/collaboration-ticket');
    const { POST: mobilePOST } = await import('../app/api/mobile/v1/notebook/collaboration/session/route');
    const { issueCollaborationTicket } = await import('../app/lib/collaboration/ticket');
    const { loadCollaborationState } = await import('../app/lib/collaboration/persistence');
    const actualRoot = path.join(dataRoot, 'organizations/principal-org/shared'); await mkdir(actualRoot, { recursive: true });
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    type TestBarrier = { kind: 'capture'|'join'|'commit'; release: boolean; rollbacks: number; begins: number; closes: number; commits: number; closedBeforeNext: boolean; holding?: Client };
    let barrier: TestBarrier | undefined;
    const observedOpen = async () => {
      const actual = await actualDb.openDb();
      const current = barrier;
      const observed: SqlConnection = {
        get: (sql, values) => actual.get(sql, values),
        all: (sql, values) => actual.all(sql, values),
        run: async (sql, values) => {
          if (current && sql === 'BEGIN') { if (current.begins > 0 && current.rollbacks > 0) current.closedBeforeNext &&= current.closes >= current.rollbacks; current.begins++; }
          const result = await actual.run(sql, values);
          if (current && sql === 'ROLLBACK') {
            current.rollbacks++;
            if (current.release && current.holding) { await current.holding.query('ROLLBACK'); await current.holding.end(); clients.delete(current.holding); current.holding = undefined; }
          }
          if (current && sql === 'COMMIT') {
            current.commits++;
            if (current.kind === 'commit') throw new Error('Lost genuine admission COMMIT response.');
          }
          return result;
        },
        close: async error => { await actual.close(error); if (current) current.closes++; },
      };
      return observed;
    };
    // Only connection forwarding changes in this Source-only fixture; actual
    // factory, broker, guards, claims and lifecycle core execute without substitutes.
    const helperPath = path.resolve('app/lib/collaboration/authenticated-native-peer-admission.ts');
    const requireHelper = createRequire(helperPath);
    const helper = {} as typeof import('../app/lib/collaboration/authenticated-native-peer-admission');
    const helperSource = await readFile(helperPath, 'utf8');
    new Function('require', 'module', 'exports', ts.transpileModule(helperSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText)(
      (name: string) => name === '../db' ? { ...actualDb, openDb: observedOpen } : requireHelper(name), { exports: helper }, helper);
    const serverPath = path.resolve('server/collaboration-server.ts'), requireServer = createRequire(serverPath);
    const product = {} as typeof import('../server/collaboration-server');
    const serverSource = await readFile(serverPath, 'utf8');
    new Function('require', 'module', 'exports', ts.transpileModule(serverSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText)(
      (name: string) => name === '@/app/lib/collaboration/authenticated-native-session-transport' ? { ...transportApi, disposeAuthenticatedNativeSessionTransport: (cap: Parameters<typeof transportApi.disposeAuthenticatedNativeSessionTransport>[0]) => { const pending = transportApi.disposeAuthenticatedNativeSessionTransport(cap); serverDisposals.set(cap, pending); return pending; } } : name === '@/app/lib/collaboration/authenticated-native-peer-admission' ? { ...helper, authenticateNativePeerAdmission: async (input: Parameters<typeof helper.authenticateNativePeerAdmission>[0]) => {
        const admitted = await helper.authenticateNativePeerAdmission(input);
        if (finishAbort?.documentId === input.claims.documentId) {
          finishAbort.fired = true; finishAbort.cap = admitted.transport;
          ownSockets.get(input.claims.documentId)!.terminate();
          await waitUntil(() => authRequests.get(input.claims.documentId)?.signal.aborted ?? false, 'Actual upgrade Request did not abort at helper transfer.');
        }
        return admitted;
      } } : requireServer(name), { exports: product }, product);
    const server = http.createServer((_request, response) => { response.statusCode = 404; response.end(); });
    const sockets = new Set<WebSocket>(), documents = new Map<string, import('@hocuspocus/server').Document>();
    const ownSockets = new Map<string, WebSocket>(), authRequests = new Map<string, Request>(), createdDocs = new Set<InstanceType<typeof Y.Doc>>();
    const originalHooks = Hocuspocus.prototype.hooks;
    const actualRuntime: { hocuspocus?: Hocuspocus } = {};
    Hocuspocus.prototype.hooks = (async function(this: Hocuspocus, name: string, payload: Record<string, unknown>, ...args: unknown[]) {
      actualRuntime.hocuspocus = this;
      if (name === 'onAuthenticate' && typeof payload.documentName === 'string' && payload.request instanceof Request) authRequests.set(payload.documentName, payload.request);
      const value = await (originalHooks as (...args: unknown[]) => Promise<unknown>).call(this, name, payload, ...args);
      if (name === 'connected' && typeof payload.documentName === 'string' && payload.connection) documents.set(payload.documentName, (payload.connection as import('@hocuspocus/server').Connection).document);
      return value;
    }) as typeof originalHooks;
    const wss = product.createCollaborationServer(server, { roomOwner: { createSession: async invalidated => {
      const client = await ownClient();
      return createCollaborationRoomOwnerSession({ query: client.query.bind(client), on: client.on.bind(client), end: client.end.bind(client) }, invalidated);
    }, heartbeatMs: 1000 } });
    const waitUntil = async (predicate: () => boolean|Promise<boolean>, label: string) => {
      const until = Date.now() + 8000;
      while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error(label);
    };
    const frame = (id: string, type: number, write: (encoder: ReturnType<typeof encoding.createEncoder>) => void) => {
      const encoder = encoding.createEncoder(); encoding.writeVarString(encoder, id); encoding.writeVarUint(encoder, type); write(encoder); return encoding.toUint8Array(encoder);
    };
    const claimsFor = (identity: ExistingNativeSessionIdentity) => ({ userId: 'owner', sessionId: 'session-owner', workspaceId,
      organizationId: identity.organizationId, documentId: identity.documentId, path: identity.path, provider: 'yjs' as const,
      representation: identity.representation, permission: 'write' as const, lifecycleGeneration: identity.lifecycleGeneration });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object');
    const authSocket = async (identity: ExistingNativeSessionIdentity, ticket?: string) => {
      const original = ticket ? undefined : await request('owner', true);
      const token = ticket ?? issueCollaborationTicket(claimsFor(identity)).token;
      const socket = ticket ? new WebSocket(`ws://127.0.0.1:${address.port}/ws/collaboration`, [mobile.MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL], { headers: { origin: 'http://localhost' } })
        : new WebSocket(`ws://127.0.0.1:${address.port}/ws/collaboration`, { headers: { origin: 'http://localhost', cookie: original!.headers.get('cookie')!, 'x-canvas-workspace-id': workspaceId } });
      sockets.add(socket); ownSockets.set(identity.documentId, socket); const doc = new Y.Doc(); createdDocs.add(doc); const messages: Array<{ auth?: number; reason?: string; type: number; body?: Record<string, unknown> }> = [];
      socket.on('error', () => undefined);
      socket.on('message', raw => {
        const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? new Uint8Array(Buffer.concat(raw)) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        const decoder = decoding.createDecoder(bytes); decoding.readVarString(decoder); const type = decoding.readVarUint(decoder);
        if (type === MessageType.Auth) { const auth = decoding.readVarUint(decoder); messages.push({ type, auth, ...(auth === AuthMessageType.PermissionDenied ? { reason: decoding.readVarString(decoder) } : {}) }); }
        else if (type === MessageType.Stateless) messages.push({ type, body: JSON.parse(decoding.readVarString(decoder)) });
        else if (type === MessageType.Sync) { const subtype = decoding.readVarUint(decoder); if (subtype === 1 || subtype === 2) Y.applyUpdate(doc, decoding.readVarUint8Array(decoder)); messages.push({ type }); }
        else messages.push({ type });
      });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      socket.send(frame(identity.documentId, MessageType.Auth, encoder => { encoding.writeVarUint(encoder, AuthMessageType.Token); encoding.writeVarString(encoder, token); }));
      await waitUntil(() => messages.some(message => message.auth === AuthMessageType.Authenticated || message.auth === AuthMessageType.PermissionDenied), 'Actual authentication did not settle.');
      const denied = messages.find(message => message.auth === AuthMessageType.PermissionDenied)?.reason;
      if (!denied) {
        await waitUntil(() => messages.some(message => message.body?.type === 'durability_snapshot'), 'Actual connected snapshot missing.');
        socket.send(frame(identity.documentId, MessageType.Sync, encoder => { encoding.writeVarUint(encoder, 0); encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc)); }));
        await waitUntil(() => doc.getText('content').toString() === 'ABC', 'Actual native sync missing.');
      }
      return { socket, doc, messages, denied };
    };
    const hold = async (kind: 'capture'|'join', release: boolean) => {
      const holding = await ownClient(); await holding.query('BEGIN');
      if (kind === 'capture') await holding.query('LOCK TABLE canvas_project_members IN SHARE MODE');
      else await holding.query('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
      barrier = { kind, release, rollbacks: 0, begins: 0, closes: 0, commits: 0, closedBeforeNext: true, holding };
    };
    const release = async () => { const held = barrier?.holding; barrier = undefined; if (held) { await held.query('ROLLBACK'); await held.end(); clients.delete(held); } };
    try {
      for (const mobileMode of [false, true]) for (const transient of [true, false]) await check(`actual ${mobileMode?'Mobile single-use':'Web cookie'} ${transient?'transient':'durable'} admission Busy has genuine private Auth wire`, async () => {
        const native = await seed(`admission-${mobileMode}-${transient}`); await writeFile(path.join(actualRoot, native.identity.path), 'ABC');
        let ticket: string|undefined;
        if (mobileMode) {
          const authenticated = await request();
          const response = await mobilePOST(new NextRequest('http://localhost/api/mobile/v1/notebook/collaboration/session', { method: 'POST', headers: authenticated.headers,
            body: JSON.stringify({ path: native.identity.path, richTextSchemaVersion: 1, blockTreeFormatVersion: 1 }) }));
          const result = await response.json(); assert.equal(response.status, 200, `Actual Mobile POST status ${response.status}/${result.code ?? 'unknown'}`);
          assert.equal(result.documentId, native.identity.documentId); ticket = result.token; assert.equal(typeof ticket, 'string');
        }
        await hold(mobileMode?'join':'capture', transient);
        const peer = await authSocket(native.identity, ticket);
        try {
          assert(barrier); assert(barrier.closedBeforeNext);
          if (transient) { assert.equal(peer.denied, undefined); assert.equal(barrier.rollbacks, 1); assert.equal(peer.doc.getText('content').toString(), 'ABC'); }
          else { assert.equal(peer.denied, NATIVE_PEER_ADMISSION_BUSY_REASON); assert.equal(barrier.rollbacks, 3); assert(!documents.has(native.identity.documentId)); }
          if (ticket) assert.equal(mobile.consumeMobileCollaborationTicket(ticket), null);
          const state = await loadCollaborationState(native.identity.documentId); assert(state); assert.equal(state.documentSequence, 7);
          const durable = new Y.Doc(); Y.applyUpdate(durable, state.yjsState); assert.equal(durable.getText('content').toString(), 'ABC'); durable.destroy();
          assert.equal(peer.messages.some(message => message.body?.type === 'access_revoked'), false);
        } finally { await release(); peer.socket.close(); peer.doc.destroy(); }
        await waitUntil(() => !actualRuntime.hocuspocus?.documents.get(native.identity.documentId)?.getConnectionsCount(), 'Own Socket did not disconnect.');
        await product.flushCollaborationDocuments();
      });
      await check('actual capture COMMIT uncertainty is denied without Busy reason or fresh attempts', async () => {
        const native = await seed('commit-no-replay'); await writeFile(path.join(actualRoot, native.identity.path), 'ABC');
        barrier = { kind: 'commit', release: false, rollbacks: 0, begins: 0, closes: 0, commits: 0, closedBeforeNext: true };
        const peer = await authSocket(native.identity);
        try { assert(peer.denied); assert.notEqual(peer.denied, NATIVE_PEER_ADMISSION_BUSY_REASON); assert.equal(barrier.begins, 1); assert.equal(barrier.commits, 1); assert(!documents.has(native.identity.documentId)); }
        finally { await release(); peer.socket.close(); peer.doc.destroy(); }
      });
      const knownMobile = async (identity: ExistingNativeSessionIdentity) => publishGrant({ request: await request(), workspaceId,
        sessionRequest: { path: identity.path, provider: 'yjs', representation: 'plain_text' }, permission: 'write' }, async publication => {
        let cap: import('../app/lib/collaboration/authenticated-native-session-transport').AuthenticatedNativeSessionTransport | undefined;
        const ticket = mobile.issueAuthenticatedMobileCollaborationTicket({ claims: claimsFor(identity), user: { id: 'owner', name: 'Owner', email: null, role: null },
          takeTransport: rollback => { cap = publication.takeTransport(rollback); return cap; } });
        assert(cap); return { ticket, cap };
      });
      for (const kind of ['poisoned', 'in-flight'] as const) await check(`actual ownership ${kind} inherited Mobile adoption rejects and disposes known cap`, async () => {
        const native = await seed(`adoption-${kind}`); await writeFile(path.join(actualRoot, native.identity.path), 'ABC');
        const { ticket, cap } = await knownMobile(native.identity);
        const database = await actualDb.openDb(); await database.run('BEGIN');
        let pending: Promise<unknown> | undefined;
        let releaseGate!: () => void; const blocking = new Promise<void>(resolve => { releaseGate = resolve; });
        let enteredGate!: () => void; const entered = new Promise<void>(resolve => { enteredGate = resolve; });
        try {
          if (kind === 'poisoned') {
            await assert.rejects(transportApi.withAuthenticatedNativeSessionTransportOnConnection(database, cap, { path: native.identity.path, permission: 'canRead' }, async () => { throw new Error('Genuine inherited cap consumer failure.'); }));
            await database.run('ROLLBACK'); await database.close();
          } else {
            pending = transportApi.withAuthenticatedNativeSessionTransportOnConnection({ ...database, get: async (sql, values) => { const result = await database.get(sql, values); if (sql.includes("current_setting('session_replication_role')")) { enteredGate(); await blocking; } return result; } }, cap, { path: native.identity.path, permission: 'canRead' }, async () => assert.fail('Disposed in-flight adoption must not enter consumer.'));
            // The actual broker reserves record.inFlight synchronously, before
            // the genuine fresh factory resolves; no facade or state is faked.
            void pending.catch(() => undefined); await entered;
          }
          const authenticating = authSocket(native.identity, ticket.token);
          if (kind === 'in-flight') { await waitUntil(() => serverDisposals.has(cap), 'Server did not dispose the actual inherited cap at rejected in-flight adoption.'); releaseGate(); }
          const peer = await authenticating;
          assert(serverDisposals.has(cap), 'Actual server cleanup must dispose even an adoption failure.'); await serverDisposals.get(cap);
          assert(peer.denied); assert.notEqual(peer.denied, NATIVE_PEER_ADMISSION_BUSY_REASON); assert(!documents.has(native.identity.documentId));
          peer.socket.close(); peer.doc.destroy();
          if (pending) { await assert.rejects(pending); await database.run('ROLLBACK'); await database.close(); pending = undefined; }
          // Exactly this inherited original cap was disposed by server startup
          // cleanup even though the helper never adopted an Origin.
          assert.throws(() => transportApi.adoptAuthenticatedNativePeerOrigin(cap));
          assert.equal(mobile.consumeMobileCollaborationTicket(ticket.token), null);
        } finally {
          releaseGate();
          if (pending) { await Promise.allSettled([pending]); await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); await database.close(); }
          await transportApi.disposeAuthenticatedNativeSessionTransport(cap);
        }
      });
      await check('actual ownership abort after helper finish before server publication disposes transferred cap', async () => {
        const native = await seed('abort-transfer'); await writeFile(path.join(actualRoot, native.identity.path), 'ABC');
        finishAbort = { documentId: native.identity.documentId, fired: false };
        try {
          await assert.rejects(authSocket(native.identity)); assert(finishAbort.fired); assert(finishAbort.cap);
          assert(!documents.has(native.identity.documentId));
          assert(serverDisposals.has(finishAbort.cap)); await serverDisposals.get(finishAbort.cap);
          assert.throws(() => transportApi.adoptAuthenticatedNativePeerOrigin(finishAbort!.cap!));
        } finally { if (finishAbort?.cap) await transportApi.disposeAuthenticatedNativeSessionTransport(finishAbort.cap); finishAbort = undefined; }
      });
      assert.equal(fetches, 0); console.log(`Native admission actual RawSocket PG18: ${cases} families passed.`);
    } finally {
      await release(); for (const socket of sockets) socket.terminate();
      await waitUntil(() => [...actualRuntime.hocuspocus?.documents.values() ?? []].every(doc => doc.getConnectionsCount() === 0), 'Own sockets remained.');
      await product.flushCollaborationDocuments();
      if (actualRuntime.hocuspocus) { await Promise.allSettled([...actualRuntime.hocuspocus.documents.values()].map(doc => actualRuntime.hocuspocus!.unloadDocument(doc))); await Promise.allSettled([...actualRuntime.hocuspocus.unloadingDocuments.values()]); }
      await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()));
      for (const doc of documents.values()) doc.destroy(); for (const doc of createdDocs) doc.destroy(); Hocuspocus.prototype.hooks = originalHooks;
    }
  } finally {
    globalThis.fetch = originalFetch;
    try { if (pool) await pool.end(); } finally {
      try { for (const client of clients) await client.end(); } finally {
        try { if (created) { await control.query(`DROP SCHEMA "${schema}" CASCADE`); assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true); } }
        finally { await control.end(); await rm(dataRoot, { recursive: true, force: true }); console.log('Own RawWS closure:', { schemaRemoved: true, dataRemoved: true, poolClosed: true, clientsClosed: true }); for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment); }
      }
    }
  }
}
main().catch(error => { console.error('Native admission RawSocket fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown', code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null }); process.exitCode = 1; });
