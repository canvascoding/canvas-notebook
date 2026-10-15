import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  const schema = `native_peer_busy_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_peer_busy_[a-f0-9]{32}$/u);
  const workspaceId = `native-transport-${crypto.randomUUID()}`;
  const evidenceRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-peer-busy-'));
  const dataRoot = path.join(evidenceRoot,'data'); await mkdir(dataRoot,{mode:0o700});
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=request-principal-fixture` });
    client.on('error',()=>undefined); // transaction_timeout may terminate this owned fixture client.
    clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client:Client) => { await client.end(); clients.delete(client); };
  let cases = 0; const results: unknown[] = [];
  const processIdentity = execFileSync('ps', ['-p', String(process.pid), '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' }).trim();
  console.log('Owned Source peer-busy counter:',{pid:process.pid,processIdentity,evidenceRoot,schema});
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
      // The existing HTTP fixture scopes this historical migration's two
      // public catalogue scans to the owned namespace before its unqualified
      // DML. No migration, DDL or returned database row is replaced.
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
    // Reuse the real fixture's original auth/DDL contract, but keep this matrix
    // bounded to read-only contention. No test phase, ALS value or SQL row is
    // substituted for an authenticated principal or an owner fence.
    const actualDb = await import('../app/lib/db');
    const transport = await import('../app/lib/collaboration/authenticated-native-session-transport');
    const { NATIVE_PEER_ADMISSION_BUSY_REASON } = await import('../app/lib/collaboration/failure');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const { POST } = await import('../app/api/files/collaboration/session/route');
    const waitUntil = async (condition: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) { if (await condition()) return; await new Promise(done => setTimeout(done, 10)); }
      throw new Error(label);
    };
    type Phase = 'http' | 'capture' | 'join' | 'connected' | 'beforeHandleMessage';
    type TransactionRecord = { id: number; pid?: number; phase?: Phase | string; events: string[]; sqlCodes: string[]; code?: string; privateBusy?: boolean };
    const transactions: TransactionRecord[] = [], records = new WeakMap<SqlConnection, TransactionRecord>();
    const backendRecords = new Map<number, TransactionRecord>(), failureRecords = new WeakMap<object, TransactionRecord>();
    const joinCaptures = new Map<number, number>();
    const originRetirements: Array<{ recordId: number; phase?: string; events: string[]; eligible: boolean; captureRecordId: number | null }> = [];
    const originDisposals: Array<{ completed: true; retirementCount: number }> = [];
    const originTimeline: Array<{ event: 'capture_begin' | 'retire_complete' | 'dispose_complete'; recordId?: number }> = [];
    const captures = new WeakMap<Awaited<ReturnType<typeof transport.captureAuthenticatedNativeSessionTransportOnConnection>>, number>();
    const disposals: Array<{ capture: number; settled: boolean }> = [];
    let currentDocumentId = '', sequence = 0;
    let plan: { phase: Phase; kind: 'row' | 'table'; fired: boolean; releaseAfterClose: boolean; holder?: Client; holderPid?: number; blockerProof?: unknown; attempts: number; beforeOrigin?: boolean; factoryUpdates?: number } | undefined;
    const releaseHolder = async () => {
      const holder = plan?.holder; if (!holder) return;
      plan!.holder = undefined; await holder.query('ROLLBACK'); await endClient(holder);
    };
    const hold = async (kind: 'row' | 'table') => {
      const holder = await ownClient(); await holder.query('BEGIN');
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const statement = kind === 'row'
        ? `SELECT organization_id FROM "${schema}".canvas_organization_settings WHERE organization_id='principal-org' FOR UPDATE`
        : `LOCK TABLE "${schema}".canvas_organization_settings IN ROW EXCLUSIVE MODE`;
      await holder.query(statement);
      // A separate owned SQL waiter proves the actual lock-holder relationship
      // before the production NOWAIT phase runs. Never cancel a foreign PID.
      const waiter = await ownClient(); await waiter.query('BEGIN'); await waiter.query("SET LOCAL lock_timeout='2000ms'");
      const waiterPid = Number((await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const waiting = waiter.query(kind === 'row' ? statement : `LOCK TABLE "${schema}".canvas_organization_settings IN SHARE MODE`)
        .then(() => { throw new Error('Owned blocker probe unexpectedly acquired its lock.'); }, error => error);
      await waitUntil(async () => (await control.query('SELECT pg_blocking_pids($1) AS blockers', [waiterPid])).rows[0].blockers.includes(holderPid), 'Actual PG lock holder was not observed.');
      const blockerProof = (await control.query(`SELECT a.pid,a.state,a.wait_event_type,a.wait_event,pg_blocking_pids(a.pid) AS blockers,
        (SELECT oid FROM pg_namespace WHERE nspname=$2) AS schema_oid FROM pg_stat_activity a WHERE a.pid=$1`, [waiterPid, schema])).rows[0];
      assert.equal(blockerProof.wait_event_type, 'Lock'); assert(blockerProof.blockers.includes(holderPid));
      assert.equal((await control.query('SELECT pg_cancel_backend($1) AS cancelled', [waiterPid])).rows[0].cancelled, true);
      const probeError = await waiting; assert.equal(probeError.code, '57014');
      await waiter.query('ROLLBACK'); await endClient(waiter);
      return { holder, holderPid, blockerProof };
    };
    const organizationLock = (sql: string) => sql.startsWith('LOCK TABLE ') && sql.includes('canvas_organization_settings') && sql.endsWith('NOWAIT');
    const arm = async (sql: string, phase: string | undefined) => {
      if (plan && plan.phase === phase && !plan.fired && organizationLock(sql)) {
        plan.fired = true; Object.assign(plan, await hold(plan.kind));
      }
    };
    // The original exported POST uses the real runtime module. Only its owned
    // SQL promise is paused at the first genuine B lock, AFTER factory minting.
    // Starting a holder before request discovery would test its unrelated
    // initialization writes, not the bounded native phase.
    const rawQuery = Client.prototype.query;
    let httpQueries: Array<{ command: string; code?: string }> = [];
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0] && typeof args[0] === 'object' ? String(Reflect.get(args[0], 'text') ?? '') : '';
      const options = Reflect.get(Reflect.get(this, 'connectionParameters'), 'options');
      if (plan?.phase !== 'http' || clients.has(this) || this === control || !String(options).includes(schema)
        || args.some(argument => typeof argument === 'function')) return Reflect.apply(rawQuery, this, args);
      const command = organizationLock(sql) ? 'org-nowait-lock' : sql.startsWith('UPDATE canvas_organization_settings ') ? 'factory-org-update'
        : sql.trim().split(/\s/u)[0];
      const observation = { command, code: undefined as string | undefined }; httpQueries.push(observation);
      // The first factory update belongs to the unchanged route precheck. A
      // second one is the actual native origin resolver; hold its real row
      // before UPDATE to prove its own failure classification independently.
      const beforeOrigin = plan.beforeOrigin && command === 'factory-org-update'
        && (plan.factoryUpdates = (plan.factoryUpdates ?? 0) + 1) === 2 && !plan.fired;
      const ready = beforeOrigin ? (() => { plan!.fired = true; return hold('row').then(holder => { Object.assign(plan!, holder); }); })()
        : organizationLock(sql) ? arm(sql, 'http') : Promise.resolve();
      return ready.then(() => Reflect.apply(rawQuery, this, args))
        .catch(error => { if (observation) observation.code = error?.code; throw error; });
    } as typeof Client.prototype.query;
    const openObservedConnection = async (): Promise<SqlConnection> => {
      const actual = await actualDb.openDb(), record: TransactionRecord = { id: ++sequence, events: [], sqlCodes: [] }; transactions.push(record);
      const query = async <T>(sql: string, operation: () => T | Promise<T>): Promise<T> => {
        await arm(sql, record.phase);
        try { return await operation(); }
        catch (error) { if (error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string') record.sqlCodes.push(Reflect.get(error, 'code')); throw error; }
      };
      const observed: SqlConnection = {
        get: async (sql, values) => {
          const result = await query(sql, () => actual.get(sql, values));
          if (sql === 'SELECT pg_backend_pid() AS pid') {
            assert(result && typeof result === 'object');
            record.pid = Number(Reflect.get(result, 'pid')); assert(Number.isSafeInteger(record.pid));
            backendRecords.set(record.pid, record);
          }
          return result;
        }, all: (sql, values) => query(sql, () => actual.all(sql, values)),
        run: async (sql, values) => { const result = await query(sql, () => actual.run(sql, values)); if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql)) record.events.push(sql.split(' ')[0]); return result; },
        close: async error => {
          await actual.close(error); record.events.push(error ? 'discard-close' : 'close');
          if (record.privateBusy && plan?.releaseAfterClose) await releaseHolder();
        },
      };
      records.set(observed, record); return observed;
    };
    const hooks = new Map<string, string>();
    const observe = async <T>(database: SqlConnection, phase: Phase | string, operation: () => Promise<T>): Promise<T> => {
      const pid = Number((await database.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
      // Admission forwards through its own closure-observing wrapper. Match
      // that actual handle using the same existing PID observation, not ALS or
      // an injected principal/facade. SQL results remain unchanged.
      const record = records.get(database) ?? backendRecords.get(pid); assert(record);
      records.set(database, record); record.phase = phase; record.pid = pid;
      try { return await operation(); }
      catch (error) {
        record.code = error && typeof error === 'object' ? String(Reflect.get(error, 'code') ?? '') : '';
        record.privateBusy = transport.isAuthenticatedNativeSessionTransportBusy(error);
        if (error && typeof error === 'object') failureRecords.set(error, record);
        if (record.privateBusy && plan?.phase === phase) plan.attempts++;
        throw error;
      }
    };
    const observedTransport = {
      ...transport,
      captureAuthenticatedNativePeerOriginTransportOnConnection: async (...args: Parameters<typeof transport.captureAuthenticatedNativePeerOriginTransportOnConnection>) => {
        const capability = await observe(args[0], 'capture', () => {
          originTimeline.push({ event: 'capture_begin', recordId: records.get(args[0])!.id });
          return transport.captureAuthenticatedNativePeerOriginTransportOnConnection(...args);
        });
        captures.set(capability, records.get(args[0])!.id); return capability;
      },
      withAuthenticatedNativePeerOriginJoinOnConnection: <T>(...args: Parameters<typeof transport.withAuthenticatedNativePeerOriginJoinOnConnection<T>>) =>
        observe(args[0], 'join', () => {
          const captured = captures.get(args[2]); assert(captured !== undefined, 'Join must use a genuinely returned Capture transport');
          joinCaptures.set(records.get(args[0])!.id, captured);
          return transport.withAuthenticatedNativePeerOriginJoinOnConnection(...args);
        }),
      retireAuthenticatedNativePeerOriginAttempt: async (...args: Parameters<typeof transport.retireAuthenticatedNativePeerOriginAttempt>) => {
        const eligible = await transport.retireAuthenticatedNativePeerOriginAttempt(...args);
        const record = args[1] && typeof args[1] === 'object' ? failureRecords.get(args[1]) : undefined; assert(record);
        originRetirements.push({ recordId: record.id, phase: record.phase, events: [...record.events], eligible,
          captureRecordId: joinCaptures.get(record.id) ?? null });
        originTimeline.push({ event: 'retire_complete', recordId: record.id });
        return eligible;
      },
      disposeAuthenticatedNativePeerOrigin: async (...args: Parameters<typeof transport.disposeAuthenticatedNativePeerOrigin>) => {
        await transport.disposeAuthenticatedNativePeerOrigin(...args);
        originDisposals.push({ completed: true, retirementCount: originRetirements.length });
        originTimeline.push({ event: 'dispose_complete' });
      },
      captureAuthenticatedNativeSessionTransportOnConnection: async (...args: Parameters<typeof transport.captureAuthenticatedNativeSessionTransportOnConnection>) => {
        const capability = await observe(args[0], 'capture', () => transport.captureAuthenticatedNativeSessionTransportOnConnection(...args));
        captures.set(capability, records.get(args[0])!.id); return capability;
      },
      disposeAuthenticatedNativeSessionTransport: async (...args: Parameters<typeof transport.disposeAuthenticatedNativeSessionTransport>) => {
        const disposal = { capture: captures.get(args[0]) ?? -1, settled: false }; disposals.push(disposal);
        await transport.disposeAuthenticatedNativeSessionTransport(...args); disposal.settled = true;
      },
      withAuthenticatedNativeSessionTransportOnConnection: <T>(...args: Parameters<typeof transport.withAuthenticatedNativeSessionTransportOnConnection<T>>) =>
        observe(args[0], 'join', () => transport.withAuthenticatedNativeSessionTransportOnConnection(...args)),
      withAuthenticatedOwnedNativeSessionTransportOnConnection: <T>(...args: Parameters<typeof transport.withAuthenticatedOwnedNativeSessionTransportOnConnection<T>>) =>
        observe(args[0], hooks.get(args[2].identity.documentId) ?? 'monitor', () => transport.withAuthenticatedOwnedNativeSessionTransportOnConnection(...args)),
    };
    const evaluate = async <T>(filename: string, replacements: { [name: string]: unknown }): Promise<T> => {
      const absolute = path.resolve(filename), originalRequire = createRequire(absolute), exports = {};
      const compiled = ts.transpileModule(await readFile(absolute, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
      new Function('require', 'module', 'exports', compiled.outputText)((name: string) => name in replacements ? replacements[name] : originalRequire(name), { exports }, exports);
      return exports as T;
    };
    // Exact saved product modules, with observing wrappers that invoke their
    // actual original functions and return unchanged SQL results.
    const actualPeer = await evaluate<typeof import('../app/lib/collaboration/authenticated-native-peer')>('app/lib/collaboration/authenticated-native-peer.ts', {
      '../db': { ...actualDb, openDb: openObservedConnection }, './authenticated-native-session-transport': observedTransport,
    });
    const actualAdmission = await evaluate<typeof import('../app/lib/collaboration/authenticated-native-peer-admission')>('app/lib/collaboration/authenticated-native-peer-admission.ts', {
      '../db': { ...actualDb, openDb: openObservedConnection }, './authenticated-native-session-transport': observedTransport,
    });
    const productServer = await evaluate<typeof import('../server/collaboration-server')>('server/collaboration-server.ts', {
      '@/app/lib/db': { ...actualDb, openDb: openObservedConnection },
      '@/app/lib/collaboration/authenticated-native-peer': actualPeer,
      '@/app/lib/collaboration/authenticated-native-peer-admission': actualAdmission,
      '@/app/lib/collaboration/authenticated-native-session-transport': observedTransport,
    });
    process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
    const actualRoot = path.join(dataRoot, 'organizations/principal-org/shared'); await mkdir(actualRoot, { recursive: true });
    const server = http.createServer(async (incoming, response) => {
      try {
        assert.equal(incoming.url, '/api/files/collaboration/session'); assert.equal(incoming.method, 'POST');
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of incoming) { size += chunk.length; assert(size <= 2048); chunks.push(Buffer.from(chunk)); }
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
        const result = await POST(new NextRequest('http://localhost/api/files/collaboration/session', { method: 'POST', headers, body: Buffer.concat(chunks) }));
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
      } catch { response.writeHead(500); response.end('{"success":false,"code":"FIXTURE_HTTP_FAILURE"}'); }
    });
    const sockets = new Set<WebSocket>(), documents = new Set<import('@hocuspocus/server').Document>();
    const ownerObservations: Array<{ event: string; command?: string; sqlHash?: string; durationMs?: number;
      errorCode?: string; backendPid: number | null }> = [];
    const actualRuntime: { hocuspocus?: Hocuspocus } = {};
    const handledMessages = new Map<string, number>();
    const originalHooks = Hocuspocus.prototype.hooks;
    Hocuspocus.prototype.hooks = (async function (this: Hocuspocus, name: string, payload: { [key: string]: unknown }, ...args: unknown[]) {
      actualRuntime.hocuspocus = this;
      const connection = payload.connection as import('@hocuspocus/server').Connection | undefined;
      const documentId = typeof payload.documentName === 'string' ? payload.documentName : connection?.document.name;
      if (connection) documents.add(connection.document);
      if (documentId) hooks.set(documentId, name);
      try {
        const result = await (originalHooks as (...args: unknown[]) => Promise<unknown>).call(this, name, payload, ...args);
        if (documentId && name === 'afterHandleMessage') handledMessages.set(documentId, (handledMessages.get(documentId) ?? 0) + 1);
        return result;
      }
      finally { if (documentId && hooks.get(documentId) === name) hooks.delete(documentId); }
    }) as typeof originalHooks;
    const wss = productServer.createCollaborationServer(server, { roomOwner: { createSession: async onInvalidated => {
      const client = await ownClient(), backend = Reflect.get(client, 'processID');
      const backendPid = Number.isSafeInteger(backend) ? Number(backend) : null;
      const errorCode = (error: unknown) => {
        const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
        return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : 'UNKNOWN';
      };
      client.on('error', error => { ownerObservations.push({ event: 'error', errorCode: errorCode(error), backendPid }); });
      client.on('end', () => { ownerObservations.push({ event: 'end', backendPid }); });
      const originalQuery = client.query;
      const query = ((...args: unknown[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : '';
        const observation = { event: 'query', command: sql.trim().split(/\s/u)[0],
          sqlHash: crypto.createHash('sha256').update(sql).digest('hex'), backendPid,
          durationMs: 0, errorCode: undefined as string | undefined };
        ownerObservations.push(observation);
        const started = performance.now();
        return Promise.resolve(Reflect.apply(originalQuery, client, args)).then(result => {
          observation.durationMs = performance.now() - started; return result;
        }, error => {
          observation.durationMs = performance.now() - started; observation.errorCode = errorCode(error); throw error;
        });
      }) as typeof client.query;
      return createCollaborationRoomOwnerSession({ query, on: client.on.bind(client), end: client.end.bind(client) }, () => {
        ownerObservations.push({ event: 'invalidated', backendPid }); onInvalidated();
      });
    }, heartbeatMs: 1000 } });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert(address && typeof address === 'object');
    console.log('Owned Source rawserver ready:', { pid: process.pid, port: address.port, schema, evidenceRoot });
    const httpSession = async (identity: ExistingNativeSessionIdentity) => {
      const original = await request('owner', true), body = JSON.stringify({ path: identity.path, provider: 'yjs', representation: identity.representation });
      return new Promise<{ status: number; body: { [key: string]: unknown } }>((resolve, reject) => {
        const outgoing = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/files/collaboration/session', method: 'POST',
          headers: { cookie: original.headers.get('cookie')!, 'x-canvas-workspace-id': workspaceId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.once('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
        }); outgoing.once('error', reject); outgoing.end(body);
      });
    };
    const frame = (documentId: string, type: number, write: (encoder: ReturnType<typeof encoding.createEncoder>) => void) => {
      const encoder = encoding.createEncoder(); encoding.writeVarString(encoder, documentId); encoding.writeVarUint(encoder, type); write(encoder); return encoding.toUint8Array(encoder);
    };
    type Incoming = { type: number; auth?: number; scope?: string; reason?: string; bodyType?: string; code?: string; sync?: number; acknowledged?: boolean };
    const connect = async (identity: ExistingNativeSessionIdentity, token: string) => {
      const original = await request('owner', true), incoming: Incoming[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/collaboration`, { headers: { origin: 'http://localhost', cookie: original.headers.get('cookie')!, 'x-canvas-workspace-id': workspaceId } }); sockets.add(socket);
      let closed: { code: number; reason: string } | undefined;
      socket.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; }); socket.on('error', () => undefined);
      socket.on('message', data => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const decoder = decoding.createDecoder(bytes); assert.equal(decoding.readVarString(decoder), identity.documentId); const type = decoding.readVarUint(decoder);
        if (type === MessageType.Auth) {
          const auth = decoding.readVarUint(decoder), value = decoding.readVarString(decoder);
          incoming.push({ type, auth, ...(auth === AuthMessageType.PermissionDenied ? { reason: value } : { scope: value }) });
        } else if (type === MessageType.Stateless) {
          const body = JSON.parse(decoding.readVarString(decoder)); incoming.push({ type, bodyType: body.type, ...(typeof body.code === 'string' ? { code: body.code } : {}) });
        } else if (type === MessageType.Sync) incoming.push({ type, sync: decoding.readVarUint(decoder) });
        else if (type === MessageType.SyncStatus) incoming.push({ type, acknowledged: decoding.readVarUint(decoder) === 1 });
        else incoming.push({ type });
      });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      // Outgoing credentials remain private and are never logged or persisted.
      socket.send(frame(identity.documentId, MessageType.Auth, encoder => { encoding.writeVarUint(encoder, AuthMessageType.Token); encoding.writeVarString(encoder, token); }));
      await waitUntil(() => incoming.some(message => message.type === MessageType.Auth) || !!closed, 'Original Socket authentication did not settle.');
      return { socket, incoming, closed: () => closed };
    };
    const accepted = async (peer: Awaited<ReturnType<typeof connect>>) => {
      assert(peer.incoming.some(message => message.auth === AuthMessageType.Authenticated));
      await waitUntil(() => peer.incoming.some(message => message.bodyType === 'durability_snapshot') || !!peer.closed(), 'Socket connected phase did not settle.');
      assert.equal(peer.closed(), undefined); assert(peer.incoming.some(message => message.bodyType === 'durability_snapshot'));
    };
    const closePeer = async (peer: Awaited<ReturnType<typeof connect>>) => { peer.socket.close(); await waitUntil(() => !!peer.closed(), 'Own Socket did not close.'); };
    const unloadOwnRoom = async (documentId: string) => {
      await waitUntil(() => !actualRuntime.hocuspocus?.documents.get(documentId)?.getConnectionsCount(), 'Own room connections did not settle.');
      await productServer.flushCollaborationDocuments();
      const document = actualRuntime.hocuspocus?.documents.get(documentId);
      if (document) await actualRuntime.hocuspocus!.unloadDocument(document);
      await Promise.allSettled([...actualRuntime.hocuspocus?.unloadingDocuments.values() ?? []]);
      await waitUntil(() => !actualRuntime.hocuspocus?.documents.has(documentId), 'Own room unload/release did not settle.');
    };
    const inspectBusy = (start: number, phase: Phase, privateBusy: boolean, expected: number) => {
      const busy = transactions.slice(start).filter(record => record.phase === phase && record.sqlCodes.includes('55P03'));
      assert.equal(busy.length, expected); for (const record of busy) {
        assert.equal(record.privateBusy, privateBusy); assert.equal(record.code, privateBusy ? '' : 'PRINCIPAL_BUSY');
        assert.deepEqual(record.events, ['BEGIN', 'ROLLBACK', 'close']); assert(record.pid);
      }
      assert.equal(new Set(busy.map(record => record.id)).size, expected); return busy;
    };
    const newCase = async (label: string) => {
      stage = label; const seeded = await seed(label); currentDocumentId = seeded.identity.documentId;
      await writeFile(path.join(actualRoot, seeded.identity.path), 'ABC'); return seeded.identity;
    };
    const report = async (name: string, value: { [key: string]: unknown }) => {
      cases++; results.push({ name, ...value }); console.log('Native peer controlled counter:', { name, ...value });
      await writeFile(path.join(evidenceRoot, 'result.json'), JSON.stringify({ schema, pid: process.pid, cases, results }, null, 2), { mode: 0o600 });
    };
    const incomingOnly = process.argv.includes('--incoming-preflight-only');
    try {
      if (!incomingOnly) {
      const baseline = await newCase('baseline'), initial = await httpSession(baseline); assert.equal(initial.status, 200);
      assert.equal(initial.body.documentId, baseline.documentId); assert.equal(initial.body.permission, 'write');
      const healthy = await connect(baseline, String(initial.body.token)); await accepted(healthy); await closePeer(healthy);
      await report('original HTTP 200 and uncontended actual Auth/snapshot', { status: initial.status, incoming: healthy.incoming });

      const httpObservations = [];
      for (const variant of [{ kind: 'row', beforeOrigin: false }, { kind: 'table', beforeOrigin: false }, { kind: 'row', beforeOrigin: true }] as const) {
        const { kind, beforeOrigin } = variant;
        const httpIdentity = await newCase(`http-${kind}-${beforeOrigin ? 'origin' : 'phase'}-busy`); httpQueries = [];
        plan = { phase: 'http', kind, beforeOrigin, fired: false, releaseAfterClose: false, attempts: 0 };
        const httpBusy = await httpSession(httpIdentity);
        console.log('Actual HTTP phase counter:', { kind, status: httpBusy.status, code: httpBusy.body.code, failures: httpQueries.filter(query => query.code) });
        assert(plan.fired);
        if (beforeOrigin) assert.equal(httpQueries.some(query => query.command === 'org-nowait-lock'), false);
        else assert(httpQueries.some(query => query.code === '55P03'));
        assert.equal(httpBusy.status, kind === 'row' ? 503 : 409);
        assert.equal(httpBusy.body.code, kind === 'row' ? 'PRINCIPAL_WORKSPACE_UNCONFIRMED' : 'PRINCIPAL_BUSY');
        assert.equal(Object.hasOwn(httpBusy.body, 'token'), false);
        if (kind === 'row') assert(httpQueries.some(query => query.command === 'factory-org-update' && query.code === '57014'));
        const observation = { kind, beforeOrigin, status: httpBusy.status, code: httpBusy.body.code, blocker: plan.blockerProof, queries: httpQueries.filter(query => query.code || ['BEGIN', 'COMMIT', 'ROLLBACK', 'org-nowait-lock', 'factory-org-update'].includes(query.command)) };
        httpObservations.push(observation); await releaseHolder(); plan = undefined;
        assert.equal((await httpSession(httpIdentity)).status, 200);
      }
      await report('actual HTTP distinguishes native table Busy from an unconfirmed fresh factory', { observations: httpObservations });

      for (const [phase, kind] of [['capture', 'table'], ['join', 'table']] as const) {
        const identity = await newCase(`${phase}-${kind}`), session = await httpSession(identity); assert.equal(session.status, 200);
        plan = { phase, kind, fired: false, releaseAfterClose: false, attempts: 0 }; const start = transactions.length;
        const retiredBefore = originRetirements.length, disposedBefore = originDisposals.length;
        const timelineBefore = originTimeline.length;
        const peer = await connect(identity, String(session.body.token));
        assert(plan.fired, 'the actual selected Origin phase must reach its genuine lock gate');
        assert(peer.incoming.some(message => message.auth === AuthMessageType.PermissionDenied && message.reason === NATIVE_PEER_ADMISSION_BUSY_REASON));
        assert(!peer.incoming.some(message => message.auth === AuthMessageType.Authenticated));
        const retired = originRetirements.slice(retiredBefore), blocker = plan.blockerProof;
        assert.equal(retired.length, 3, 'the entire Admission has exactly three qualified failed attempts');
        assert.deepEqual(retired.map(record => record.phase), phase === 'capture' ? ['capture', 'capture', 'capture'] : ['join', 'capture', 'capture']);
        for (const retirement of retired) {
          assert.equal(retirement.eligible, true); assert.deepEqual(retirement.events, ['BEGIN', 'ROLLBACK', 'close']);
        }
        const timeline = originTimeline.slice(timelineBefore);
        assert.deepEqual(timeline.map(entry => entry.event), ['capture_begin', 'retire_complete', 'capture_begin',
          'retire_complete', 'capture_begin', 'retire_complete', 'dispose_complete'], 'actual retirement completion must precede the next Capture');
        for (let attempt = 0; attempt < 3; attempt++) assert.equal(timeline[attempt * 2 + 1].recordId, retired[attempt].recordId);
        assert.equal(originDisposals.length, disposedBefore + 1, 'actual Origin finally disposal must settle before AuthDenied');
        const busy = [...inspectBusy(start, 'capture', false, phase === 'capture' ? 3 : 2),
          ...(phase === 'join' ? inspectBusy(start, 'join', false, 1) : [])];
        if (phase === 'join') {
          const capture = transactions.slice(start).find(record => record.phase === 'capture' && record.events.includes('COMMIT')); assert(capture);
          assert.equal(capture.events.join(','), 'BEGIN,COMMIT,close');
          assert.equal(retired[0].captureRecordId, capture.id, 'actual completed Join retirement owns the genuinely returned Capture transport disposal');
        } else {
          assert(retired.every(record => record.captureRecordId === null), 'failed Capture need not have returned any transport');
        }
        await releaseHolder(); plan = undefined; await closePeer(peer);
        const fresh = await connect(identity, String(session.body.token)); await accepted(fresh); await closePeer(fresh);
        await report(`HTTP 200 → actual Origin ${phase} ${kind} exhausts three total attempts; fresh handshake succeeds`,
          { status: session.status, incoming: peer.incoming, busy, blocker, retired, timeline, originFinallyDisposed: true, freshIncoming: fresh.incoming });
      }

      const revoked = await newCase('permanent-auth-denied'), revokedSession = await httpSession(revoked); assert.equal(revokedSession.status, 200);
      const originalToken = tokens.owner; await admin.query('UPDATE "session" SET token=$1 WHERE id=$2', [crypto.randomBytes(32).toString('hex'), 'session-owner']);
      const deniedStart = transactions.length, denied = await connect(revoked, String(revokedSession.body.token));
      assert(denied.incoming.some(message => message.auth === AuthMessageType.PermissionDenied)); assert.equal(transactions.length, deniedStart);
      await closePeer(denied); await admin.query('UPDATE "session" SET token=$1 WHERE id=$2', [originalToken, 'session-owner']);
      await report('permanent actual session revocation is denied before native Capture', { status: revokedSession.status, incoming: denied.incoming, nativePhases: 0 });

      for (const phase of ['connected', 'beforeHandleMessage'] as const) {
        const kinds = phase === 'connected' ? ['table'] as const : ['row', 'table'] as const;
        for (const kind of kinds) {
          const identity = await newCase(`${phase}-${kind}`), session = await httpSession(identity); assert.equal(session.status, 200);
          const releaseAfterClose = phase === 'beforeHandleMessage' && kind === 'row';
          const start = transactions.length;
          let precedingSyncs = 0;
          if (phase === 'connected') plan = { phase, kind, fired: false, releaseAfterClose, attempts: 0 };
          const peer = await connect(identity, String(session.body.token));
          assert(peer.incoming.some(message => message.auth === AuthMessageType.Authenticated));
          if (phase === 'beforeHandleMessage') {
            await accepted(peer); plan = { phase, kind, fired: false, releaseAfterClose, attempts: 0 };
            precedingSyncs = peer.incoming.filter(message => message.type === MessageType.Sync).length;
            const empty = new Y.Doc(), vector = Y.encodeStateVector(empty); empty.destroy();
            peer.socket.send(frame(identity.documentId, MessageType.Sync, encoder => { encoding.writeVarUint(encoder, 0); encoding.writeVarUint8Array(encoder, vector); }));
          }
          assert(plan);
          if (releaseAfterClose) {
            await waitUntil(() => plan!.attempts === 1 && !plan!.holder && peer.incoming.filter(message => message.type === MessageType.Sync).length > precedingSyncs, 'Retained readonly frame did not complete after actual Busy B close/release.');
            assert.equal(peer.closed(), undefined);
          } else {
            await waitUntil(() => !!peer.closed(), 'Three Busy checks did not close the actual Socket.'); assert.equal(peer.closed()!.code, 1013); assert.equal(plan.attempts, 3);
          }
          const busy = inspectBusy(start, phase, true, releaseAfterClose ? 1 : 3), blocker = plan.blockerProof, close = peer.closed();
          assert(!peer.incoming.some(message => message.auth === AuthMessageType.PermissionDenied || message.bodyType === 'access_revoked'));
          await releaseHolder(); plan = undefined;
          if (releaseAfterClose) await closePeer(peer);
          else { await unloadOwnRoom(identity.documentId); const fresh = await connect(identity, String(session.body.token)); await accepted(fresh); await closePeer(fresh); }
          const state = (await admin.query('SELECT document_sequence,yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [identity.documentId])).rows[0];
          assert.equal(Number(state.document_sequence), 7); const doc = new Y.Doc(); Y.applyUpdate(doc, state.yjs_state); assert.equal(doc.getText('content').toString(), 'ABC'); doc.destroy();
          await report(`${phase} ${kind}: ${releaseAfterClose ? 'actual single Busy release→fresh check succeeds' : 'actual three fresh Busy Bs close 1013'}`, { status: session.status, incoming: peer.incoming, busy, blocker, close: close ?? null, sequence: Number(state.document_sequence) });
        }
      }
      assert.equal(cases, 8);
      }
      const { readCurrentCollaborationDocument } = await import('../app/lib/collaboration/document-access');
      const survivor = await newCase('incoming-survivor'), survivorSession = await httpSession(survivor);
      assert.equal(survivorSession.status, 200);
      const survivorPeer = await connect(survivor, String(survivorSession.body.token)); await accepted(survivorPeer);
      const survivorDocument = actualRuntime.hocuspocus!.documents.get(survivor.documentId); assert(survivorDocument);
      const survivorProof = collaborationStateProof(survivorDocument, Y); assert(survivorProof);
      const variants = [
        { kind: 'structures', sync: 2 }, { kind: 'structures', sync: 1 },
        { kind: 'deletions', sync: 2 }, { kind: 'deletions', sync: 1 },
        { kind: 'malformed', sync: 2 },
      ] as const;
      for (const variant of variants) {
        const identity = await newCase(`incoming-${variant.kind}-${variant.sync}`), session = await httpSession(identity);
        assert.equal(session.status, 200);
        const peer = await connect(identity, String(session.body.token)); await accepted(peer);
        const live = actualRuntime.hocuspocus!.documents.get(identity.documentId); assert(live);
        const before = Y.encodeStateAsUpdate(live), beforeProof = collaborationStateProof(live, Y); assert(beforeProof);
        const source = new Y.Doc({ gc: false }), expected = new Y.Doc({ gc: false });
        try {
          source.getText('content').insert(0, 'A');
          const prerequisite = Y.encodeStateVector(source), first = Y.encodeStateAsUpdate(source);
          if (variant.kind === 'deletions') source.getText('content').delete(0, 1);
          else source.getText('content').insert(1, 'B');
          const delta = Y.encodeStateAsUpdate(source, prerequisite);
          const candidate = variant.kind === 'malformed' ? new Uint8Array([255]) : delta;
          const handledBefore = handledMessages.get(identity.documentId) ?? 0, incomingBefore = peer.incoming.length;
          peer.socket.send(frame(identity.documentId, MessageType.Sync, encoder => {
            encoding.writeVarUint(encoder, variant.sync); encoding.writeVarUint8Array(encoder, candidate);
          }));
          await waitUntil(() => !!peer.closed(), 'Rejected native candidate must close the actual socket.');
          assert((handledMessages.get(identity.documentId) ?? 0) > handledBefore, 'actual receiver finally must settle');
          const witness = { kind: variant.kind, sync: variant.sync,
            pendingStructures: !!live.store.pendingStructs, pendingDeletes: !!live.store.pendingDs,
            liveBytesUnchanged: Buffer.from(Y.encodeStateAsUpdate(live)).equals(Buffer.from(before)),
            positiveCandidateAcks: peer.incoming.slice(incomingBefore).filter(message => message.acknowledged === true).length,
            socketClose: peer.closed()!.code };
          await writeFile(path.join(evidenceRoot, `incoming-${variant.kind}-${variant.sync}-witness.json`), JSON.stringify(witness, null, 2), { mode: 0o600 });
          assert.equal(witness.pendingStructures, false); assert.equal(witness.pendingDeletes, false);
          assert.equal(witness.liveBytesUnchanged, true); assert.equal(collaborationStateProof(live, Y), beforeProof);
          assert.equal(witness.socketClose, 1013); assert.equal(witness.positiveCandidateAcks, 0);
          assert(!peer.incoming.slice(incomingBefore).some(message => ['update_rejected', 'access_revoked'].includes(message.bodyType ?? '')));
          // Closing the rejected peer may validly store/release its unchanged
          // complete basis. That is never an ACK for the rejected candidate.
          await unloadOwnRoom(identity.documentId);
          const unchanged = (await admin.query('SELECT document_sequence,yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [identity.documentId])).rows[0];
          assert.equal(Number(unchanged.document_sequence), 7);
          assert.deepEqual(Buffer.from(unchanged.yjs_state), Buffer.from(before));
          const readableProof: string | null = await readCurrentCollaborationDocument<string | null>({ documentId: survivor.documentId, workspaceId,
            read: document => { assert.equal(document, survivorDocument); return collaborationStateProof(document, Y); } });
          assert.equal(readableProof, survivorProof, 'one rejected candidate must not dispose the shared owner/reader');
          assert.equal(survivorPeer.closed(), undefined);

          // An explicit fresh join supplies the missing prerequisite. S2 cases
          // exercise a legal dependent delta after A; Update cases exercise
          // the complete client A+B SyncStep2 in a single frame.
          const fresh = await connect(identity, String(session.body.token)); await accepted(fresh);
          const sendAccepted = async (update: Uint8Array, sync: 1 | 2) => {
            const ackBefore = fresh.incoming.filter(message => message.acknowledged === true).length;
            fresh.socket.send(frame(identity.documentId, MessageType.Sync, encoder => {
              encoding.writeVarUint(encoder, sync); encoding.writeVarUint8Array(encoder, update);
            }));
            await waitUntil(() => fresh.incoming.filter(message => message.acknowledged === true).length > ackBefore || !!fresh.closed(), 'Fresh complete native update did not settle.');
            assert.equal(fresh.closed(), undefined); assert.equal(fresh.incoming.filter(message => message.acknowledged === true).length, ackBefore + 1);
          };
          if (variant.sync === 1) { await sendAccepted(first, 1); await sendAccepted(delta, 2); }
          else await sendAccepted(Y.encodeStateAsUpdate(source), 1);
          Y.applyUpdate(expected, before); Y.applyUpdate(expected, Y.encodeStateAsUpdate(source));
          const expectedProof = collaborationStateProof(expected, Y); assert(expectedProof);
          const currentProof = await readCurrentCollaborationDocument({ documentId: identity.documentId, workspaceId,
            read: document => { assert(!document.store.pendingStructs && !document.store.pendingDs); return collaborationStateProof(document, Y); } });
          assert.equal(currentProof, expectedProof);
          await closePeer(fresh); await unloadOwnRoom(identity.documentId);
          const persisted = (await admin.query('SELECT document_sequence,yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [identity.documentId])).rows[0];
          const stored = new Y.Doc({ gc: false });
          try {
            Y.applyUpdate(stored, persisted.yjs_state);
            assert(!stored.store.pendingStructs && !stored.store.pendingDs);
            assert.equal(collaborationStateProof(stored, Y), expectedProof);
            assert(Number(persisted.document_sequence) > 7);
          } finally { stored.destroy(); }
          await report('native preflight rejects candidate, preserves survivor, and fresh join persists complete state',
            { ...witness, unchangedSequence: 7, survivorReaderAvailable: true, freshPersistedProofMatches: true });
        } finally { source.destroy(); expected.destroy(); }
      }
      await closePeer(survivorPeer); await unloadOwnRoom(survivor.documentId);
      assert.equal(cases, incomingOnly ? 5 : 13); assert.equal(fetches, 0);
    } finally {
      try {
      Client.prototype.query = rawQuery;
      await releaseHolder(); plan = undefined; for (const socket of sockets) socket.terminate();
      await waitUntil(() => [...actualRuntime.hocuspocus?.documents.values() ?? []].every(document => document.getConnectionsCount() === 0), 'Owned Source connections did not close.');
      await productServer.flushCollaborationDocuments();
      if (actualRuntime.hocuspocus) { await Promise.allSettled([...actualRuntime.hocuspocus.documents.values()].map(document => actualRuntime.hocuspocus!.unloadDocument(document))); await Promise.allSettled([...actualRuntime.hocuspocus.unloadingDocuments.values()]); }
      await new Promise<void>(done => wss.close(() => done())); await new Promise<void>(done => server.close(() => done()));
      for (const document of documents) document.destroy(); Hocuspocus.prototype.hooks = originalHooks;
      await writeFile(path.join(evidenceRoot, 'source-counter-closure.json'), JSON.stringify({ pid: process.pid, serverListening: server.listening, remainingSockets: [...sockets].filter(socket => socket.readyState !== WebSocket.CLOSED).length, documentId: currentDocumentId }, null, 2), { mode: 0o600 });
      } finally {
        await writeFile(path.join(evidenceRoot, 'owner-observations.json'), JSON.stringify(ownerObservations, null, 2), { mode: 0o600 });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    try { if (pool) await pool.end(); } finally {
      try { for (const client of clients) await client.end(); } finally {
        try { if (created) { await control.query(`DROP SCHEMA "${schema}" CASCADE`); assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true); } }
        finally { await control.end(); await rm(dataRoot, { recursive: true, force: true }); for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment); }
      }
    }
  }
}
main().catch(error => { console.error('Controlled native peer Busy fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message.slice(0, 200) : null, code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null }); process.exitCode = 1; });
