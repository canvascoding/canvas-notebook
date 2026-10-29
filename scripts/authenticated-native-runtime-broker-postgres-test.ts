import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { AuthenticatedNativeSessionTransport } from '../app/lib/collaboration/authenticated-native-session-transport';
import type { ExistingNativeCollaborationSession, ExistingNativeSessionIdentity, ExistingNativeSessionRequestAccess } from '../app/lib/collaboration/native-session-state-reader';

const fixtureRoot = path.resolve(path.dirname(process.argv[1]), '..');
const fixtureRequire = createRequire(path.join(fixtureRoot, 'package.json'));
type TransportModule = typeof import('../app/lib/collaboration/authenticated-native-session-transport');
const runtimeKey = Symbol.for('canvas.authenticated-native-session-runtime');

/** Separate actual source instances: only import/require paths change. */
async function sourceCopies() {
  const root = await mkdtemp(path.join(tmpdir(), 'canvas-native-broker-modules-'));
  await chmod(root, 0o700);
  await symlink(path.join(fixtureRoot, 'node_modules'), path.join(root, 'node_modules'));
  const originalNext = fixtureRequire.resolve('next/dist/server/web/spec-extension/request.js');
  const actualNextSource = await readFile(originalNext, 'utf8');
  const nextBindings: Array<readonly [string, string]> = [];
  const alternateNextSource = actualNextSource.replace(/require\(("\.[^"]+")\)/gu, (_whole, literal: string) => {
    const specifier = JSON.parse(literal) as string;
    const target = fixtureRequire.resolve(path.resolve(path.dirname(originalNext), specifier));
    const replacement = JSON.stringify(target); nextBindings.push([literal, replacement]);
    return `require(${replacement})`;
  });
  assert.equal(nextBindings.length, 4);
  let nextReversed = alternateNextSource;
  for (const [original, bound] of nextBindings) nextReversed = nextReversed.replace(`require(${bound})`, `require(${original})`);
  assert.equal(nextReversed, actualNextSource);
  const alternateNextPath = path.join(root, 'actual-next-request.cjs');
  await writeFile(alternateNextPath, alternateNextSource, { flag: 'wx', mode: 0o600 });
  const alternateNext = (await import(pathToFileURL(alternateNextPath).href)).NextRequest as typeof NextRequest;
  assert.notEqual(alternateNext, NextRequest);
  const paths = { A: path.join(root, 'transport-A.ts'), B: path.join(root, 'transport-B.ts') };
  for (const copy of ['A', 'B'] as const) {
    const readerPath = path.join(root, `reader-${copy}.ts`), principalPath = path.join(root, `principal-${copy}.ts`);
    const sources = [
      ['app/lib/workspaces/request-principal.ts', principalPath],
      ['app/lib/collaboration/native-session-state-reader.ts', readerPath],
      ['app/lib/collaboration/authenticated-native-session-transport.ts', paths[copy]],
    ] as const;
    for (const [relative, destination] of sources) {
      const sourcePath = path.join(fixtureRoot, relative), original = await readFile(sourcePath, 'utf8');
      const bindings: Array<readonly [string, string]> = [];
      const changed = original.replace(/(?<=from |import\()(['"])([^'"]+)\1/gu, (literal, quote: string, specifier: string) => {
        let target = specifier;
        if (specifier.startsWith('.')) {
          target = path.resolve(path.dirname(sourcePath), specifier);
          if (target === path.join(fixtureRoot, 'app/lib/workspaces/request-principal')) target = principalPath;
          if (target === path.join(fixtureRoot, 'app/lib/collaboration/native-session-state-reader')) target = readerPath;
        } else if (specifier === 'next/server' && copy === 'B') target = alternateNextPath;
        if (target === specifier) return literal;
        const replacement = `${quote}${target}${quote}`; bindings.push([literal, replacement]); return replacement;
      });
      assert(bindings.length > 0);
      let reversed = changed;
      for (const [original, bound] of bindings) reversed = reversed.replace(bound, original);
      assert.equal(reversed, original, `Only counted import bindings may change ${relative}.`);
      await writeFile(destination, changed, { flag: 'wx', mode: 0o600 });
    }
  }
  const legacyPath = path.join(root, 'actual-pre-broker-transport.ts');
  const legacyOriginal = execFileSync('git', ['show', '7202b4f86ac60eee9b7012b619caac332090c70b:app/lib/collaboration/authenticated-native-session-transport.ts'],
    { cwd: fixtureRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const legacyBindings: Array<readonly [string, string]> = [];
  const legacySource = legacyOriginal.replace(/(?<=from |import\()(['"])(\.[^'"]+)\1/gu, (literal, quote: string, specifier: string) => {
    const target = path.resolve(fixtureRoot, 'app/lib/collaboration', specifier), replacement = `${quote}${target}${quote}`;
    legacyBindings.push([literal, replacement]); return replacement;
  });
  let legacyReversed = legacySource;
  for (const [original, bound] of legacyBindings) legacyReversed = legacyReversed.replace(bound, original);
  assert.equal(legacyReversed, legacyOriginal);
  await writeFile(legacyPath, legacySource, { flag: 'wx', mode: 0o600 });
  return { root, requests: { A: NextRequest, B: alternateNext },
    load: async (copy: 'A' | 'B') => await import(pathToFileURL(paths[copy]).href) as TransportModule,
    loadLegacy: async () => await import(pathToFileURL(legacyPath).href) as TransportModule,
    principalError: async (copy: 'A' | 'B') => (await import(pathToFileURL(path.join(root, `principal-${copy}.ts`)).href)).WorkspaceRequestPrincipalError as typeof import('../app/lib/workspaces/request-principal').WorkspaceRequestPrincipalError };
}

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
async function worker(order: 'A' | 'B'): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost','127.0.0.1'].includes(url.hostname));
  assert.equal(url.port,'55433'); assert.equal(url.pathname,'/canvas_notebook'); assert.equal(url.search,'');
  const schema = `native_broker_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_broker_[a-f0-9]{32}$/u);
  const workspaceId = `native-transport-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-broker-access-'));
  const copies = await sourceCopies();
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
      // Only the historical public-scanning block is scoped to this UUID fixture.
      let ownSql = sql;
      if (sql.trim().startsWith('DO $main_agent_id_migration$')) {
        assert(sql.trim().endsWith('$main_agent_id_migration$;'));
        assert.equal(sql.split("table_schema = 'public'").length - 1, 2);
        ownSql = sql.replaceAll("table_schema = 'public'", `table_schema = '${schema}'`);
        assert.equal(ownSql.replaceAll(`table_schema = '${schema}'`, "table_schema = 'public'"), sql);
      }
      const result = await admin.query(ownSql,values); await own(admin); return result;
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
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!,process.env.CANVAS_INSTANCE_ID!)).ok,true);
    const license = await getLicenseStatus(); assert.equal(license.licensed,true); assert.equal(license.edition,'team'); assert.equal(license.seatLimit,2);
    const { auth } = await import('../app/lib/auth');
    const ownerModule = await copies.load(order), peerModule = await copies.load(order === 'A' ? 'B' : 'A');
    const A = order === 'A' ? ownerModule : peerModule, B = order === 'B' ? ownerModule : peerModule;
    const { withAuthenticatedNativeSessionTransportOnConnection:phase,
      disposeAuthenticatedNativeSessionTransport:dispose } = A;
    const { createPlainTextYDoc,createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const request = async (userId='owner',cookie=false,copy:'A'|'B'='A') => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if(cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[userId],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[userId]}`);
      return new copies.requests[copy]('http://localhost/api/files/collaboration/session',{method:'POST',headers});
    };
    const transaction = async <T>(operation:(db:SqlConnection,client:Client)=>Promise<T>,begin='BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') => {
      const client=await ownClient();await client.query(begin);
      try{return await operation(connection(client),client);}
      finally{await client.query('ROLLBACK').catch(()=>undefined);await endClient(client);}
    };
    const check=async(name:string,operation:()=>Promise<void>)=>{stage=name;await operation();cases++;console.log(`Native broker ${order}-first passed: ${name}`);};
    const code=(expected:string)=>(error:unknown)=>{
      const actual=error&&typeof error==='object'?Reflect.get(error,'code'):undefined;
      if(actual!==expected)console.log('Expected fixture error code differed:',{expected,actualCode:typeof actual==='string'?actual.slice(0,128):null});
      return actual===expected;
    };
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
    const native=await seed(`native-${crypto.randomUUID()}`);
    const captured=async(userId='owner',permission:'canRead'|'canWrite'='canWrite',cookie=false,copy:'A'|'B'='A')=>
      transaction(db=>request(userId,cookie,copy).then(actual=>(copy==='A'?A:B).captureAuthenticatedNativeSessionTransportOnConnection(db,actual,{workspaceId,maxPermission:permission})));
    const read=async<T>(transport:AuthenticatedNativeSessionTransport,consumer:(native:ExistingNativeCollaborationSession,access:ExistingNativeSessionRequestAccess)=>Promise<T>,
      permission:'canRead'|'canWrite'='canRead')=>transaction(db=>phase(db,transport,{permission,...input(native.identity)},consumer));
    const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
    const bounded=async(promise:Promise<void>)=>{let timer!:ReturnType<typeof setTimeout>;try{
      await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture phase did not enter within eight seconds.')),8000);})]);
    }finally{clearTimeout(timer);}};

    const foreignPrincipalBusy = async (expectRed: boolean) => {
      const target = await seed(`foreign-principal-${crypto.randomUUID()}`), before = await stored(target.identity);
      const { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
      const OwnerError = await copies.principalError(order), cap = await captured();
      const holder = await ownClient(); await holder.query('BEGIN'); await holder.query('LOCK TABLE collaboration_yjs_states IN ACCESS EXCLUSIVE MODE');
      const actualQuery = Client.prototype.query; let released = false, rollbacks = 0, failures = 0;
      try {
        await assert.rejects(transaction(db => B.withAuthenticatedNativeSessionTransportOnConnection(db, cap,
          { permission: 'canRead', ...input(target.identity) }, async () => assert.fail())), error => {
          assert(error instanceof OwnerError); assert.equal(error instanceof WorkspaceRequestPrincipalError, false);
          return code('PRINCIPAL_BUSY')(error);
        });
        await dispose(cap);
        process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
        const { POST } = await import('../app/api/files/collaboration/session/route');
        // Exact SQL/protocol responses pass through. Release only after the actual service ROLLBACK resolves.
        Client.prototype.query = function (this: Client, ...args: unknown[]) {
          const result = Reflect.apply(actualQuery, this, args);
          const sql = typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'text'));
          const owned = this !== admin && this !== control && this !== holder
            && String(Reflect.get(Reflect.get(this, 'connectionParameters'), 'options')).includes(schema);
          if (!owned || args.some(argument => typeof argument === 'function')) return result;
          return Promise.resolve(result).then(async value => {
            if (sql === 'ROLLBACK') { rollbacks++; if (!released) { released = true; await holder.query('ROLLBACK'); } }
            return value;
          }, error => { if (error && typeof error === 'object' && Reflect.get(error, 'code') === '55P03') failures++; throw error; });
        } as typeof Client.prototype.query;
        const actual = await request('owner', true), headers = new Headers(actual.headers); headers.set('content-type', 'application/json');
        const response = await POST(new NextRequest('http://localhost/api/files/collaboration/session', { method: 'POST', headers,
          body: JSON.stringify({ path: target.identity.path, provider: 'yjs', representation: 'plain_text' }) }));
        const wire = await response.json() as Record<string, unknown>;
        assert.equal(response.status, expectRed ? 409 : 200, JSON.stringify({ status: response.status, code: wire.code }));
        assert.equal(failures, 1); assert.equal(rollbacks, 1); assert(released);
        if (expectRed) { assert.equal(wire.code, 'PRINCIPAL_BUSY'); assert.equal(Object.hasOwn(wire, 'token'), false); }
        else { assert.equal(wire.documentId, target.identity.documentId); assert.equal(wire.lifecycleGeneration, 1);
          assert.equal(wire.documentSequence, 7); assert.equal(wire.stateProof, target.proof); }
        assert.deepEqual(await stored(target.identity), before);
        console.log(`Foreign genuine Principal ${order}-first Web POST: ${response.status}; exactly one actual 55P03/ROLLBACK, identity unchanged.`);
      } finally { Client.prototype.query = actualQuery; if (!released) await holder.query('ROLLBACK'); await endClient(holder); await dispose(cap); }
    };
    if (process.argv[3] === '--foreign-busy-red') { await check('actual foreign Principal Busy lost retry before predicate bridge', () => foreignPrincipalBusy(true)); return; }

    await check('shared frozen methods-only owner and Error identity across genuine module/NextRequest brands', async () => {
      assert.notEqual(A.captureAuthenticatedNativeSessionTransportOnConnection, B.captureAuthenticatedNativeSessionTransportOnConnection);
      assert.equal(A.AuthenticatedNativeSessionTransportError, B.AuthenticatedNativeSessionTransportError);
      const slot = Object.getOwnPropertyDescriptor(globalThis, runtimeKey); assert(slot);
      assert.equal(slot.configurable, false); assert.equal(slot.writable, false);
      const api = slot.value; assert(Object.isFrozen(api));
      assert.deepEqual(Object.keys(api).sort(), ['kind', 'version', 'Error',
        'captureAuthenticatedNativeSessionTransportOnConnection', 'withAuthenticatedNativeSessionTransportOnConnection',
        'withAuthenticatedNativeSessionDiagnosisTransportOnConnection', 'withAuthenticatedNativeSessionReadJoinTransportOnConnection',
        'isAuthenticatedNativeSessionTransportBusy', 'withAuthenticatedOwnedNativeSessionTransportOnConnection',
        'disposeAuthenticatedNativeSessionTransport', 'assertCurrent', 'inspect', 'isReaderError', 'isPrincipalError',
        'createAuthenticatedNativePeerOrigin', 'adoptAuthenticatedNativePeerOrigin',
        'captureAuthenticatedNativePeerOriginTransportOnConnection', 'withAuthenticatedNativePeerOriginJoinOnConnection',
        'retireAuthenticatedNativePeerOriginAttempt', 'finishAuthenticatedNativePeerOrigin', 'disposeAuthenticatedNativePeerOrigin'].sort());
      assert(Object.values(api).every(value => typeof value === 'function' || typeof value === 'string' || typeof value === 'number'));
      const error = new A.AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_REQUIRED');
      assert(error instanceof B.AuthenticatedNativeSessionTransportError);
      for (const copy of ['A', 'B'] as const) for (const cookie of [false, true]) {
        const actual = await request('owner', cookie, copy);
        assert(actual instanceof copies.requests[copy]);
        assert.equal(actual instanceof copies.requests[copy === 'A' ? 'B' : 'A'], false);
        assert.equal((await auth.api.getSession({ headers: actual.headers }))?.session.id, 'session-owner');
        const cap = await captured('owner', 'canWrite', cookie, copy);
        assert.deepEqual(Reflect.ownKeys(cap), []); assert(Object.isFrozen(cap));
        const other = copy === 'A' ? B : A;
        await transaction(db => other.withAuthenticatedNativeSessionTransportOnConnection(db, cap,
          { permission: 'canWrite', ...input(native.identity) }, async (doc, access) => {
            assert.equal(doc.snapshot.stateProof, native.proof); assert.equal(access.sessionId, 'session-owner');
            await other.assertAuthenticatedNativeSessionCurrentOnConnection(db, doc);
            assert.equal(other.inspectAuthenticatedNativeSessionOnConnection(db, doc, state => state.content.kind), 'plain_text');
            await access.assertCurrent();
          }));
        await other.disposeAuthenticatedNativeSessionTransport(cap);
      }
    });
    await check('real Request intrinsics reject fabricated brands/getters and copy immutable issued credentials before await', async () => {
      let getterCalls = 0;
      const fake = Object.create(copies.requests.B.prototype);
      Object.defineProperties(fake, { url: { get() { getterCalls++; throw new Error('fake getter'); } },
        method: { get() { getterCalls++; throw new Error('fake getter'); } },
        headers: { get() { getterCalls++; throw new Error('fake getter'); } } });
      for (const supplied of [{}, fake, new NextRequest('http://localhost')]) {
        await transaction(async db => {
          let queries = 0; const observed: SqlConnection = { ...db, get: async (sql, values) => { queries++; return db.get(sql, values); } };
          await assert.rejects(B.captureAuthenticatedNativeSessionTransportOnConnection(observed, supplied as NextRequest,
            { workspaceId, maxPermission: 'canRead' }), code('NATIVE_TRANSPORT_INVALID'));
          assert.equal(queries, 0);
        });
      }
      assert.equal(getterCalls, 0);
      const actual = await request('owner', true, 'B');
      const cap = await transaction(db => {
        const pending = B.captureAuthenticatedNativeSessionTransportOnConnection(db, actual, { workspaceId, maxPermission: 'canWrite' });
        actual.headers.set('cookie', 'invalid'); actual.headers.set('x-canvas-workspace-id', 'invalid'); return pending;
      });
      await read(cap, async (_doc, access) => { assert.equal(access.sessionId, 'session-owner'); await access.assertCurrent(); });
      await dispose(cap);
    });
    await check('owner-reader bridges recognize real missing/quarantined errors from the other reader instance', async () => {
      for (const reason of ['missing', 'quarantined'] as const) {
        const target = await seed(`reader-${crypto.randomUUID()}`);
        if (reason === 'missing') await admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId]);
        else await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [target.identity.documentId]);
        const cap = await captured('owner', 'canRead', false, 'B');
        await assert.rejects(transaction(db => A.withAuthenticatedNativeSessionTransportOnConnection(db, cap,
          { permission: 'canRead', ...input(target.identity) }, async () => assert.fail())), error => {
          assert(A.isAuthenticatedNativeSessionReaderError(error)); assert(B.isAuthenticatedNativeSessionReaderError(error));
          return code(reason === 'missing' ? 'NATIVE_SESSION_STATE_MISSING' : 'NATIVE_SESSION_QUARANTINED')(error);
        });
        await B.disposeAuthenticatedNativeSessionTransport(cap);
      }
    });
    await check('both typed read joins and genuine fixed-read quarantine diagnosis work across owners without write authority', async () => {
      const target = await seed(`quarantine-${crypto.randomUUID()}`);
      await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [target.identity.documentId]);
      for (const identity of [native.identity, target.identity]) {
        const cap = await captured('member', 'canRead', true, 'B');
        await transaction(db => A.withAuthenticatedNativeSessionReadJoinTransportOnConnection(db, cap, { path: identity.path }, async (doc, access) => {
          assert.equal(doc.snapshot.documentId, identity.documentId); assert.equal(access.workspace.permissions.canWrite, false); await access.assertCurrent();
        }));
        if (identity === target.identity) await transaction(db => B.withAuthenticatedNativeSessionDiagnosisTransportOnConnection(db, cap,
          input(identity), async (diagnosis, access) => { assert.equal(diagnosis.permission, 'read'); assert.equal(diagnosis.snapshot.documentId, identity.documentId); await access.assertCurrent(); }));
        await assert.rejects(transaction(db => A.withAuthenticatedNativeSessionTransportOnConnection(db, cap,
          { permission: 'canWrite', ...input(identity) }, async () => assert.fail())), code('NATIVE_TRANSPORT_ACCESS_DENIED'));
        await A.disposeAuthenticatedNativeSessionTransport(cap);
      }
    });
    await check('plain/cloned/foreign-looking capabilities cannot be adopted by either module', async () => {
      const cap = await captured();
      for (const fake of [{}, { ...cap }, structuredClone(cap), Object.freeze({ original: 'must-not-be-authority' })]) {
        await assert.rejects(transaction(db => B.withAuthenticatedNativeSessionTransportOnConnection(db, fake as AuthenticatedNativeSessionTransport,
          { permission: 'canRead', ...input(native.identity) }, async () => assert.fail())), code('NATIVE_TRANSPORT_REQUIRED'));
        await assert.rejects(B.disposeAuthenticatedNativeSessionTransport(fake as AuthenticatedNativeSessionTransport), code('NATIVE_TRANSPORT_REQUIRED'));
      }
      await read(cap, async (_doc, access) => { await access.assertCurrent(); }); await dispose(cap);
    });
    await check('a genuine legacy-factory cap from a foreign private registry is rejected without snapshot remint', async () => {
      const legacy = await copies.loadLegacy();
      const cap = await transaction(async db => legacy.captureAuthenticatedNativeSessionTransportOnConnection(db, await request(),
        { workspaceId, maxPermission: 'canRead' }));
      try {
        await transaction(db => legacy.withAuthenticatedNativeSessionTransportOnConnection(db, cap,
          { permission: 'canRead', ...input(native.identity) }, async doc => { assert.equal(doc.snapshot.stateProof, native.proof); }));
        await assert.rejects(transaction(db => B.withAuthenticatedNativeSessionTransportOnConnection(db, cap,
          { permission: 'canRead', ...input(native.identity) }, async () => assert.fail())), code('NATIVE_TRANSPORT_REQUIRED'));
        await assert.rejects(A.disposeAuthenticatedNativeSessionTransport(cap), code('NATIVE_TRANSPORT_REQUIRED'));
      } finally { await legacy.disposeAuthenticatedNativeSessionTransport(cap); }
    });
    await check('other-module disposal remains sticky and never remints the original request', async () => {
      const cap = await captured('owner', 'canRead', false, 'B'); await A.disposeAuthenticatedNativeSessionTransport(cap);
      await B.disposeAuthenticatedNativeSessionTransport(cap);
      await assert.rejects(read(cap, async () => assert.fail()), code('NATIVE_TRANSPORT_DISPOSED'));
      await assert.rejects(transaction(db => B.withAuthenticatedNativeSessionReadJoinTransportOnConnection(db, cap,
        { path: native.identity.path }, async () => assert.fail())), code('NATIVE_TRANSPORT_DISPOSED'));
    });
    await check('retained native/access facades expire and poison a fresh successor across module instances', async () => {
      const oldCap = await captured(), nextCap = await captured('owner', 'canRead', false, 'B');
      let retained!: ExistingNativeCollaborationSession, access!: ExistingNativeSessionRequestAccess;
      await transaction(async db => {
        await phase(db, oldCap, { permission: 'canRead', ...input(native.identity) }, async (doc, currentAccess) => { retained = doc; access = currentAccess; });
        await assert.rejects(B.assertAuthenticatedNativeSessionCurrentOnConnection(db, retained), error => B.isAuthenticatedNativeSessionReaderError(error) && code('NATIVE_SESSION_REQUIRED')(error));
      });
      await assert.rejects(transaction(db => B.withAuthenticatedNativeSessionTransportOnConnection(db, nextCap,
        { permission: 'canRead', ...input(native.identity) }, async () => { assert.throws(() => access.workspace, code('NATIVE_TRANSPORT_REQUIRED')); })), code('NATIVE_TRANSPORT_REQUIRED'));
      await dispose(oldCap); await B.disposeAuthenticatedNativeSessionTransport(nextCap);
    });
    await check('caught cross-module same-cap and same-connection reentrancy poison the genuine phase', async () => {
      for (const mode of ['same-cap', 'same-connection'] as const) {
        const cap = await captured(), otherCap = await captured('owner', 'canRead', false, 'B');
        await assert.rejects(transaction(db => phase(db, cap, { permission: 'canRead', ...input(native.identity) }, async () => {
          const attempt = (other: SqlConnection) => B.withAuthenticatedNativeSessionTransportOnConnection(other, mode === 'same-cap' ? cap : otherCap,
            { permission: 'canRead', ...input(native.identity) }, async () => assert.fail());
          await assert.rejects(mode === 'same-cap' ? transaction(attempt) : attempt(db), code('NATIVE_TRANSPORT_REENTRANT'));
        })), code('NATIVE_TRANSPORT_REENTRANT'));
        await dispose(cap); await B.disposeAuthenticatedNativeSessionTransport(otherCap);
      }
    });
    await check('detached genuine callback checks are drained and poison through the other module', async () => {
      const cap = await captured('owner', 'canRead', false, 'B'); let settled = false;
      await assert.rejects(read(cap, async (_doc, access) => {
        void access.assertCurrent().then(() => { settled = true; }, () => { settled = true; }); return 'not-published';
      }), code('NATIVE_TRANSPORT_DETACHED'));
      assert(settled); await assert.rejects(transaction(db => B.withAuthenticatedNativeSessionReadJoinTransportOnConnection(db, cap,
        { path: native.identity.path }, async () => assert.fail())), code('NATIVE_TRANSPORT_DETACHED')); await dispose(cap);
    });
    await check('other-module dispose immediately invalidates and awaits the whole actual callback', async () => {
      const cap = await captured(), entered = gate(), release = gate(); let closed = false;
      const pending = read(cap, async () => { entered.resolve(); await release.promise; return 'not-published'; });
      const rejected = assert.rejects(pending, code('NATIVE_TRANSPORT_DISPOSED')); let closing!: Promise<void>;
      try { await bounded(entered.promise); closing = B.disposeAuthenticatedNativeSessionTransport(cap).then(() => { closed = true; });
        await new Promise<void>(done => setImmediate(done)); assert.equal(closed, false); }
      finally { release.resolve(); await rejected; }
      await closing; assert(closed);
    });
    await check('cross-module self-disposal rejects instead of deadlocking the shared callback context', async () => {
      const cap = await captured(); await assert.rejects(read(cap, async () => {
        await assert.rejects(B.disposeAuthenticatedNativeSessionTransport(cap), code('NATIVE_TRANSPORT_REENTRANT'));
      }), code('NATIVE_TRANSPORT_DISPOSED')); await dispose(cap);
    });
    await check('actual path/native identity and full original workspace root/search-path remain bound across modules', async () => {
      for (const mode of ['native', 'root', 'realm'] as const) {
        const cap = await captured('owner', 'canRead', false, 'B');
        if (mode === 'root') await admin.query('UPDATE canvas_workspaces SET root_relative_path=$2 WHERE id=$1', [workspaceId, 'organizations/principal-org/changed']);
        try {
          await assert.rejects(transaction(async (db, client) => {
            if (mode === 'realm') await client.query(`SET LOCAL search_path=${schema},public,pg_catalog`);
            return A.withAuthenticatedNativeSessionTransportOnConnection(db, cap, { permission: 'canRead',
              ...input(mode === 'native' ? { ...native.identity, documentId: `wrong-${crypto.randomUUID()}` } : native.identity) }, async () => assert.fail());
          }), code(mode === 'native' ? 'NATIVE_SESSION_SCOPE_CHANGED' : mode === 'realm' ? 'PRINCIPAL_SCOPE_CHANGED' : 'NATIVE_TRANSPORT_SCOPE_CHANGED'));
        } finally { if (mode === 'root') await admin.query('UPDATE canvas_workspaces SET root_relative_path=$2 WHERE id=$1', [workspaceId, 'organizations/principal-org/shared']); await dispose(cap); }
      }
    });
    await check('actual session revocation poisons the shared transport without fresh authority from its other copy', async () => {
      const cap = await captured('owner', 'canRead', true, 'B');
      await admin.query('UPDATE "session" SET expires_at=$1 WHERE id=$2', [Date.now() - 1, 'session-owner']);
      try { await assert.rejects(read(cap, async () => assert.fail()), code('PRINCIPAL_AUTH_REVOKED'));
        await assert.rejects(transaction(db => B.withAuthenticatedNativeSessionReadJoinTransportOnConnection(db, cap,
          { path: native.identity.path }, async () => assert.fail())), code('PRINCIPAL_AUTH_REVOKED'));
      } finally { await seedSession(); await dispose(cap); }
    });
    await check('same named schema with a different genuine OID cannot reset origin at the final owner binding', async () => {
      const cap = await captured('owner', 'canRead', false, 'B'); let changed = false, bindings = 0;
      try {
        await assert.rejects(transaction((db, client) => {
          const actual: SqlConnection = { ...db, get: async (sql, values) => {
            if (sql.includes('to_regnamespace(current_schema())') && ++bindings === 3) {
              changed = true; await client.query(`ALTER SCHEMA "${schema}" RENAME TO "${schema}_old"`);
              await client.query(`CREATE SCHEMA "${schema}"`);
              await client.query(`ALTER TABLE "${schema}_old".canvas_workspaces SET SCHEMA "${schema}"`);
            }
            return db.get(sql, values);
          } };
          return B.withAuthenticatedNativeSessionTransportOnConnection(actual, cap,
            { permission: 'canRead', ...input(native.identity) }, async () => 'not-published');
        }), code('NATIVE_TRANSPORT_SCOPE_CHANGED'));
        assert(changed); assert.equal(bindings, 3);
      } finally { await dispose(cap); }
    });
    await check('genuine SQL owner fence and fixed write Final are preserved through the other module', async () => {
      const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
      const ownerClient = await ownClient(), owner = await createCollaborationRoomOwnerSession(ownerClient);
      const { lineageId: _lineage, ...scope } = native.identity; const fence = await owner.acquire(scope);
      const before = await stored(native.identity), cap = await captured('member', 'canRead', false, 'B');
      try {
        let retained!: import('../app/lib/collaboration/authenticated-native-session-transport').AuthenticatedOwnedNativeSessionAccess;
        await transaction(db => A.withAuthenticatedOwnedNativeSessionTransportOnConnection(db, cap,
          { permission: 'canRead', identity: native.identity, ownerFence: fence }, async access => {
            retained = access; assert.equal(access.documentSequence, 7); await access.assertCurrent();
          }));
        assert.throws(() => retained.workspace, code('NATIVE_TRANSPORT_REQUIRED'));
        await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
        const writer = await captured('member', 'canWrite', false, 'B');
        try { await assert.rejects(transaction((db, client) => B.withAuthenticatedOwnedNativeSessionTransportOnConnection(db, writer,
          { permission: 'canWrite', identity: native.identity, ownerFence: fence }, async access => {
            assert(access.workspace.permissions.canWrite);
            await client.query('UPDATE collaboration_yjs_states SET document_sequence=document_sequence+1 WHERE document_id=$1', [native.identity.documentId]);
            await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'"); return 'not-published';
          })), code('PRINCIPAL_ACCESS_DENIED'));
          assert.deepEqual(await stored(native.identity), before);
        } finally { await dispose(writer); await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'"); }
        await owner.release(fence);
        const lost = await captured('owner', 'canRead', false, 'B');
        try { await assert.rejects(transaction(db => A.withAuthenticatedOwnedNativeSessionTransportOnConnection(db, lost,
          { permission: 'canRead', identity: native.identity, ownerFence: fence }, async () => assert.fail())), code('ROOM_OWNER_LOST')); }
        finally { await dispose(lost); }
      } finally { await dispose(cap); await owner.close(); clients.delete(ownerClient); }
    });
    await check('genuine overlapping owner-authorization Busy has shared unforgeable identity and permits a fresh phase', async () => {
      const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
      const target = await seed(`owner-busy-${crypto.randomUUID()}`);
      const ownerClient = await ownClient(), owner = await createCollaborationRoomOwnerSession(ownerClient);
      const { lineageId: _lineage, ...scope } = target.identity; const fence = await owner.acquire(scope);
      const first = await captured(), second = await captured('owner', 'canWrite', false, 'B');
      const entered = gate(), release = gate(), ready = gate(); let arrivals = 0, calls = 0;
      const observe = (cap: AuthenticatedNativeSessionTransport, later: boolean) => transaction(db => {
        let gated = false;
        const actual: SqlConnection = { ...db, get: async (sql, values) => {
          if (!gated && sql.includes("current_setting('session_replication_role')")) {
            gated = true; if (++arrivals === 2) ready.resolve(); await bounded(ready.promise); if (later) await bounded(entered.promise);
          }
          return db.get(sql, values);
        } };
        return (later ? B : A).withAuthenticatedOwnedNativeSessionTransportOnConnection(actual, cap,
          { permission: 'canWrite', identity: target.identity, ownerFence: fence }, async access => {
            if (later) calls++; else { entered.resolve(); await bounded(release.promise); } await access.assertCurrent();
          });
      });
      try {
        const holding = observe(first, false), attempted = observe(second, true);
        try { await bounded(entered.promise); await assert.rejects(attempted, error => {
          assert(A.isAuthenticatedNativeSessionTransportBusy(error)); assert(B.isAuthenticatedNativeSessionTransportBusy(error)); return true;
        }); assert.equal(calls, 0); }
        finally { release.resolve(); await holding; }
        assert.equal(A.isAuthenticatedNativeSessionTransportBusy(new Error('The current peer authorization phase is busy.')), false);
        await transaction(db => A.withAuthenticatedOwnedNativeSessionTransportOnConnection(db, second,
          { permission: 'canWrite', identity: target.identity, ownerFence: fence }, async access => { calls++; await access.assertCurrent(); }));
        assert.equal(calls, 1);
      } finally { await dispose(first); await B.disposeAuthenticatedNativeSessionTransport(second); await owner.close(); clients.delete(ownerClient); }
    });
    await check('actual foreign-owner Principal Busy retries only after real rollback/disposal in the exported Web POST', () => foreignPrincipalBusy(false));
    assert.equal(fetches,0);
    console.log(`Authenticated native broker ${order}-first PG18: ${cases} genuine multi-module families passed.`);
  }finally{
    globalThis.fetch=originalFetch;
    try{if(pool)await pool.end();}finally{
      try{for(const client of clients)await client.end();}finally{
        try{if(created){await control.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed,true);}}
        finally{await control.end();await rm(dataRoot,{recursive:true,force:true});await rm(copies.root,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);}
      }
    }
  }
}

async function incompatible(kind: string): Promise<void> {
  const copies = await sourceCopies(); let calls = 0;
  // Transitive Auth imports receive only this private DATA and a nonexistent UUID search-path namespace.
  // No principal/auth callback or SQL is entered in these bootstrap-only negative cases.
  const config = parse(await readFile(privateEnvironment, 'utf8')); assert(config.DATABASE_URL);
  Object.assign(process.env, { DATA: copies.root, CANVAS_DATA_ROOT: copies.root, DATABASE_URL: config.DATABASE_URL,
    CANVAS_DATABASE_PROVIDER: 'postgres', PGOPTIONS: `-c search_path=native_broker_absent_${crypto.randomUUID().replaceAll('-', '')},pg_catalog`,
    CANVAS_MCP_DIRECT_ENABLED: 'false', BETTER_AUTH_BASE_URL: 'http://localhost', BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex') });
  const method = () => { calls++; throw new Error('An incompatible runtime must never be invoked.'); };
  const methods = ['captureAuthenticatedNativeSessionTransportOnConnection', 'withAuthenticatedNativeSessionTransportOnConnection',
    'withAuthenticatedNativeSessionDiagnosisTransportOnConnection', 'withAuthenticatedNativeSessionReadJoinTransportOnConnection',
    'isAuthenticatedNativeSessionTransportBusy', 'withAuthenticatedOwnedNativeSessionTransportOnConnection',
    'disposeAuthenticatedNativeSessionTransport', 'assertCurrent', 'inspect', 'isReaderError', 'isPrincipalError',
        'createAuthenticatedNativePeerOrigin', 'adoptAuthenticatedNativePeerOrigin',
        'captureAuthenticatedNativePeerOriginTransportOnConnection', 'withAuthenticatedNativePeerOriginJoinOnConnection',
        'retireAuthenticatedNativePeerOriginAttempt', 'finishAuthenticatedNativePeerOrigin', 'disposeAuthenticatedNativePeerOrigin'];
  const api = { kind: 'canvas-authenticated-native-session-runtime', version: kind === 'version' ? 2 : 3,
    Error: Error, ...Object.fromEntries(methods.map(name => [name, method])), ...(kind === 'extra' ? { records: new WeakMap() } : {}) };
  const value = kind === 'partial' ? Object.freeze({ kind: api.kind, version: 3 }) : kind === 'mutable' ? api : Object.freeze(api);
  Object.defineProperty(globalThis, runtimeKey, kind === 'accessor' ? { get() { calls++; return value; } }
    : { value, writable: false, configurable: false });
  const before = Object.getOwnPropertyDescriptor(globalThis, runtimeKey);
  try {
    await assert.rejects(copies.load('A'), error => error && typeof error === 'object' && Reflect.get(error, 'code') === 'NATIVE_RUNTIME_INCOMPATIBLE');
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, runtimeKey), before); assert.equal(calls, 0);
    console.log(`Native broker incompatible ${kind}: fail closed without resetting authority.`);
  } finally { const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    await (getPostgresRuntimeQueryable() as unknown as { end(): Promise<void> } | null)?.end();
    await rm(copies.root, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  const workerMode = process.argv[2];
  if (workerMode === '--owner=A' || workerMode === '--owner=B') return worker(workerMode.endsWith('A') ? 'A' : 'B');
  if (workerMode?.startsWith('--incompatible=')) return incompatible(workerMode.slice('--incompatible='.length));
  assert.equal(workerMode, undefined);
  // Immutable slots cannot be reset: separate, serial source-only processes test both real load orders.
  for (const mode of ['--owner=A', '--owner=B', ...['version', 'partial', 'mutable', 'accessor', 'extra'].map(kind => `--incompatible=${kind}`)]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, path.resolve(process.argv[1]), mode], { env: process.env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (status, signal) => status === 0 ? resolve() : reject(new Error(`Owned source child ${mode} failed (${status ?? signal}).`)));
    });
  }
  console.log('Native runtime broker: genuine PG/auth and exported POSTs in both load orders plus incompatible slots passed; no network host/build/browser execution.');
}
main().catch(error => {
  console.error('Owned native runtime broker fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    assertion: error && typeof error === 'object' ? Reflect.get(error, 'operator') ?? null : null });
  process.exitCode = 1;
});
