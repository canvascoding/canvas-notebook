import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';

// Actual full-DDL PG18/Auth/FS regular planner under the real lifecycle guard.
// A passing run proves a fixed same-owner collector, not Delete/Browser success.
// The original default builder and guard are used without injected snapshots.
// Run only against the existing managed loopback PG18; it creates no app host.
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const schema = `legacy_planner_owner_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^legacy_planner_owner_[a-f0-9]{32}$/u);
  const organizationId = `planner-org-${crypto.randomUUID()}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch, originalQuery = Client.prototype.query;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-legacy-planner-owner-')));
  const applicationName = `planner-fixture-${crypto.randomUUID()}`;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let created = false, controlConnected = false;
  let pool: { end(): Promise<void>; totalCount: number; waitingCount: number } | undefined;
  let cases = 0, fetches = 0;
  const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    await control.connect(); controlConnected = true;
    const realm = (await control.query(`SELECT current_database() AS database,current_user AS role,
      d.oid::bigint AS oid,pg_get_userbyid(d.datdba) AS owner,current_setting('server_version_num') AS version
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.equal(realm.database, 'canvas_notebook'); assert.equal(realm.role, decodeURIComponent(url.username));
    assert.equal(typeof realm.owner, 'string'); assert(realm.owner); assert(Number(realm.oid) > 0);
    assert.equal(Math.floor(Number(realm.version) / 10000), 18);
    assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS absent', [schema])).rows[0].absent, true);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=${applicationName}`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test',
      CANVAS_TEST_NATIVE_TEXT_SESSION: '1' });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS; delete process.env.NEXT_PHASE;
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = digest(keys.publicKey.export({ type: 'spki', format: 'der' }));
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: `planner-license-${crypto.randomUUID()}`,
      sub: process.env.CANVAS_INSTANCE_ID, instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook',
      plan: 'community', status: 'active', hostingMode: 'community', edition: 'team', licenseClass: 'commercial',
      licenseEnvironment: 'production', nonBillable: false, seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6,
      iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No network/issuer is permitted in this isolated fixture.'); };
    const admin = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=${applicationName}` });
    admin.on('error', () => undefined); clients.add(admin); await admin.connect();
    const ownerRealm = async () => {
      const actual = (await admin.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path,
        (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS oid,pg_backend_pid() AS backend`)).rows[0];
      assert.equal(actual.schema, schema); assert.equal(Number(actual.oid), Number(realm.oid));
      assert.deepEqual(actual.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']); return actual;
    };
    const adminBackend = (await ownerRealm()).backend;
    stage = 'actual owned-schema global DDL';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      assert.equal((await ownerRealm()).backend, adminBackend);
      const result = await admin.query(sql, values); await ownerRealm(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    stage = 'real users, Team seats and Cookie/Bearer sessions';
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@starter.test',1,'admin',0,$1,$1),('member','Member','member@starter.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES($1,'owner','team',1,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES($1,'owner','owner','active',1,100,100),($1,'member','member','active',0,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat',$1,'owner@starter.test','owner','owner','active',100,100,100,100),
      ('member-seat',$1,'member@starter.test','member','member','active',100,200,100,100)`, [organizationId]);
    await admin.query('INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES($1,100,100)', [organizationId]);
    const { personalWorkspaceRootRelativePath, organizationWorkspaceRootRelativePath } = await import('../app/lib/workspaces/contracts');
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,is_default,created_at,updated_at)
      VALUES($1,$2,'organization','Organization',$3,'active',1,100,100)`,
    [`organization-${crypto.randomUUID()}`, organizationId, organizationWorkspaceRootRelativePath(organizationId)]);
    for (const user of ['owner', 'member']) await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,
      root_relative_path,status,is_default,created_at,updated_at) VALUES($1,$2,'personal',$3,$3,$4,'active',1,100,100)`,
    [`personal-${crypto.randomUUID()}`, organizationId, user, personalWorkspaceRootRelativePath(user)]);
    const tokens = { owner: crypto.randomBytes(32).toString('hex'), member: crypto.randomBytes(32).toString('hex') };
    for (const user of ['owner', 'member'] as const) await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$5)`, [`session-${user}`, tokens[user], user, now + 3600000, now]);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    const { getLicenseStatus } = await import('../app/lib/license');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    const { auth } = await import('../app/lib/auth');
    const { openDb } = await import('../app/lib/db');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { createPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { completeWorkspaceStarterDocumentInitialization } = await import('../app/lib/workspaces/starter-document-initialization');
    const { POST: createFile } = await import('../app/api/files/create/route');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { withWorkspaceFileLifecycleGuard } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const headers = async (workspaceId: string, cookie: boolean) => {
      const actual = new Headers({ 'x-canvas-workspace-id': workspaceId });
      if (cookie) actual.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens.owner, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else actual.set('authorization', `Bearer ${tokens.owner}`);
      return actual;
    };
    const request = async (workspaceId: string, cookie: boolean) => new NextRequest('http://localhost/api/files/create', {
      method: 'POST', headers: await headers(workspaceId, cookie),
    });
    const session = await auth.api.getSession({ headers: await headers('unused', true) });
    assert(session); assert.equal(session.user.id, 'owner'); const actor = resolveWorkspaceActor(session.user);
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); cases++; console.log(`Legacy planner owner PG18 passed: ${name}`);
    };
    const createdFile = async (workspace: WorkspaceContext, filePath: string, cookie: boolean) => {
      const actualHeaders = await headers(workspace.workspaceId, cookie); actualHeaders.set('content-type', 'application/json');
      const response = await createFile(new NextRequest('http://localhost/api/files/create', {
        method: 'POST', headers: actualHeaders, body: JSON.stringify({ type: 'file', path: filePath }),
      }));
      const result: unknown = await response.json().catch(() => null);
      const success = result !== null && typeof result === 'object' ? Reflect.get(result, 'success') : undefined;
      const code = result !== null && typeof result === 'object' ? Reflect.get(result, 'code') : undefined;
      if (response.status !== 200 || success !== true) console.log('Legacy planner Create public result', {
        status: response.status, success: success === true, code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : null,
      });
      assert.equal(response.status, 200); assert.equal(success, true);
      assert.equal((await readFile(path.join(workspace.rootPath, filePath))).byteLength, 0);
      const registered = (await admin.query(`SELECT id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,yjs_state_lifecycle
        FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active'`, [workspace.workspaceId, filePath])).rows;
      assert.equal(registered.length, 1); const document = registered[0];
      assert.equal(document.workspace_type, workspace.workspaceType); assert.equal(document.provider, 'yjs');
      assert.equal(document.state_version, 0); assert.equal(document.yjs_state_lifecycle, 'never_initialized');
      assert.equal(typeof document.id, 'string'); assert.equal(typeof document.lineage_id, 'string');
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE document_id=$1', [document.id])).rows[0].count, 0);
      return { document, identity: filesystemFileVersion(await stat(path.join(workspace.rootPath, filePath))) };
    };
    // Observe actual SQL only. The original pg result/Promise/callback is returned
    // untouched; no result is supplied or replaced by this instrumentation.
    const kind = (sql: string): 'catalogue' | 'shared' | null => {
      const normalized = sql.replace(/\s+/gu, ' ');
      if (/\bpg_advisory_xact_lock_shared\s*\(/u.test(normalized)) return 'shared';
      return normalized.includes('FROM collaboration_documents d LEFT JOIN collaboration_yjs_states s ON s.document_id=d.id') ? 'catalogue' : null;
    };
    type SqlEvent = { kind: 'catalogue' | 'shared'; backend: number };
    let trace: SqlEvent[] | undefined;
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0] !== null && typeof args[0] === 'object' ? Reflect.get(args[0], 'text') : '';
      const observed = typeof sql === 'string' ? kind(sql) : null;
      if (trace && observed) {
        const backend = Reflect.get(this, 'processID'); assert.equal(typeof backend, 'number');
        trace.push({ kind: observed, backend });
      }
      return Reflect.apply(originalQuery, this, args);
    } as typeof Client.prototype.query;
    const observer = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c default_transaction_read_only=on -c statement_timeout=5000 -c application_name=${applicationName}` });
    observer.on('error', () => undefined); clients.add(observer); await observer.connect();
    const observerRealm = (await observer.query(`SELECT current_setting('transaction_read_only') AS read_only,current_schema() AS schema,
      (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid`)).rows[0];
    assert.equal(observerRealm.read_only, 'on'); assert.equal(observerRealm.schema, schema);
    assert.equal(Number(observerRealm.database_oid), Number(realm.oid));
    type Sample = { backend: number; start: string; database_oid: number; schema: string; search_path: string;
      isolation: string; read_only: string; virtual_xid: string | null; exclusive_held: boolean; shared_held: boolean };
    for (const [workspaceType, cookie] of [['personal', true], ['team', false]] as const) {
      stage = `${workspaceType} genuine Create and Starter initialization`;
      const workspace = await createPostgresWorkspaceForActor(actor, { type: workspaceType, name: `Planner ${workspaceType} ${crypto.randomUUID()}` });
      assert.equal(workspace.workspaceType, workspaceType); assert.equal(workspace.permissions.canWrite, true);
      const actualSession = await auth.api.getSession({ headers: await headers(workspace.workspaceId, cookie) });
      assert(actualSession); assert.equal(actualSession.user.id, 'owner'); assert.equal(actualSession.session.id, 'session-owner');
      const initialized = await completeWorkspaceStarterDocumentInitialization(await request(workspace.workspaceId, cookie), workspace.workspaceId, { requireIntent: true });
      assert.equal(initialized.status, 'completed');
      const filePath = `physical-${crypto.randomUUID()}.txt`, asset = await createdFile(workspace, filePath, cookie);
      const nativeSql = `SELECT document_id,representation,schema_version,lifecycle_generation,document_sequence,persisted_at,yjs_state,state_vector
        FROM collaboration_yjs_states WHERE workspace_id=$1 ORDER BY document_id`;
      const nativeBefore = (await admin.query(nativeSql, [workspace.workspaceId])).rows;
      assert.equal(nativeBefore.length, 1); assert(Buffer.isBuffer(nativeBefore[0].yjs_state)); assert(Buffer.isBuffer(nativeBefore[0].state_vector));
      const scope: WorkspaceOperationBatchScope = { workspace, fileOptions: { workspace } };
      const actions: WorkspaceOperationBatchAction[] = [{ reviewId: crypto.randomUUID(), kind: 'delete', selections: [{ sourcePath: filePath }] }];
      let outside: Awaited<ReturnType<typeof buildWorkspaceOperationBatchPlan>>;
      await check(`${workspaceType}: original default planner outside lifecycle is ready physical V1`, async () => {
        outside = await buildWorkspaceOperationBatchPlan({ scope, actions });
        assert.equal(outside.version, 1); assert.equal(outside.readiness, 'ready'); assert.deepEqual(outside.issues, []);
        assert.deepEqual(outside.deletedPaths, [{ path: filePath, kind: 'file', identity: asset.identity }]);
        assert.deepEqual(outside.pathSteps, [{ reviewId: actions[0].reviewId, kind: 'delete', sourcePath: filePath }]);
      });
      await check(`${workspaceType}: original default planner remains ready under genuine owner B and shared collector fence`, async () => {
        const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(workspace.workspaceId)));
        const lockValues = [Number(realm.oid), Number(key >> BigInt(32)), Number(key & BigInt('0xffffffff'))];
        const sampleSql = `SELECT pg_backend_pid() AS backend,extract(epoch FROM a.backend_start)::text AS start,
          (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,
          current_schema() AS schema,current_setting('search_path') AS search_path,
          current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
          (SELECT virtualtransaction FROM pg_locks WHERE locktype='virtualxid' AND pid=pg_backend_pid() AND granted LIMIT 1) AS virtual_xid,
          EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND pid=pg_backend_pid() AND database=$1::oid
            AND classid::bigint=$2 AND objid::bigint=$3 AND objsubid=1 AND mode='ExclusiveLock') AS exclusive_held,
          EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND pid=pg_backend_pid() AND database=$1::oid
            AND classid::bigint=$2 AND objid::bigint=$3 AND objsubid=1 AND mode='ShareLock') AS shared_held
          FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`;
        const samples: Array<{ kind: 'catalogue' | 'shared'; value: Sample }> = [];
        const events: SqlEvent[] = []; let opened = 0, closed = 0, owner: Sample | undefined;
        let sampleOwner: (() => Promise<Sample>) | undefined;
        let monitorActive = false, waitingSharedObserved = false, observerQueries = 0, observerFailureCode: string | null = null;
        let monitor: Promise<void> | undefined;
        const observeWait = async () => {
          while (monitorActive && observerQueries < 60) {
            // Optional old-RED diagnostic only: the genuine waiting shared
            // backend is blocked by THIS owner on THIS workspace/DB key.
            try {
              const waiting = (await observer.query(`SELECT w.pid FROM pg_locks w JOIN pg_stat_activity a ON a.pid=w.pid
                WHERE w.locktype='advisory' AND NOT w.granted AND w.mode='ShareLock' AND w.objsubid=1
                  AND w.database=$1::oid AND w.classid::bigint=$2 AND w.objid::bigint=$3
                  AND a.application_name=$4 AND $5=ANY(pg_blocking_pids(w.pid))`, [...lockValues, applicationName, owner!.backend])).rows;
              waitingSharedObserved ||= waiting.length > 0; observerQueries++;
            } catch (error) {
              const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
              observerFailureCode = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'OBSERVER_FAILED';
              monitorActive = false;
            }
            if (monitorActive) await new Promise(resolve => setTimeout(resolve, 100));
          }
        };
        try {
          const inside = await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
            assert(owner); assert.equal(owner.exclusive_held, false, 'The pre-guard sample is captured before admission.');
            assert(sampleOwner); const entered = await sampleOwner();
            assert.equal(entered.backend, owner.backend); assert.equal(entered.start, owner.start);
            assert.equal(entered.exclusive_held, true); assert.equal(entered.shared_held, false);
            trace = events; monitorActive = true; monitor = observeWait();
            try {
              // This is the SAME positive assertion before and after the fix.
              // Old product times out its second backend then fails this build;
              // no expected-busy switch, injected snapshot or larger timeout.
              const plan = await buildWorkspaceOperationBatchPlan({ scope, actions });
              assert.equal(plan.version, 1); assert.equal(plan.readiness, 'ready'); assert.deepEqual(plan.issues, []);
              assert.equal(plan.planId, outside!.planId); assert.deepEqual(plan, outside!);
              const completed = await sampleOwner();
              assert.equal(completed.backend, entered.backend); assert.equal(completed.start, entered.start);
              assert.equal(completed.exclusive_held, true); assert.equal(completed.shared_held, false);
              return plan;
            } finally { trace = undefined; monitorActive = false; await monitor; }
          }, async (): Promise<SqlConnection> => {
            opened++; const original = await openDb();
            try {
              owner = await original.get(sampleSql, lockValues) as Sample;
              sampleOwner = async () => await original.get(sampleSql, lockValues) as Sample;
              const observed = async <T>(sql: string, operation: () => T | Promise<T>): Promise<T> => {
                const result = await operation();
                const observedKind = kind(sql);
                if (trace && observedKind) samples.push({ kind: observedKind, value: await original.get(sampleSql, lockValues) as Sample });
                return result;
              };
              return {
                get: (sql, values) => observed(sql, () => original.get(sql, values)),
                all: (sql, values) => observed(sql, () => original.all(sql, values)),
                run: (sql, values) => observed(sql, () => original.run(sql, values)),
                close: async error => { closed++; await original.close(error); },
              };
            } catch (error) {
              closed++; await original.close(error instanceof Error ? error : new Error('Discarding failed fixture observation checkout.')); throw error;
            }
          });
          assert.equal(inside.version, 1); assert.equal(inside.planId, outside!.planId);
          assert(owner); assert.equal(opened, 1); assert.equal(closed, 1);
          assert.equal(events.filter(event => event.kind === 'catalogue').length >= 3, true, 'Initial and final actual catalogue passes must run.');
          assert.equal(events.some(event => event.kind === 'shared'), true, 'Retain the real collector xact shared fence on B.');
          assert(events.every(event => event.backend === owner!.backend), 'No second backend may run the collector or its shared admission request.');
          assert.equal(samples.length, events.length);
          const first = samples[0].value; assert(first.virtual_xid);
          for (const { value } of samples) {
            assert.equal(value.backend, owner.backend); assert.equal(value.start, owner.start);
            assert.equal(Number(value.database_oid), Number(realm.oid)); assert.equal(value.schema, schema);
            assert.equal(value.search_path, owner.search_path); assert.equal(value.isolation, 'read committed'); assert.equal(value.read_only, 'on');
            assert.equal(value.virtual_xid, first.virtual_xid); assert.equal(value.exclusive_held, true); assert.equal(value.shared_held, true);
          }
        } finally {
          trace = undefined; monitorActive = false; if (monitor) await monitor;
          console.log('Legacy planner owner lock observation', { observedWaitingSharedBlockedByOwner: waitingSharedObserved,
            observerQueries, observerFailureCode, collectorCatalogueCalls: events.filter(event => event.kind === 'catalogue').length,
            collectorSharedCalls: events.filter(event => event.kind === 'shared').length, opened, closed });
        }
        assert.equal(filesystemFileVersion(await stat(path.join(workspace.rootPath, filePath))), asset.identity);
        assert.equal((await readFile(path.join(workspace.rootPath, filePath))).byteLength, 0);
        assert.deepEqual((await admin.query(`SELECT id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,yjs_state_lifecycle
          FROM collaboration_documents WHERE id=$1`, [asset.document.id])).rows, [asset.document]);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_yjs_states WHERE document_id=$1', [asset.document.id])).rows[0].count, 0);
        assert.deepEqual((await admin.query(nativeSql, [workspace.workspaceId])).rows, nativeBefore);
      });
    }
    assert.equal(fetches, 0);
    console.log(`Legacy planner owner PG18: ${cases} genuine Personal/Team/Cookie/Bearer/Create/Planner families passed; no Delete, browser or application host acceptance claimed.`);
  } finally {
    Client.prototype.query = originalQuery; globalThis.fetch = originalFetch;
    try { if (pool) { await pool.end(); assert.equal(pool.totalCount, 0); assert.equal(pool.waitingCount, 0); } }
    finally {
      try { for (const client of clients) { await client.end(); clients.delete(client); } }
      finally {
        try {
          if (created) { await control.query(`DROP SCHEMA "${schema}" CASCADE`); assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true); }
          if (controlConnected) assert.equal(Number((await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rows[0].count), 0);
        } finally {
          try { await control.end(); } finally {
            await rm(dataRoot, { recursive: true, force: true });
            await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
            for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
          }
        }
      }
    }
    console.log('Legacy planner owner cleanup: own schema removed, zero owned clients, DATA removed.');
  }
}
main().catch(error => {
  console.error('Owned legacy planner owner failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => line.includes('/app/lib/') || line.includes('/scripts/')) : undefined });
  process.exitCode = 1;
});
