import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, type Pool, type PoolClient } from 'pg';
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
  const schema = `authenticated_http_busy_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^authenticated_http_busy_[a-f0-9]{32}$/u);
  const workspaceId = `native-auth-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-auth-native-busy-'));
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=authenticated-http-busy-fixture` });
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
      await own(admin);
      if (sql.trim().startsWith('DO $main_agent_id_migration$')) {
        assert(sql.trim().endsWith('$main_agent_id_migration$;'));
        assert.equal(sql.split('table_schema = current_schema()').length - 1, 2);
        assert.equal(sql.includes("table_schema = 'public'"), false);
      }
      try { const result = await admin.query(sql,values); await own(admin); return result; }
      catch (error) {
        if (error && typeof error === 'object' && Reflect.get(error, 'code') === '42P01') {
          Reflect.set(error, 'ownedMigrationCommand', sql.trim().split('\n')[0].slice(0, 160));
        }
        throw error;
      }
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
    const { withWorkspaceRequestPrincipal:capture, withWorkspaceRequestPrincipalOnConnection: principalPhase } = await import('../app/lib/workspaces/request-principal');
    const { createPlainTextYDoc,createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const request = async (userId='owner',cookie=false) => {
      const headers = new Headers({ 'x-canvas-workspace-id':workspaceId });
      if(cookie) headers.set('cookie',(await serializeSignedCookie('better-auth.session_token',tokens[userId],process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization',`Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/collaboration/session',{method:'POST',headers});
    };
    const check=async(name:string,operation:()=>Promise<void>)=>{if(process.argv[2]&&!name.includes(process.argv[2]))return;stage=name;await operation();cases++;console.log(`Authenticated native HTTP session passed: ${name}`);};
    const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&Reflect.get(error,'code')===expected;
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
    const { POST: webPost } = await import('../app/api/files/collaboration/session/route');
    const { POST: mobilePost } = await import('../app/api/mobile/v1/notebook/collaboration/session/route');
    const { withAuthenticatedTextCollaborationSessionGrant: publishGrant, isAuthenticatedTextSessionStartupRetryable,
      authenticatedTextSessionStartupDiagnostic } = await import('../app/lib/collaboration/authenticated-text-session-service');
    const { disposeAuthenticatedNativeSessionTransport: disposeTransport } = await import('../app/lib/collaboration/authenticated-native-session-transport');
    const { consumeMobileCollaborationTicket, disposeMobileCollaborationTickets } = await import('../app/lib/mobile/collaboration-ticket');
    const { parseCollaborationSessionRequest } = await import('../app/lib/collaboration/session-service');
    const capabilities = { richTextSchemaVersion: 3, blockTreeFormatVersion: 1 };
    type Surface = 'web' | 'mobile';
    const post = async (surface: Surface, file: string, extra: Record<string, unknown> = {}, userId = 'owner', cookie = false) => {
      const actual = await request(userId, cookie), headers = new Headers(actual.headers); headers.set('content-type', 'application/json');
      const body = { path: file, ...capabilities, ...(surface === 'web' ? { provider: 'yjs', representation: 'auto' } : {}), ...extra };
      const http = new NextRequest(`http://localhost/api/${surface === 'web' ? 'files' : 'mobile/v1/notebook'}/collaboration/session`, { method: 'POST', headers, body: JSON.stringify(body) });
      const response = await (surface === 'web' ? webPost : mobilePost)(http);
      const wire = await response.json() as Record<string, unknown>;
      assert.equal(Object.hasOwn(wire, 'retryable'), surface === 'web' && wire.retryable === true,
        'Only an actual web startup failure may publish the optional true marker.');
      if (surface === 'web' && response.status !== 200) assert.equal(response.headers.get('cache-control'), 'no-store');
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

    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('Owned genuine barrier did not settle within its phase deadline.')), 3500);
        resolve = () => { clearTimeout(timer); done(); };
      });
      void promise.catch(() => undefined);
      return { promise, resolve };
    };
    const rawQuery = Client.prototype.query;
    const text = (args: unknown[]) => typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'text'));
    const ownRuntime = (client: Client) => client !== admin && client !== control && String(Reflect.get(Reflect.get(client, 'connectionParameters'), 'options')).includes(schema);
    const schemaShare = (sql: string) => sql.startsWith('LOCK TABLE ') && sql.includes('canvas_organization_settings')
      && sql.includes('organization_user_permissions') && sql.endsWith('IN SHARE MODE NOWAIT');
    const schemaConflict = () => new Set<number>();
    const finalReceiptQuery = (sql: string) => sql.includes('d.state_version>=y.checkpoint_sequence');
    const authCurrentQuery = (sql: string) => sql.includes("encode(sha256(convert_to(s.token,'UTF8'))");
    const raiseActualBusy = (client: Client) => Reflect.apply(rawQuery, client,
      ["DO $$ BEGIN RAISE EXCEPTION 'Owned genuine final lock conflict' USING ERRCODE='55P03'; END $$"]);
    // Observe actual pg promises on caller-owned B only. Pool.query's callback
    // form must pass through unchanged; it is not a transaction acknowledgement.
    const observeTransactions = (observe: (client: Client, sql: string, result: Promise<unknown>, ordinal: number) => Promise<unknown>) => {
      const ordinals = new Map<Client, number>(); let count = 0;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = text(args), result = Reflect.apply(rawQuery, this, args);
        if (!ownRuntime(this) || args.some(argument => typeof argument === 'function')) return result;
        if (sql === 'BEGIN') ordinals.set(this, 0); // Core/setup TX observed, never charged as a service read phase.
        else if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') ordinals.set(this, ++count);
        const ordinal = ordinals.get(this);
        return ordinal === undefined ? result : observe(this, sql, Promise.resolve(result), ordinal);
      } as typeof Client.prototype.query;
      return { begins: () => count, restore: () => { Client.prototype.query = rawQuery; } };
    };
    const observeTransports = () => {
      const originalSet = WeakMap.prototype.set, records: object[] = [];
      WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
        if (value && typeof value === 'object') {
          const fields = Object.getOwnPropertyDescriptors(value);
          if (fields.workspaceId?.value === workspaceId && typeof fields.maxPermission?.value === 'string'
            && typeof fields.disposed?.value === 'boolean') records.push(value);
        }
        return Reflect.apply(originalSet, this, [key, value]);
      } as typeof WeakMap.prototype.set;
      return { records, restore: () => { WeakMap.prototype.set = originalSet; }, assertDisposed: () => {
        for (const record of records) { assert.equal(Reflect.get(record, 'disposed'), true); assert.equal(Reflect.get(record, 'original'), undefined); }
      } };
    };
    // Principal readers now coexist. Genuine authorization writers must still
    // conflict: authenticate first, then hold an actual leaf-table writer lock.
    // This avoids blocking the next request's outside-B bootstrap writes to
    // organization settings/user rows; no Principal grant is cached or reused.
    const startAuthorizationWriter = async () => {
      const ready = deferred(), release = deferred(); let factoryEntries = 0, acquired = false;
      let peerClient!: Client;
      const done = capture(await request(), { permission: 'canWrite', workspaceId }, async () => {
        factoryEntries++;
        peerClient = await ownClient(); await peerClient.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        try {
          await peerClient.query('LOCK TABLE organization_user_permissions IN ROW EXCLUSIVE MODE');
          acquired = true; ready.resolve(); await release.promise;
        } finally { await peerClient.query('ROLLBACK').catch(() => undefined); await endClient(peerClient); }
      });
      void done.catch(() => ready.resolve());
      await ready.promise;
      if (!acquired) await done;
      assert(acquired, 'The genuine authorization writer must acquire its actual table lock.');
      return { client: peerClient, release: release.resolve, done, factoryEntry: () => factoryEntries };
    };
    stage = 'genuine original-auth initialization before owned lock holders';
    await capture(await request(), { permission: 'canWrite', workspaceId }, async () => undefined);
    await check('startup hints reject forged identities and diagnostics contain finite metadata only', async () => {
      const { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
      let getterRead = false;
      for (const error of [undefined, null, false, 409, 'PRINCIPAL_BUSY', new WorkspaceRequestPrincipalError('PRINCIPAL_BUSY'),
        Object.assign(new Error('private/path/session-token/raw SQL'), { code: 'PRINCIPAL_BUSY', retryable: true }),
        Object.freeze(Object.assign(new Error('private/path/session-token/raw SQL'), { code: 'PRINCIPAL_NEW_PRIVATE/path' })),
        Object.defineProperty(new Error('private/path/session-token/raw SQL'), 'code', { get: () => { getterRead = true; return 'PRINCIPAL_BUSY'; } }),
        new Proxy(new Error('private/path/session-token/raw SQL'), { getOwnPropertyDescriptor() { throw new Error('private descriptor trap'); } })]) {
        assert.equal(isAuthenticatedTextSessionStartupRetryable(error), false);
        const diagnostic = authenticatedTextSessionStartupDiagnostic(error);
        assert.deepEqual(Object.keys(diagnostic), ['event', 'phase', 'code', 'retryable']);
        assert.equal(diagnostic.event, 'collaboration_session_startup_failed'); assert.equal(diagnostic.phase, 'unknown');
        assert(['unknown', 'PRINCIPAL_BUSY'].includes(diagnostic.code)); assert.equal(diagnostic.retryable, false);
        assert.equal(/private|path|session-token|raw SQL/u.test(JSON.stringify(diagnostic)), false);
      }
      assert.equal(getterRead, false);
    });
    await check('two genuine Principal B phases coexist with actual schema and row SHARE locks', async () => {
      const minted = deferred(), locked = deferred();
      let captures = 0, locks = 0, callbacks = 0;
      const sqlCodes: string[] = [];
      const execute = async () => capture(await request(), { permission: 'canWrite', workspaceId }, async principal => {
        if (++captures === 2) minted.resolve(); await minted.promise;
        const client = await ownClient(); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        const base = connection(client);
        try {
          await principalPhase({ ...base, run: async (sql, values) => {
            try {
              const result = await base.run(sql, values);
              if (schemaShare(sql)) { if (++locks === 2) locked.resolve(); await locked.promise; }
              return result;
            } catch (error) { if (Reflect.get(error as object, 'code') === '55P03') sqlCodes.push('55P03'); throw error; }
          } }, principal, async () => { callbacks++; });
        } finally { await client.query('ROLLBACK'); await endClient(client); }
      });
      const outcomes = await Promise.allSettled([execute(), execute()]);
      const failed = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      assert.equal(captures, 2); assert.equal(locks, 2); assert.equal(callbacks, 2);
      assert.deepEqual(sqlCodes, []); assert.equal(failed.length, 0);
    });
    await check('transient actual HTTP contention rolls back and closes before fresh retry, same native identity', async () => {
      for (const surface of ['web', 'mobile'] as const) {
        const target = await seed(`transient-${surface}`), before = await stored(target.identity), peer = await startAuthorizationWriter();
        const failed = schemaConflict(), closed = new Set<number>(); let rollback = 0, begins = 0;
        const releaseListener = (_error: unknown, client: PoolClient) => { if (failed.has(Number(Reflect.get(client, 'processID')))) closed.add(Number(Reflect.get(client, 'processID'))); };
        (runtime as unknown as Pool).on('release', releaseListener);
        Client.prototype.query = function (this: Client, ...args: unknown[]) {
          const sql = text(args), result = Reflect.apply(rawQuery, this, args), pid = Number(Reflect.get(this, 'processID'));
          if (!ownRuntime(this) || this === peer.client) return result;
          if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') { if (++begins === 2) assert.equal(closed.size, 1, 'failed lease closed before a fresh B'); }
          return Promise.resolve(result).catch(error => { if (Reflect.get(error as object, 'code') === '55P03') failed.add(pid); throw error; }).then(async value => {
            if (sql === 'ROLLBACK' && failed.has(pid)) { rollback++; peer.release(); await peer.done; }
            return value;
          });
        } as typeof Client.prototype.query;
        try {
          const response = await post(surface, target.identity.path);
          assert.equal(response.status, 200, JSON.stringify({ status: response.status, code: response.wire.code }));
          assert.equal(response.wire.documentId, target.identity.documentId); assert.equal(response.wire.lifecycleGeneration, 1);
          assert.equal(response.wire.documentSequence, 7); assert.equal(rollback, 1); assert.equal(failed.size, 1);
          assert.equal(peer.factoryEntry(), 1); assert.deepEqual(await stored(target.identity), before);
        } finally { Client.prototype.query = rawQuery; (runtime as unknown as Pool).off('release', releaseListener); peer.release(); await peer.done; }
      }
    });
    await check('durable actual HTTP Busy is bounded to three fresh read attempts and publishes no ticket', async () => {
      const target = await seed('durable'), before = await stored(target.identity), peer = await startAuthorizationWriter();
      let begins = 0, errors = 0, rollbacks = 0;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = text(args), result = Reflect.apply(rawQuery, this, args);
        if (!ownRuntime(this) || this === peer.client) return result;
        if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') begins++;
        return Promise.resolve(result).catch(error => { if (Reflect.get(error as object, 'code') === '55P03') errors++; throw error; })
          .then(value => { if (sql === 'ROLLBACK') rollbacks++; return value; });
      } as typeof Client.prototype.query;
      try {
        const response = await post('web', target.identity.path);
        assert.equal(response.status, 409); assert.equal(response.wire.code, 'PRINCIPAL_BUSY');
        assert.equal(response.wire.retryable, true);
        assert.equal(Object.hasOwn(response.wire, 'token'), false); assert.equal(begins, 3); assert.equal(errors, 3); assert.equal(rollbacks, 3);
        assert.deepEqual(await stored(target.identity), before);
      } finally { Client.prototype.query = rawQuery; peer.release(); await peer.done; }
    });
    await check('Busy cannot be forged by a private publisher and publication runs only once', async () => {
      const target = await seed('publisher'), { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal'); let publications = 0;
      await assert.rejects(publishGrant(await sessionInput(target), async () => {
        publications++; throw new WorkspaceRequestPrincipalError('PRINCIPAL_BUSY');
      }), error => {
        assert.equal(isAuthenticatedTextSessionStartupRetryable(error), false);
        assert.deepEqual(authenticatedTextSessionStartupDiagnostic(error), { event: 'collaboration_session_startup_failed',
          phase: 'publication', code: 'PRINCIPAL_BUSY', retryable: false });
        return code('PRINCIPAL_BUSY')(error);
      });
      assert.equal(publications, 1);
    });
    await check('an actual terminal hint does not authorize replay from a later publisher', async () => {
      const target = await seed('terminal-hint-identity'), before = await stored(target.identity), peer = await startAuthorizationWriter();
      let genuineBusy: unknown, publications = 0;
      try {
        await assert.rejects(publishGrant(await sessionInput(target), async () => { publications++; }), error => {
          genuineBusy = error;
          assert.equal(isAuthenticatedTextSessionStartupRetryable(error), true);
          assert.deepEqual(authenticatedTextSessionStartupDiagnostic(error), { event: 'collaboration_session_startup_failed',
            phase: 'scope', code: 'PRINCIPAL_BUSY', retryable: true });
          return code('PRINCIPAL_BUSY')(error);
        });
        assert.equal(publications, 0);
      } finally { peer.release(); await peer.done; }
      await assert.rejects(publishGrant(await sessionInput(target), async () => { publications++; throw genuineBusy; }), error => {
        assert.equal(error, genuineBusy); assert.equal(isAuthenticatedTextSessionStartupRetryable(error), false);
        assert.equal(authenticatedTextSessionStartupDiagnostic(error).phase, 'publication');
        return code('PRINCIPAL_BUSY')(error);
      });
      assert.equal(publications, 1); assert.deepEqual(await stored(target.identity), before);
    });
    for (const surface of ['mobile', 'web'] as const) await check(`actual native table lock before the service consumer permits only fresh pure-read retries (${surface})`, async () => {
      for (const durable of [false, true]) {
        const target = await seed(`${surface}-native-table-${durable}`), before = await stored(target.identity), holder = await ownClient();
        await holder.query('BEGIN'); await holder.query('LOCK TABLE collaboration_yjs_states IN ACCESS EXCLUSIVE MODE');
        let errors = 0, rollbacks = 0, released = false;
        const transports = observeTransports();
        const observed = observeTransactions(async (_client, sql, result) => {
          try {
            const value = await result;
            if (sql === 'ROLLBACK') {
              rollbacks++;
              if (!durable && !released) { released = true; await holder.query('ROLLBACK'); }
            }
            return value;
          } catch (error) { if (Reflect.get(error as object, 'code') === '55P03') errors++; throw error; }
        });
        try {
          const response = await post(surface, target.identity.path);
          assert.equal(response.status, durable ? 409 : 200, JSON.stringify({ status: response.status, code: response.wire.code }));
          assert.equal(errors, durable ? 3 : 1); assert.equal(rollbacks, errors);
          if (durable) {
            assert.equal(response.wire.code, 'PRINCIPAL_BUSY'); assert.equal(Object.hasOwn(response.wire, 'token'), false);
            assert.equal(response.wire.retryable === true, surface === 'web');
          }
          else { assert.equal(response.wire.documentId, target.identity.documentId); assert.equal(response.wire.documentSequence, 7); }
          assert.equal(transports.records.length, durable ? 3 : 2); transports.assertDisposed();
        } finally { observed.restore(); transports.restore(); if (!released) await holder.query('ROLLBACK'); await endClient(holder); }
        assert.deepEqual(await stored(target.identity), before);
      }
    });
    await check('one shared request budget spans initial Auth contention and subsequent native read contention', async () => {
      const target = await seed('shared-budget'), before = await stored(target.identity), peer = await startAuthorizationWriter(), holder = await ownClient();
      await holder.query('BEGIN'); await holder.query('LOCK TABLE collaboration_yjs_states IN ACCESS EXCLUSIVE MODE');
      let errors = 0, rollbacks = 0; const transports = observeTransports();
      const observed = observeTransactions(async (client, sql, result) => {
        if (client === peer.client) return result;
        try {
          const value = await result;
          if (sql === 'ROLLBACK') { if (++rollbacks === 1) { peer.release(); await peer.done; } }
          return value;
        } catch (error) { if (Reflect.get(error as object, 'code') === '55P03') errors++; throw error; }
      });
      try {
        const response = await post('mobile', target.identity.path);
        assert.equal(response.status, 409); assert.equal(response.wire.code, 'PRINCIPAL_BUSY');
        assert.equal(errors, 3); assert.equal(rollbacks, 3); assert.equal(transports.records.length, 2);
        assert.equal(Object.hasOwn(response.wire, 'token'), false); transports.assertDisposed();
      } finally { observed.restore(); transports.restore(); peer.release(); await peer.done; await holder.query('ROLLBACK'); await endClient(holder); }
      assert.deepEqual(await stored(target.identity), before);
    });
    for (const surface of ['mobile', 'web'] as const) await check(`actual opaque capture Principal final Busy is never a certified retry (${surface})`, async () => {
      const target = await seed(`${surface}-capture-final`), before = await stored(target.identity);
      let binding = false, authAfterBinding = 0, injected = false;
      const observed = observeTransactions(async (client, sql, result, ordinal) => {
        const value = await result;
        if (ordinal === 2) {
          if (sql.includes('FROM pg_stat_activity a JOIN canvas_workspaces')) binding = true;
          if (binding && authCurrentQuery(sql) && ++authAfterBinding === 2) { injected = true; await raiseActualBusy(client); }
        }
        return value;
      });
      try {
        const response = await post(surface, target.identity.path);
        assert.equal(injected, true); assert.equal(response.status, 409); assert.equal(response.wire.code, 'PRINCIPAL_BUSY');
        assert.equal(Object.hasOwn(response.wire, 'retryable'), false);
        assert.equal(observed.begins(), 2); assert.equal(Object.hasOwn(response.wire, 'token'), false);
      } finally { observed.restore(); }
      assert.deepEqual(await stored(target.identity), before);
    });
    for (const surface of ['mobile', 'web'] as const) await check(`service consumer and actual Principal finals reject Busy and write revocation without another attempt (${surface})`, async () => {
      for (const fault of ['consumer-busy', 'principal-final-busy', 'write-revoked'] as const) {
        const target = await seed(`${surface}-${fault}`), before = await stored(target.identity); let injected = false, receipt = false;
        let genuinePhase: object | undefined;
        if (fault === 'write-revoked') await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");
        const transports = observeTransports();
        const previousSet = WeakMap.prototype.set;
        WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
          if (value && typeof value === 'object') {
            const fields = Object.getOwnPropertyDescriptors(value);
            if (typeof fields.checking?.value === 'boolean' && typeof fields.deadline?.value === 'number'
              && fields.database?.value && fields.request?.value) genuinePhase = value;
          }
          return Reflect.apply(previousSet, this, [key, value]);
        } as typeof WeakMap.prototype.set;
        const observed = observeTransactions(async (client, sql, result, ordinal) => {
          const value = await result;
          if (ordinal === 3) {
            if (finalReceiptQuery(sql)) {
              receipt = true;
              if (fault === 'consumer-busy') { injected = true; await raiseActualBusy(client); }
              if (fault === 'write-revoked') { injected = true; await Reflect.apply(rawQuery, client, ["UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'"]); }
            }
            // assertCurrent sets checking=true. The genuine Principal's final
            // current query runs directly with checking=false after consumption.
            if (fault === 'principal-final-busy' && receipt && authCurrentQuery(sql)
              && genuinePhase && Reflect.get(genuinePhase, 'checking') === false) { injected = true; await raiseActualBusy(client); }
          }
          return value;
        });
        try {
          const response = await post(surface, target.identity.path, {}, fault === 'write-revoked' ? 'member' : 'owner');
          assert.equal(injected, true, `${fault}: actual final hook must be reached`);
          assert.equal(response.status, fault === 'write-revoked' ? 403 : fault === 'consumer-busy' ? 500 : 409,
            JSON.stringify({ fault, status: response.status, code: response.wire.code }));
          assert.equal(response.wire.code, fault === 'write-revoked' ? 'PRINCIPAL_ACCESS_DENIED' : fault === 'consumer-busy' ? '55P03' : 'PRINCIPAL_BUSY');
          assert.equal(Object.hasOwn(response.wire, 'retryable'), false);
          assert.equal(observed.begins(), 3); assert.equal(Object.hasOwn(response.wire, 'token'), false); transports.assertDisposed();
        } finally { observed.restore(); WeakMap.prototype.set = previousSet; transports.restore(); if (fault === 'write-revoked') await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'"); }
        assert.deepEqual(await stored(target.identity), before);
      }
    });
    for (const surface of ['mobile', 'web'] as const) await check(`failed rollback acknowledgement or close never certifies a retry (${surface})`, async () => {
      for (const fault of ['rollback-ack', 'close'] as const) {
        const target = await seed(`${surface}-${fault}`), before = await stored(target.identity), peer = await startAuthorizationWriter(); let injected = false;
        const observed = observeTransactions(async (client, sql, result) => {
          if (client === peer.client) return result;
          const value = await result;
          if (sql === 'ROLLBACK' && !injected) {
            injected = true;
            if (fault === 'rollback-ack') throw new Error('Owned acknowledged ROLLBACK response fault');
            const release = Reflect.get(client, 'release') as (error?: Error) => void;
            Reflect.set(client, 'release', (error?: Error) => { release(error); throw new Error('Owned post-release acknowledgement fault'); });
          }
          return value;
        });
        try {
          const response = await post(surface, target.identity.path);
          // The genuine outer Principal preserves actual later cleanup failures
          // after draining its held work; an earlier Busy cannot hide them.
          assert.equal(injected, true); assert.equal(response.status, 500, JSON.stringify({ fault, code: response.wire.code }));
          assert.equal(Object.hasOwn(response.wire, 'code'), false); assert.equal(observed.begins(), 1);
          assert.equal(Object.hasOwn(response.wire, 'retryable'), false);
          assert.equal(Object.hasOwn(response.wire, 'token'), false);
        } finally { observed.restore(); peer.release(); await peer.done; }
        assert.deepEqual(await stored(target.identity), before);
      }
    });
    for (const surface of ['mobile', 'web'] as const) await check(`actual read COMMIT response loss and healthy-close failure never replay or publish (${surface})`, async () => {
      for (const fault of ['commit-ack', 'healthy-close'] as const) {
        const target = await seed(`${surface}-${fault}`), before = await stored(target.identity); let injected = false;
        const observed = observeTransactions(async (client, sql, result, ordinal) => {
          const value = await result;
          if (ordinal > 0 && sql === 'COMMIT' && !injected) {
            injected = true;
            if (fault === 'commit-ack') throw Object.assign(new Error('Owned actual COMMIT response fault'), { code: '55P03' });
            const release = Reflect.get(client, 'release') as (error?: Error) => void;
            Reflect.set(client, 'release', (error?: Error) => { release(error); throw new Error('Owned post-release acknowledgement fault'); });
          }
          return value;
        });
        try {
          const response = await post(surface, target.identity.path);
          assert.equal(injected, true); assert.equal(response.status, fault === 'commit-ack' ? 503 : 500);
          if (fault === 'commit-ack') assert.equal(response.wire.code, 'NATIVE_SESSION_COMMIT_UNCONFIRMED');
          assert.equal(Object.hasOwn(response.wire, 'retryable'), false);
          assert.equal(observed.begins(), 1); assert.equal(Object.hasOwn(response.wire, 'token'), false);
        } finally { observed.restore(); }
        assert.deepEqual(await stored(target.identity), before);
      }
    });
    await check('retry never resets the original Root, customer, auth session or raw search path', async () => {
      await admin.query("INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at) VALUES('busy-customer','principal-org','Owned','busy-owned','active',100,100)");
      for (const drift of ['root', 'customer', 'session', 'searchpath'] as const) {
        const target = await seed(`retry-${drift}`), before = await stored(target.identity), peer = await startAuthorizationWriter(); let changed = false;
        const observed = observeTransactions(async (client, sql, result, ordinal) => {
          if (client === peer.client) return result;
          const value = await result;
          if (sql === 'ROLLBACK' && !changed) {
            changed = true; peer.release(); await peer.done;
            if (drift === 'root') await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/changed' WHERE id=$1", [workspaceId]);
            if (drift === 'customer') await admin.query("UPDATE canvas_workspaces SET customer_id='busy-customer' WHERE id=$1", [workspaceId]);
            if (drift === 'session') await admin.query("DELETE FROM session WHERE id='session-owner'");
          }
          if (drift === 'searchpath' && ordinal === 2 && sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') {
            await Reflect.apply(rawQuery, client, [`SET LOCAL search_path="${schema}",pg_catalog`]);
          }
          return value;
        });
        try {
          const response = await post('mobile', target.identity.path);
          assert.equal(changed, true); assert.equal(Object.hasOwn(response.wire, 'token'), false);
          assert.equal(response.status, drift === 'session' ? 401 : 409, `${drift}: ${String(response.wire.code)}`);
          if (drift === 'session') { assert.equal(response.wire.code, 'PRINCIPAL_AUTH_REVOKED'); assert.equal(observed.begins(), 1); }
          else { assert.equal(response.wire.code, 'NATIVE_SESSION_SCOPE_CHANGED'); assert.equal(observed.begins(), 2); }
        } finally {
          observed.restore(); peer.release(); await peer.done;
          await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared',customer_id=NULL WHERE id=$1", [workspaceId]);
          if (drift === 'session') await seedSession();
        }
        assert.deepEqual(await stored(target.identity), before);
      }
    });
    for (const surface of ['mobile', 'web'] as const) await check(`private transport cleanup rejection cannot certify another attempt (${surface})`, async () => {
      const target = await seed(`${surface}-cleanup-failure`), before = await stored(target.identity), holder = await ownClient();
      await holder.query('BEGIN'); await holder.query('LOCK TABLE collaboration_yjs_states IN ACCESS EXCLUSIVE MODE');
      const transports = observeTransports(); let injected = false;
      const observed = observeTransactions(async (_client, sql, result) => {
        const value = await result;
        if (sql === 'ROLLBACK' && !injected && transports.records.length === 1) {
          injected = true;
          // Controlled cleanup acknowledgement failure on the real private
          // record; genuine Principal/Native factories and SQL remain actual.
          const failed = Promise.reject(new Error('Owned cleanup acknowledgement fault')); void failed.catch(() => undefined);
          Reflect.set(transports.records[0], 'disposal', failed);
        }
        return value;
      });
      try {
        const response = await post(surface, target.identity.path);
        assert.equal(injected, true); assert.equal(response.status, 500); assert.equal(observed.begins(), 3);
        assert.equal(Object.hasOwn(response.wire, 'retryable'), false);
        assert.equal(Object.hasOwn(response.wire, 'token'), false); transports.assertDisposed();
      } finally { observed.restore(); transports.restore(); await holder.query('ROLLBACK'); await endClient(holder); }
      assert.deepEqual(await stored(target.identity), before);
    });
    for (const surface of ['mobile', 'web'] as const) await check(`actual pristine bootstrap Busy remains outside the read retry loop and rolls back its only mutation (${surface})`, async () => {
      const file = `bootstrap-${crypto.randomUUID()}.txt`, root = path.join(dataRoot, 'organizations/principal-org/shared');
      await mkdir(root, { recursive: true }); await writeFile(path.join(root, file), 'Bound original\n', { flag: 'wx' });
      let inserts = 0, injected = false; const transports = observeTransports();
      const observed = observeTransactions(async (client, sql, result) => {
        const value = await result;
        if (/INSERT INTO collaboration_yjs_states\b/iu.test(sql)) { inserts++; injected = true; await raiseActualBusy(client); }
        return value;
      });
      try {
        const response = await post(surface, file);
        assert.equal(injected, true, JSON.stringify({ status: response.status, code: response.wire.code, begins: observed.begins() }));
        assert.equal(inserts, 1); assert.equal(Object.hasOwn(response.wire, 'token'), false);
        assert.equal(response.status, 409, String(response.wire.code));
        assert.equal(Object.hasOwn(response.wire, 'retryable'), false);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2', [workspaceId, file])).rows[0].count, 0);
        transports.assertDisposed();
      } finally { observed.restore(); transports.restore(); await rm(path.join(root, file)); }
    });
    await check('a clean pure-read Busy after actual committed bootstrap cannot mark the whole request retryable', async () => {
      const file = `bootstrap-then-read-${crypto.randomUUID()}.txt`, root = path.join(dataRoot, 'organizations/principal-org/shared');
      await mkdir(root, { recursive: true }); await writeFile(path.join(root, file), 'Bound original\n', { flag: 'wx' });
      const holder = await ownClient(), transports = observeTransports();
      let inserted = false, held = false, insertions = 0, readErrors = 0;
      const observed = observeTransactions(async (client, sql, result) => {
        try {
          const value = await result;
          if (client !== holder && /INSERT INTO collaboration_yjs_states\b/iu.test(sql)) { inserted = true; insertions++; }
          if (client !== holder && inserted && !held && sql === 'COMMIT') {
            await holder.query('BEGIN');
            await holder.query('LOCK TABLE collaboration_yjs_states IN ACCESS EXCLUSIVE MODE'); held = true;
          }
          return value;
        } catch (error) { if (held && Reflect.get(error as object, 'code') === '55P03') readErrors++; throw error; }
      });
      try {
        const response = await post('web', file);
        assert.equal(held, true); assert.equal(insertions, 1); assert.equal(readErrors, 3);
        assert.equal(response.status, 409); assert.equal(response.wire.code, 'PRINCIPAL_BUSY');
        assert.equal(Object.hasOwn(response.wire, 'retryable'), false); assert.equal(Object.hasOwn(response.wire, 'token'), false);
        await holder.query('ROLLBACK'); held = false;
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2',
          [workspaceId, file])).rows[0].count, 1);
        transports.assertDisposed();
      } finally {
        observed.restore(); transports.restore();
        try { if (held) await holder.query('ROLLBACK'); } finally { await endClient(holder); await rm(path.join(root, file)); }
      }
    });
    await check('actual legacy rich migration Busy never replays a native mutation or publishes its ticket', async () => {
      const markdown = '# Native title\n\nFirst **bold** text.\n', doc = createPlainTextYDoc(markdown);
      const target = await seed('migration-no-replay', 'plain_text', { doc }); doc.destroy();
      const hash = crypto.createHash('sha256').update(markdown).digest('hex');
      await admin.query('UPDATE collaboration_yjs_states SET checkpoint_sequence=7,checkpointed_at=100,canonical_hash=$2,serialized_hash=$2 WHERE document_id=$1', [target.identity.documentId, hash]);
      await admin.query(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,revision_id,canonical_hash,serialized_hash,finalized,updated_at)
        VALUES($1,1,7,$2,$3,$3,1,100)`, [target.identity.documentId, `revision-${target.identity.documentId}`, hash]);
      const root = path.join(dataRoot, 'organizations/principal-org/shared'); await mkdir(root, { recursive: true });
      await writeFile(path.join(root, target.identity.path), markdown, { flag: 'wx' });
      const before = await stored(target.identity), transports = observeTransports(); let updates = 0;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = text(args), result = Reflect.apply(rawQuery, this, args);
        if (!ownRuntime(this) || !/UPDATE collaboration_yjs_states\s+SET representation\b/iu.test(sql)) return result;
        return Promise.resolve(result).then(async value => { updates++; await raiseActualBusy(this); return value; });
      } as typeof Client.prototype.query;
      try {
        const response = await post('web', target.identity.path, { allowRichMigration: true, expectedLifecycleGeneration: 1 });
        assert.equal(updates, 1); assert.equal(response.status, 500, String(response.wire.code));
        assert.equal(response.wire.code, '55P03');
        assert.equal(Object.hasOwn(response.wire, 'retryable'), false);
        assert.equal(Object.hasOwn(response.wire, 'token'), false); assert.deepEqual(await stored(target.identity), before);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_state_backups WHERE document_id=$1', [target.identity.documentId])).rows[0].count, 0);
        transports.assertDisposed();
      } finally { Client.prototype.query = rawQuery; transports.restore(); await rm(path.join(root, target.identity.path)); }
    });
    await check('origin Root drift during the actual realm query await is rejected before publication', async () => {
      const target = await seed('origin-await'); let changed = false;
      const runtimeQuery = runtime.query;
      Reflect.set(runtime, 'query', async (...args: unknown[]) => {
        const value = await Reflect.apply(runtimeQuery, runtime, args), sql = text(args);
        if (!changed && sql.includes('current_setting(\'search_path\') AS search_path') && !sql.includes('FROM canvas_workspaces')) {
          changed = true; await admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2', ['organizations/principal-org/changed', workspaceId]);
        }
        return value;
      });
      try {
        const response = await post('web', target.identity.path); assert.equal(changed, true);
        assert.equal(response.status, 409); assert.equal(response.wire.code, 'NATIVE_SESSION_SCOPE_CHANGED'); assert.equal(Object.hasOwn(response.wire, 'token'), false);
      } finally { Reflect.set(runtime, 'query', runtimeQuery); await admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2', ['organizations/principal-org/shared', workspaceId]); }
    });
    assert.equal(fetches, 0); if (!process.argv[2]) assert.equal(cases, 25); disposeMobileCollaborationTickets();
    console.log(`Authenticated native HTTP Busy: ${cases} genuine PostgreSQL18 families passed; existing product gate remains false.`);
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
main().catch(error=>{console.error('Owned authenticated busy fixture failed:',{stage,name:error instanceof Error?error.name:'unknown',
  location:error instanceof Error?error.stack?.split('\n').filter(line=>line.includes('authenticated-text-session-busy-postgres-test.ts') || line.includes('rich-migration-domain.ts')).map(line=>line.trim()):[],
  message:error instanceof Error&&error.name==='AssertionError'?error.message.slice(0,600):null,
  missingRelation:error&&typeof error==='object'&&Reflect.get(error,'code')==='42P01'&&error instanceof Error?error.message.slice(0,300):null,
  ownedMigrationCommand:error&&typeof error==='object'?Reflect.get(error,'ownedMigrationCommand')??null:null,
  expected:error&&typeof error==='object'&&['string','number','boolean'].includes(typeof Reflect.get(error,'expected'))?Reflect.get(error,'expected'):null,
  actual:error&&typeof error==='object'&&['string','number','boolean'].includes(typeof Reflect.get(error,'actual'))?Reflect.get(error,'actual'):null,
  code:error&&typeof error==='object'?Reflect.get(error,'code')??null:null,
  constraint:error&&typeof error==='object'?Reflect.get(error,'constraint')??null:null});process.exitCode=1;});
