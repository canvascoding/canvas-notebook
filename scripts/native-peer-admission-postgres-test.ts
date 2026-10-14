import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { AuthenticatedNativeSessionTransport, AuthenticatedNativePeerOrigin } from '../app/lib/collaboration/authenticated-native-session-transport';
import type { ExistingNativeSessionIdentity } from '../app/lib/collaboration/native-session-state-reader';

const fixtureRoot = path.resolve(path.dirname(process.argv[1]), '..');
const fixtureRequire = createRequire(path.join(fixtureRoot, 'package.json'));
type TransportModule = typeof import('../app/lib/collaboration/authenticated-native-session-transport');
type AdmissionModule = typeof import('../app/lib/collaboration/authenticated-native-peer-admission');
import type { CollaborationTicketClaims } from '../app/lib/collaboration/types';
const runtimeKey = Symbol.for('canvas.authenticated-native-session-runtime');

/** Separate actual source instances: only import/require paths change. */
async function sourceCopies() {
  const root = await mkdtemp(path.join(tmpdir(), 'canvas-native-peer-admission-modules-'));
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
      ['app/lib/collaboration/authenticated-native-peer-admission.ts', path.join(root, `admission-${copy}.ts`)],
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
          if (target === path.join(fixtureRoot, 'app/lib/collaboration/authenticated-native-session-transport')) target = paths[copy];
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
  return { root, requests: { A: NextRequest, B: alternateNext },
    load: async (copy: 'A' | 'B') => await import(pathToFileURL(paths[copy]).href) as TransportModule,
    admission: async (copy: 'A' | 'B') => await import(pathToFileURL(path.join(root, `admission-${copy}.ts`)).href) as AdmissionModule };
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
  const schema = `native_peer_admission_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_peer_admission_[a-f0-9]{32}$/u);
  const workspaceId = `native-transport-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-peer-admission-access-'));
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
    const admission = await copies.admission(order === 'A' ? 'B' : 'A');
    const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
    const { createPlainTextYDoc, createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { NATIVE_PEER_ADMISSION_BUSY_REASON } = await import('../app/lib/collaboration/failure');
    assert.equal(Reflect.get(Object.getOwnPropertyDescriptor(globalThis, runtimeKey)!.value, 'version'), 2);
    const request = async (cookie = true, copy: 'A' | 'B' = 'A') => {
      const headers = new Headers({ 'x-canvas-workspace-id': workspaceId });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens.owner,
        process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${tokens.owner}`);
      const actual = new copies.requests[copy]('http://localhost/api/files/collaboration/session', { method: 'POST', headers });
      assert.equal((await auth.api.getSession({ headers: actual.headers }))?.session.id, 'session-owner');
      return actual;
    };
    const seed = async (label: string, representation: ExistingNativeSessionIdentity['representation'] = 'plain_text') => {
      const documentId = `doc-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`, filePath = `${label}.md`;
      const doc = representation === 'plain_text' ? createPlainTextYDoc('Synthetic native data')
        : createRichMarkdownYDoc('# Synthetic native data\n', representation);
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc));
      const proof = collaborationStateProof(doc, Y)!; doc.destroy();
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','principal-org',$3,'active',100)`, [lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization','principal-org',$4,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,'principal-org',$3,$4,1,1,$5,$6,7,100,0,NULL,NULL,NULL,'lf',0,0,'active')`,
      [documentId, workspaceId, filePath, representation, update, vector]);
      const identity: ExistingNativeSessionIdentity = { documentId, lineageId, workspaceId, organizationId: 'principal-org',
        path: filePath, lifecycleGeneration: 1, representation, schemaVersion: 1 };
      return { identity, update, vector, proof };
    };
    type Target = Awaited<ReturnType<typeof seed>>;
    const stored = async (target: Target) => (await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId])).rows[0];
    const ticketClaims = (target: Target, permission: 'read' | 'write' = 'write'): CollaborationTicketClaims => ({
      documentId: target.identity.documentId, workspaceId, organizationId: 'principal-org', path: target.identity.path,
      lifecycleGeneration: 1, representation: target.identity.representation, schemaVersion: 1,
      userId: 'owner', sessionId: 'session-owner', provider: 'yjs', permission,
      issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
    const errorCode = (error: unknown) => error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const busyReason = (error: unknown) => error && typeof error === 'object' ? Reflect.get(error, 'reason') : undefined;
    const code = (...expected: string[]) => (error: unknown) => expected.includes(String(errorCode(error)));
    const check = async (label: string, operation: () => Promise<void>) => {
      stage = label; await operation(); cases++; console.log(JSON.stringify({ scope: 'owned-source-PG18', order, case: label, passed: true }));
    };
    const ignored = new Set<Client>([admin, control]);
    const hold = async (kind: 'principal' | 'reader' | 'final') => {
      const holder = await ownClient(); ignored.add(holder); await holder.query('BEGIN');
      if (kind === 'principal') await holder.query('LOCK TABLE canvas_project_members IN SHARE MODE');
      else if (kind === 'reader') await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
      else await holder.query('LOCK TABLE fixture_final_gate IN SHARE MODE');
      let released = false;
      return { client: holder, release: async () => {
        if (released) return; released = true; await holder.query('ROLLBACK'); await endClient(holder); ignored.delete(holder);
      } };
    };
    await admin.query('CREATE TABLE fixture_final_gate(id integer PRIMARY KEY)');
    await admin.query(`INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at)
      VALUES('fixture-customer','principal-org','Synthetic customer','synthetic-customer','active',100,100)`);
    type SqlTrace = { outerBegins: number; begins: number; commits: number; rollbacks: number; releases: number; closeAcks: number;
      nativeDml: number; postgresBusy: number; nativeLocks: number; captureBindings: number;
      sequence: string[]; firstNativeLock: boolean };
    type Observer = { rollback?: (client: Client, trace: SqlTrace) => Promise<void>;
      after?: (client: Client, sql: string, trace: SqlTrace) => Promise<void>;
      begin?: (client: Client, trace: SqlTrace) => Promise<void>; fault?: 'commit' | 'rollback' | 'close' };
    const actualQuery = Client.prototype.query;
    const observed = async <T>(observer: Observer, operation: (trace: SqlTrace) => Promise<T>) => {
      const trace: SqlTrace = { outerBegins: 0, begins: 0, commits: 0, rollbacks: 0, releases: 0, closeAcks: 0,
        nativeDml: 0, postgresBusy: 0, nativeLocks: 0, captureBindings: 0, sequence: [], firstNativeLock: false };
      // Auth/Organization bootstrap legitimately opens other actual B's.
      // Only the SQL identity probe unique to the genuine Principal tags an
      // Admission B; no factory result or authority is substituted here.
      const inTransactions = new Map<Client, { admission: boolean; closed: boolean }>();
      const originalReleases = new Map<Client, (...args: unknown[]) => unknown>();
      let fired = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'text'));
        const owned = !ignored.has(this) && String(Reflect.get(Reflect.get(this, 'connectionParameters'), 'options')).includes(schema);
        if (!owned || args.some(argument => typeof argument === 'function')) return Reflect.apply(actualQuery, this, args);
        return Promise.resolve(Reflect.apply(actualQuery, this, args)).then(async value => {
          if (sql === 'BEGIN') {
            // The fixed helper opens its own B before entering a factory. Nested
            // factory metadata B's cannot be counted as another native attempt.
            if (![...inTransactions.values()].some(transaction => !transaction.closed)) trace.outerBegins++;
            const transaction = { admission: false, closed: false }; inTransactions.set(this, transaction);
            const release = Reflect.get(this, 'release') as ((...args: unknown[]) => unknown) | undefined;
            if (release) {
              originalReleases.set(this, release);
              Reflect.set(this, 'release', (...releaseArgs: unknown[]) => {
                const result = Reflect.apply(release, this, releaseArgs);
                transaction.closed = true;
                if (!transaction.admission) return result;
                trace.releases++; trace.sequence.push('released');
                if (observer.fault === 'close' && !fired) { fired = true; throw new Error('Synthetic close acknowledgement lost.'); }
                trace.closeAcks++; return result;
              });
            }
          }
          const transaction = inTransactions.get(this);
          if (transaction && !transaction.admission && sql.includes("current_setting('session_replication_role') AS replication")) {
            assert.equal([...inTransactions.values()].some(other => other !== transaction && other.admission && !other.closed), false,
              'the next native admission B starts after confirmed close/disposal of its predecessor');
            transaction.admission = true; trace.begins++; trace.sequence.push('begin'); await observer.begin?.(this, trace);
          }
          if (!transaction?.admission) return value;
          if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql) && /\b(?:collaboration_|file_collaboration_)/u.test(sql)) trace.nativeDml++;
          if (sql.includes('pg_try_advisory_xact_lock_shared')) {
            trace.nativeLocks++; if (trace.begins === 1) trace.firstNativeLock = true;
          }
          if (sql.includes('token_hash,s.expires_at') && sql.includes('schema_oid')) trace.captureBindings++;
          if (sql === 'ROLLBACK') {
            trace.rollbacks++; trace.sequence.push('rollback'); await observer.rollback?.(this, trace);
            if (observer.fault === 'rollback' && !fired) { fired = true; throw new Error('Synthetic rollback acknowledgement lost.'); }
          }
          if (sql === 'COMMIT') {
            trace.commits++; trace.sequence.push('commit');
            if (observer.fault === 'commit' && !fired) { fired = true; throw new Error('Synthetic commit acknowledgement lost.'); }
          }
          await observer.after?.(this, sql, trace); return value;
        }, error => {
          if (errorCode(error) === '55P03') trace.postgresBusy++;
          throw error;
        });
      } as typeof Client.prototype.query;
      try { const value = await operation(trace); return { value, trace }; }
      finally {
        Client.prototype.query = actualQuery;
        for (const [client, release] of originalReleases) Reflect.set(client, 'release', release);
      }
    };
    const admissionFor = async (target: Target, cookie = true, permission: 'read' | 'write' = 'write', transport?: AuthenticatedNativeSessionTransport) =>
      admission.authenticateNativePeerAdmission({ request: await request(cookie, order === 'A' ? 'B' : 'A'),
        claims: ticketClaims(target, permission), ...(transport ? { transport } : {}) });
    const direct = <T>(operation: (db: SqlConnection) => Promise<T>, after?: (client: Client, sql: string) => Promise<void>) => executeLifecycleTransaction({
      openConnection: async () => {
        const client = await ownClient(); ignored.add(client);
        return { get: async (sql, values) => { const result = await client.query(sql, values); await after?.(client, sql); return result.rows[0]; },
          all: async (sql, values) => { const result = await client.query(sql, values); await after?.(client, sql); return result.rows; },
          run: async (sql, values) => { const result = await client.query(sql, values); await after?.(client, sql); return { changes: result.rowCount ?? 0 }; },
          close: async () => { await endClient(client); ignored.delete(client); } };
      }, execute: operation, recoverCommitted: async () => { throw new Error('Direct fixture commit was not confirmed.'); },
    });
    const capture = async (origin: AuthenticatedNativePeerOrigin) => direct(db => B.captureAuthenticatedNativePeerOriginTransportOnConnection(db, origin));
    const restoreAuth = async () => {
        await admin.query('UPDATE "user" SET banned=0 WHERE id=$1', ['owner']);
        await admin.query('UPDATE "session" SET impersonated_by=NULL WHERE id=$1', ['session-owner']);
        // A denied genuine factory may invalidate/cache the old credential.
        // Independent fixtures use a newly seeded real session and signed cookie.
        await seedSession();
        const restored = (await admin.query('SELECT EXISTS(SELECT 1 FROM "session" WHERE id=$1) AS present,\n'
          + '(SELECT banned=0 FROM "user" WHERE id=$2) AS active', ['session-owner', 'owner'])).rows[0];
        assert.equal(restored.present, true); assert.equal(restored.active, true);
    };
    const changeAuth = (field: 'banned' | 'impersonation') => field === 'banned'
        ? admin.query('UPDATE "user" SET banned=1 WHERE id=$1', ['owner'])
      : admin.query('UPDATE "session" SET impersonated_by=$1 WHERE id=$2', ['inactive', 'session-owner']);
    const publishedMobileCap = async (target: Target) => {
      process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
      const { POST } = await import('../app/api/mobile/v1/notebook/collaboration/session/route');
      const { consumeMobileCollaborationTicket } = await import('../app/lib/mobile/collaboration-ticket');
      const actual = await request(false), headers = new Headers(actual.headers); headers.set('content-type', 'application/json');
      const response = await POST(new NextRequest('http://localhost/api/mobile/v1/notebook/collaboration/session', { method: 'POST', headers,
        body: JSON.stringify({ path: target.identity.path, richTextSchemaVersion: 3, blockTreeFormatVersion: 1 }) }));
      assert.equal(response.status, 200);
      const wire = await response.json() as { token: string; documentId: string };
      assert.equal(wire.documentId, target.identity.documentId);
      const consumed = consumeMobileCollaborationTicket(wire.token); assert(consumed?.authenticatedTransport);
      assert.equal(consumeMobileCollaborationTicket(wire.token), null);
      return consumed.authenticatedTransport;
    };

    if (process.argv[3] === '--transport-origin-regressions') {
      const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
      const outcomes: Array<{ case: string; red: boolean }> = [];
      for (const boundary of ['existing', 'read-join-healthy', 'read-join-quarantine', 'diagnosis', 'owned'] as const) {
        stage = `post-HTTP-${boundary}-impersonation`;
        const target = await seed(`http-${boundary}`);
        if (boundary === 'diagnosis' || boundary === 'read-join-quarantine') await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [target.identity.documentId]);
        const cap = await publishedMobileCap(target);
        let owner: Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>> | undefined;
        let ownerClient: Client | undefined;
        let ownerFence: Awaited<ReturnType<Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>['acquire']>> | undefined;
        let consumers = 0, failure: unknown;
        try {
          if (boundary === 'owned') {
            ownerClient = await ownClient(); ignored.add(ownerClient);
            owner = await createCollaborationRoomOwnerSession(ownerClient);
            const identity = target.identity;
            ownerFence = await owner.acquire({ documentId: identity.documentId, workspaceId, organizationId: 'principal-org',
              path: identity.path, lifecycleGeneration: 1, representation: identity.representation, schemaVersion: 1 });
          }
          const before = await stored(target); await changeAuth('impersonation');
          try {
            await direct(db => boundary === 'owned'
              ? B.withAuthenticatedOwnedNativeSessionTransportOnConnection(db, cap,
                { permission: 'canRead', identity: target.identity, ownerFence: ownerFence! }, async access => {
                  consumers++; assert.deepEqual(access.identity, target.identity); await access.assertCurrent();
                })
              : boundary === 'read-join-healthy' || boundary === 'read-join-quarantine'
                ? B.withAuthenticatedNativeSessionReadJoinTransportOnConnection(db, cap,
                  { path: target.identity.path }, async (snapshot, access) => {
                    consumers++; assert.equal(snapshot.snapshot.documentId, target.identity.documentId); await access.assertCurrent();
                  })
              : boundary === 'diagnosis'
                ? B.withAuthenticatedNativeSessionDiagnosisTransportOnConnection(db, cap,
                  { path: target.identity.path, expectedIdentity: target.identity }, async (snapshot, access) => {
                    consumers++; assert.equal(snapshot.snapshot.documentId, target.identity.documentId); await access.assertCurrent();
                  })
                : B.withAuthenticatedNativeSessionTransportOnConnection(db, cap,
                  { permission: 'canRead', path: target.identity.path, expectedIdentity: target.identity }, async (snapshot, access) => {
                    consumers++; assert.equal(snapshot.snapshot.documentId, target.identity.documentId); await access.assertCurrent();
                  }));
          } catch (error) { failure = error; }
          const red = consumers > 0 || failure === undefined;
          outcomes.push({ case: boundary, red });
          console.log(JSON.stringify({ scope: 'owned-PG-existing-HTTP-provenance', order, boundary, red,
            actualMobileStatus: 200, mobileTicketConsumes: 1, consumers, failureCode: errorCode(failure) ?? null }));
          assert.deepEqual(await stored(target), before);
        } finally {
          await A.disposeAuthenticatedNativeSessionTransport(cap); await owner?.close();
          if (ownerClient) { clients.delete(ownerClient); ignored.delete(ownerClient); }
          await restoreAuth();
        }
      }
      assert.equal(fetches, 0);
      assert.equal(outcomes.filter(outcome => outcome.red).length, 0, 'a committed HTTP transport must retain its original impersonation across every later reader/owned phase');
      return;
    }

    if (process.argv[3] === '--auth-origin-regressions') {
      const outcomes: Array<{ case: string; red: boolean }> = [];
      for (const transient of [false, true]) {
        stage = `stable-before-Factory-impersonation-${transient}`;
        const target = await seed(`stable-imp-${transient}`), before = await stored(target);
        await changeAuth('impersonation'); const holder = transient ? await hold('principal') : undefined;
        let accepted: Awaited<ReturnType<typeof admissionFor>> | undefined;
        try {
          const { trace } = await observed({ rollback: async (_client, trace) => {
            if (transient && trace.rollbacks === 1) await holder?.release();
          } }, async () => { accepted = await admissionFor(target); });
          assert(accepted); assert.deepEqual(accepted.identity, target.identity);
          assert.equal(trace.outerBegins, transient ? 3 : 2); assert.equal(trace.rollbacks, transient ? 1 : 0);
          assert.equal(trace.nativeDml, 0); assert.deepEqual(await stored(target), before);
          console.log(JSON.stringify({ scope: 'owned-PG-stable-genuine-impersonation', order, transient,
            accepted: true, admissionStarts: trace.outerBegins, nativeDml: trace.nativeDml }));
        } finally { await holder?.release(); if (accepted) await A.disposeAuthenticatedNativeSessionTransport(accepted.transport); await restoreAuth(); }
      }
      for (const field of ['banned', 'impersonation'] as const) {
        stage = `prelock-${field}`;
        const target = await seed(`prelock-${field}`), before = await stored(target);
        const origin = A.createAuthenticatedNativePeerOrigin(await request(true), { workspaceId, maxPermission: 'canWrite' });
        let holder: Awaited<ReturnType<typeof hold>> | undefined, changed = false, failure: unknown;
        let eligible = false;
        try {
          await assert.rejects(direct(db => B.captureAuthenticatedNativePeerOriginTransportOnConnection(db, origin), async (_client, sql) => {
            if (!changed && sql.includes("current_setting('session_replication_role') AS replication")) {
              changed = true; await changeAuth(field); holder = await hold('principal');
            }
          }), error => { failure = error; return true; });
          assert.equal(changed, true);
          assert(code('PRINCIPAL_BUSY', 'PRINCIPAL_AUTH_REVOKED', 'PRINCIPAL_SCOPE_CHANGED', 'NATIVE_TRANSPORT_SCOPE_CHANGED')(failure),
            'the pre-lock failure must come from the genuine domain validation, not a fixture SQL/setup error');
          eligible = await B.retireAuthenticatedNativePeerOriginAttempt(origin, failure);
        } finally { await holder?.release(); await A.disposeAuthenticatedNativePeerOrigin(origin); await restoreAuth(); }
        let helperHolder: Awaited<ReturnType<typeof hold>> | undefined, helperChanged = false, helperFailure: unknown;
        let accepted: Awaited<ReturnType<typeof admissionFor>> | undefined;
        try {
          const { trace } = await observed({ begin: async () => {
            if (helperChanged) return;
            helperChanged = true; await changeAuth(field); helperHolder = await hold('principal');
          } }, async () => { try { accepted = await admissionFor(target); } catch (error) { helperFailure = error; } });
          assert.equal(helperChanged, true);
          const red = eligible || trace.outerBegins > 1 || Boolean(accepted);
          outcomes.push({ case: `prelock-${field}`, red });
          console.log(JSON.stringify({ scope: 'owned-PG-product-prelock', order, field, red, qualifiedRetirement: eligible,
            helperAdmissionStarts: trace.outerBegins, helperTaggedPrincipalB: trace.begins, historicalOriginReads: trace.captureBindings,
            helperAccepted: Boolean(accepted), helperCode: errorCode(helperFailure) ?? null,
            helperBusyReason: busyReason(helperFailure) ?? null, nativeDml: trace.nativeDml }));
          assert.deepEqual(await stored(target), before);
        } finally { await helperHolder?.release(); if (accepted) await A.disposeAuthenticatedNativeSessionTransport(accepted.transport); await restoreAuth(); }
      }
      stage = 'cross-attempt impersonator drift';
      const target = await seed('impersonator-drift'), before = await stored(target), holder = await hold('principal');
      let accepted: Awaited<ReturnType<typeof admissionFor>> | undefined, failure: unknown, changed = false;
      try {
        const { trace } = await observed({ rollback: async (_client, trace) => {
          if (trace.rollbacks !== 1) return;
          await holder.release(); await changeAuth('impersonation'); changed = true;
        } }, async () => { try { accepted = await admissionFor(target); } catch (error) { failure = error; } });
        assert.equal(changed, true);
        const red = Boolean(accepted) || busyReason(failure) === NATIVE_PEER_ADMISSION_BUSY_REASON;
        outcomes.push({ case: 'cross-attempt-impersonator', red });
        console.log(JSON.stringify({ scope: 'owned-PG-product-origin', order, red, helperAccepted: Boolean(accepted),
          helperAdmissionStarts: trace.outerBegins, helperTaggedPrincipalB: trace.begins,
          helperCode: errorCode(failure) ?? null, helperBusyReason: busyReason(failure) ?? null, nativeDml: trace.nativeDml }));
        assert.deepEqual(await stored(target), before);
      } finally { await holder.release(); if (accepted) await A.disposeAuthenticatedNativeSessionTransport(accepted.transport); await restoreAuth(); }
      assert.equal(fetches, 0);
      assert.equal(outcomes.filter(outcome => outcome.red).length, 0,
        'known-invalid pre-lock auth and cross-attempt impersonation must never be eligible for historical-origin retry');
      return;
    }

    for (const kind of ['principal', 'reader'] as const) for (const persistent of [false, true]) await check(`${kind}-${persistent ? 'max3' : 'release'} genuine contention`, async () => {
      const target = await seed(`${kind}-${persistent}`), before = await stored(target), holder = await hold(kind);
      let enrolled: Awaited<ReturnType<typeof admissionFor>> | undefined;
      try {
        const { trace } = await observed({ rollback: async (_client, trace) => { if (!persistent && trace.rollbacks === 1) await holder.release(); } }, async trace => {
          if (persistent) await assert.rejects(admissionFor(target), error => busyReason(error) === NATIVE_PEER_ADMISSION_BUSY_REASON);
          else enrolled = await admissionFor(target);
          assert.equal(trace.rollbacks, persistent ? 3 : 1);
          assert.equal(trace.begins, kind === 'principal' ? persistent ? 3 : 3 : persistent ? 6 : 4);
          assert.equal(trace.closeAcks, trace.begins); assert.equal(trace.nativeDml, 0);
          assert(trace.captureBindings >= 1, 'historical origin is observed before the first Principal NOWAIT');
          if (kind === 'principal') assert.equal(trace.postgresBusy, persistent ? 3 : 1);
        });
        if (enrolled) { assert.deepEqual(enrolled.identity, target.identity); await A.disposeAuthenticatedNativeSessionTransport(enrolled.transport); }
        assert.deepEqual(await stored(target), before);
        console.log(JSON.stringify({ order, kind, persistent, ...trace, identityUnchanged: true }));
      } finally { await holder.release(); if (enrolled) await A.disposeAuthenticatedNativeSessionTransport(enrolled.transport); }
    });

    await check('quarantine read Join retains fixed-canRead and rejects write Join', async () => {
      const target = await seed('quarantine'); await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [target.identity.documentId]);
      const before = await stored(target);
      const read = await admissionFor(target, false, 'read'); assert.deepEqual(read.identity, target.identity); await A.disposeAuthenticatedNativeSessionTransport(read.transport);
      await assert.rejects(admissionFor(target, true, 'write'), code('NATIVE_SESSION_QUARANTINED'));
      assert.deepEqual(await stored(target), before);
    });

    for (const drift of ['root', 'customer', 'raw-search-path'] as const) await check(`${drift} after first Principal Busy never rebinds origin`, async () => {
      const target = await seed(`drift-${drift}`), before = await stored(target), holder = await hold('principal');
      try {
        const { trace } = await observed({ rollback: async (_client, trace) => {
          if (trace.rollbacks !== 1) return;
          await holder.release();
          if (drift === 'root') await admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2', ['organizations/principal-org/changed-root', workspaceId]);
          if (drift === 'customer') await admin.query("UPDATE canvas_workspaces SET customer_id='fixture-customer' WHERE id=$1", [workspaceId]);
        }, begin: async (client, trace) => {
          if (drift === 'raw-search-path' && trace.begins === 2) await Reflect.apply(actualQuery, client,
            [`SET LOCAL search_path = "${schema}", pg_catalog, "${schema}"`]);
        } }, async trace => {
          await assert.rejects(admissionFor(target), error => {
            assert.notEqual(busyReason(error), NATIVE_PEER_ADMISSION_BUSY_REASON);
            return code('NATIVE_TRANSPORT_SCOPE_CHANGED', 'PRINCIPAL_SCOPE_CHANGED')(error);
          });
          assert.equal(trace.begins, 2); assert.equal(trace.rollbacks, 2); assert.equal(trace.closeAcks, 2); assert.equal(trace.nativeDml, 0);
        });
        assert.deepEqual(await stored(target), before); console.log(JSON.stringify({ order, drift, ...trace, freshOriginRebinds: 0 }));
      } finally { await holder.release(); await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared',customer_id=NULL WHERE id=$1", [workspaceId]); }
    });

    for (const fault of ['commit', 'close', 'rollback'] as const) await check(`${fault} acknowledgement failure never retries`, async () => {
      const target = await seed(`ack-${fault}`), before = await stored(target);
      const holder = fault === 'rollback' ? await hold('principal') : undefined;
      try {
        const { trace } = await observed({ fault }, async trace => {
          await assert.rejects(admissionFor(target), error => busyReason(error) !== NATIVE_PEER_ADMISSION_BUSY_REASON);
          assert.equal(trace.begins, 1); assert.equal(trace.releases, 1); assert.equal(trace.nativeDml, 0);
          if (fault === 'close') assert.equal(trace.closeAcks, 0);
        });
        assert.deepEqual(await stored(target), before); console.log(JSON.stringify({ order, fault, ...trace, retries: 0 }));
      } finally { await holder?.release(); }
    });

    await check('genuine PostgreSQL Busy after Capture callback entry cannot replay CaptureFinal', async () => {
      const target = await seed('capture-final'), before = await stored(target), holder = await hold('final'); let fired = false;
      try {
        const { trace } = await observed({ after: async (client, sql) => {
          if (fired || !sql.includes('FROM pg_stat_activity a JOIN canvas_workspaces w')) return;
          fired = true;
          await Reflect.apply(actualQuery, client, ['LOCK TABLE fixture_final_gate IN ACCESS EXCLUSIVE MODE NOWAIT']);
        } }, async trace => {
          await assert.rejects(admissionFor(target), error => { assert.notEqual(busyReason(error), NATIVE_PEER_ADMISSION_BUSY_REASON); return code('PRINCIPAL_BUSY')(error); });
          assert.equal(trace.begins, 1); assert.equal(trace.rollbacks, 1); assert.equal(trace.closeAcks, 1); assert.equal(fired, true);
        });
        assert.deepEqual(await stored(target), before); console.log(JSON.stringify({ order, captureFinalReplays: 0, ...trace }));
      } finally { await holder.release(); }
    });

    await check('Native consumer final and real auth revocation cannot retire for retry', async () => {
      for (const fault of ['consumer', 'native-final', 'revocation'] as const) {
        const target = await seed(`consumer-${fault}`), before = await stored(target);
        const origin = A.createAuthenticatedNativePeerOrigin(await request(true), { workspaceId, maxPermission: 'canWrite' });
        const cap = await capture(origin); let consumers = 0, failure: unknown, finalFired = false;
        const holder = fault === 'native-final' ? await hold('final') : undefined;
        try {
          await assert.rejects(direct(db => B.withAuthenticatedNativePeerOriginJoinOnConnection(db, origin, cap,
            { path: target.identity.path, permission: 'write' }, async (_snapshot, access) => {
              consumers++; assert.equal(access.userId, 'owner');
              if (fault === 'revocation') { await db.run('UPDATE "session" SET expires_at=0 WHERE id=$1', ['session-owner']); return; }
              if (fault === 'native-final') return;
              throw new Error('Synthetic native consumer final failure.');
            }), async (client, sql) => {
              if (fault === 'native-final' && consumers === 1 && !finalFired && sql.startsWith('SELECT d.id,d.lineage_id')) {
                finalFired = true; await client.query('LOCK TABLE fixture_final_gate IN ACCESS EXCLUSIVE MODE NOWAIT');
              }
            }), error => { failure = error; return busyReason(error) !== NATIVE_PEER_ADMISSION_BUSY_REASON; });
          assert.equal(await A.retireAuthenticatedNativePeerOriginAttempt(origin, failure), false);
          assert.equal(consumers, 1); assert.deepEqual(await stored(target), before);
          if (fault === 'native-final') { assert.equal(finalFired, true); assert.equal(errorCode(failure), 'PRINCIPAL_BUSY'); }
        } finally { await holder?.release(); await A.disposeAuthenticatedNativePeerOrigin(origin); await A.disposeAuthenticatedNativeSessionTransport(cap); }
      }
    });

    await check('foreign, disposed and reentrant origins fail closed across source modules', async () => {
      const foreign = Object.freeze({}) as AuthenticatedNativePeerOrigin;
      await assert.rejects(capture(foreign), code('NATIVE_TRANSPORT_REQUIRED'));
      const disposed = A.createAuthenticatedNativePeerOrigin(await request(true), { workspaceId, maxPermission: 'canWrite' });
      await B.disposeAuthenticatedNativePeerOrigin(disposed);
      await assert.rejects(capture(disposed), code('NATIVE_TRANSPORT_DISPOSED'));
      const reentrant = B.createAuthenticatedNativePeerOrigin(await request(false, 'B'), { workspaceId, maxPermission: 'canWrite' });
      const cap = await capture(reentrant);
      try { await assert.rejects(capture(reentrant), code('NATIVE_TRANSPORT_REENTRANT')); }
      finally { await A.disposeAuthenticatedNativePeerOrigin(reentrant); await A.disposeAuthenticatedNativeSessionTransport(cap); }
    });

    await check('actual Mobile POST single-use ticket cap is first Join iteration', async () => {
      const target = await seed('mobile'), before = await stored(target);
      process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1';
      const { POST } = await import('../app/api/mobile/v1/notebook/collaboration/session/route');
      const { consumeMobileCollaborationTicket, disposeMobileCollaborationTickets } = await import('../app/lib/mobile/collaboration-ticket');
      const actual = await request(false), headers = new Headers(actual.headers); headers.set('content-type', 'application/json');
      const response = await POST(new NextRequest('http://localhost/api/mobile/v1/notebook/collaboration/session', { method: 'POST', headers,
        body: JSON.stringify({ path: target.identity.path, richTextSchemaVersion: 3, blockTreeFormatVersion: 1 }) }));
      assert.equal(response.status, 200);
      const wire = await response.json() as { token: string; documentId: string };
      assert.equal(wire.documentId, target.identity.documentId);
      const consumed = consumeMobileCollaborationTicket(wire.token); assert(consumed?.authenticatedTransport);
      assert.equal(consumeMobileCollaborationTicket(wire.token), null, 'the actual mobile ticket is consumed once');
      const holder = await hold('reader'); let enrolled: Awaited<ReturnType<typeof admissionFor>> | undefined;
      try {
        const { trace } = await observed({ rollback: async (_client, trace) => { if (trace.rollbacks === 1) await holder.release(); } }, async trace => {
          enrolled = await admission.authenticateNativePeerAdmission({ request: await request(true, order === 'A' ? 'B' : 'A'),
            claims: consumed.claims, transport: consumed.authenticatedTransport });
          assert.equal(trace.firstNativeLock, true, 'the pre-captured mobile transport begins in Join, without a redundant Capture');
          assert.equal(trace.begins, 3); assert.equal(trace.rollbacks, 1); assert.equal(trace.closeAcks, 3); assert.equal(trace.nativeDml, 0);
        });
        assert(enrolled); assert.deepEqual(enrolled.identity, target.identity); assert.notEqual(enrolled.transport, consumed.authenticatedTransport);
        assert.equal(consumeMobileCollaborationTicket(wire.token), null);
        assert.deepEqual(await stored(target), before);
        console.log(JSON.stringify({ order, mobileStatus: response.status, mobileTicketConsumes: 1, ...trace }));
      } finally { await holder.release(); if (enrolled) await A.disposeAuthenticatedNativeSessionTransport(enrolled.transport); disposeMobileCollaborationTickets(); }
    });
    assert.equal(fetches, 0);
    console.log(JSON.stringify({ scope: 'owned-source-PG18', order, families: cases, externalFetches: 0, applicationHostStarts: 0 }));
  } finally {
    globalThis.fetch = originalFetch;
    try { if (pool) await pool.end(); } finally {
      try { for (const client of clients) await client.end(); } finally {
        try { if (created) { await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true); } }
        finally { await control.end(); await rm(dataRoot, { recursive: true, force: true }); await rm(copies.root, { recursive: true, force: true });
          for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment); }
      }
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === '--owner=A' || mode === '--owner=B') return worker(mode.endsWith('A') ? 'A' : 'B');
  if (mode === '--auth-origin-regressions' || mode === '--transport-origin-regressions') {
    let failures = 0;
    for (const order of ['A', 'B']) failures += await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, path.resolve(process.argv[1]), `--owner=${order}`, mode],
        { env: process.env, stdio: 'inherit' });
      child.once('error', reject); child.once('exit', status => resolve(status === 0 ? 0 : 1));
    });
    assert.equal(failures, 0, 'pre-lock authorization regression children must pass in both genuine source orders'); return;
  }
  assert.equal(mode, undefined);
  for (const order of ['A', 'B']) await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, path.resolve(process.argv[1]), `--owner=${order}`], { env: process.env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (status, signal) => status === 0 ? resolve()
      : reject(new Error(`Owned source child ${order}-first failed (${status ?? signal}).`)));
  });
  console.log('Native peer admission: both genuine source-module orders passed with owned PostgreSQL/Auth fixtures.');
}
main().catch(error => {
  console.error('Owned native peer admission fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: errorCodeForOutput(error), assertion: error && typeof error === 'object' ? Reflect.get(error, 'operator') ?? null : null });
  process.exitCode = 1;
});
function errorCodeForOutput(error: unknown): string | null {
  const value = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof value === 'string' ? value.slice(0, 128) : null;
}
