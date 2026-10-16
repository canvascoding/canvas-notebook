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

// Actual full-DDL PG18 ownership/negative regressions for bounded source reads.
// Genuine Auth/Create/Starter fixtures; no fake positive lease, SQL result,
// catalogue, state loader or permission grant. Faults execute actual owned SQL.
// This does not prove caller authorization, Delete or browser acceptance.
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
  const schema = `lifecycle_source_owner_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^lifecycle_source_owner_[a-f0-9]{32}$/u);
  const organizationId = `lifecycle-source-org-${crypto.randomUUID()}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch, originalQuery = Client.prototype.query;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-lifecycle-source-owner-')));
  const applicationName = `lifecycle-source-fixture-${crypto.randomUUID()}`;
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
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: `lifecycle-source-license-${crypto.randomUUID()}`,
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
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { withWorkspaceFileLifecycleGuard, readWorkspaceFileLifecycleSourceAuthority } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { getWorkspaceFileLifecycleLeases, withWorkspaceFileLifecycleLeases } = await import('../app/lib/collaboration/file-lifecycle-admission-context');
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
      stage = name; await operation(); cases++; console.log(`Lifecycle source owner PG18 passed: ${name}`);
    };
    const createdFile = async (workspace: WorkspaceContext, filePath: string, cookie: boolean) => {
      const actualHeaders = await headers(workspace.workspaceId, cookie); actualHeaders.set('content-type', 'application/json');
      const response = await createFile(new NextRequest('http://localhost/api/files/create', {
        method: 'POST', headers: actualHeaders, body: JSON.stringify({ type: 'file', path: filePath }),
      }));
      const result: unknown = await response.json().catch(() => null);
      const success = result !== null && typeof result === 'object' ? Reflect.get(result, 'success') : undefined;
      const code = result !== null && typeof result === 'object' ? Reflect.get(result, 'code') : undefined;
      if (response.status !== 200 || success !== true) console.log('Lifecycle source Create public result', {
        status: response.status, success: success === true, code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : null,
      });
      assert.equal(response.status, 200); assert.equal(success, true);
      const original = await readFile(path.join(workspace.rootPath, filePath)); assert.equal(original.byteLength, 0);
      const registered = (await admin.query(`SELECT id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,yjs_state_lifecycle
        FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active'`, [workspace.workspaceId, filePath])).rows;
      assert.equal(registered.length, 1); const document = registered[0];
      assert.equal(document.workspace_type, workspace.workspaceType); assert.equal(document.provider, 'yjs');
      assert.equal(document.state_version, 0); assert.equal(document.yjs_state_lifecycle, 'never_initialized');
      assert.equal(typeof document.id, 'string'); assert.equal(typeof document.lineage_id, 'string');
      for (const table of ['collaboration_yjs_states', 'collaboration_yjs_state_backups', 'collaboration_agent_operations']) {
        assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE document_id=$1`, [document.id])).rows[0].count, 0);
      }
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM file_revisions WHERE lineage_id=$1', [document.lineage_id])).rows[0].count > 0, true);
      return { documentId: document.id as string, lineageId: document.lineage_id as string,
        identity: filesystemFileVersion(await stat(path.join(workspace.rootPath, filePath))) };
    };

    const code = (expected: string, status = 409) => (error: unknown): boolean => {
      assert(error instanceof Error);
      assert.equal(Reflect.get(error, 'code'), expected); assert.equal(Reflect.get(error, 'status'), status); return true;
    };
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
    };
    const within = async <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned fixture phase did not settle.')), 10000);
      })]); } finally { if (timer) clearTimeout(timer); }
    };
    const isCatalogue = (sql: string) => sql.replace(/\s+/gu, ' ').includes(
      'FROM collaboration_documents d LEFT JOIN collaboration_yjs_states s ON s.document_id=d.id');
    type SqlEvent = { sql: string; backend: number };
    let trace: SqlEvent[] | undefined;
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0] !== null && typeof args[0] === 'object' ? Reflect.get(args[0], 'text') : '';
      if (trace && typeof sql === 'string') {
        const backend: unknown = Reflect.get(this, 'processID'); assert.equal(typeof backend, 'number');
        trace.push({ sql, backend: backend as number });
      }
      // Observe only: return the actual original pg query/Promise/result untouched.
      return Reflect.apply(originalQuery, this, args);
    } as typeof Client.prototype.query;
    type Checkout = { original: SqlConnection; backend: number; start: string; closes: number; closed: boolean;
      sql: string[]; closeErrors: Array<Error | undefined> };
    type Hooks = { before?: (sql: string, checkout: Checkout) => Promise<void>;
      after?: (sql: string, checkout: Checkout) => Promise<void> };
    const checkoutFactory = (hooks: Hooks = {}) => {
      const checkouts: Checkout[] = [];
      return { checkouts, open: async (): Promise<SqlConnection> => {
        const original = await openDb();
        let checkout: Checkout | undefined;
        try {
          const identity = await original.get(`SELECT pg_backend_pid() AS backend,extract(epoch FROM backend_start)::text AS start
            FROM pg_stat_activity WHERE pid=pg_backend_pid()`) as { backend: number; start: string };
          assert(Number.isSafeInteger(identity.backend)); assert.match(identity.start, /^[0-9]+\.[0-9]+$/u);
          checkout = { original, ...identity, closes: 0, closed: false, sql: [], closeErrors: [] }; checkouts.push(checkout);
          const actual = checkout;
          const call = async <T>(sql: string, operation: () => T | Promise<T>): Promise<T> => {
            assert.equal(actual.closed, false, 'No SQL may reach a disposed owned checkout.'); actual.sql.push(sql);
            await hooks.before?.(sql, actual);
            const result = await operation();
            await hooks.after?.(sql, actual); return result;
          };
          return {
            get: (sql, values) => call(sql, () => original.get(sql, values)),
            all: (sql, values) => call(sql, () => original.all(sql, values)),
            run: (sql, values) => call(sql, () => original.run(sql, values)),
            close: async error => {
              actual.closes++; assert.equal(actual.closes, 1); actual.closed = true; actual.closeErrors.push(error);
              await original.close(error);
            },
          };
        } catch (error) {
          if (!checkout?.closed) await original.close(error instanceof Error ? error : new Error('Owned fixture checkout failed.'));
          throw error;
        }
      } };
    };
    const assertDisposed = async (checkouts: Checkout[]) => {
      assert(checkouts.length > 0);
      for (const checkout of checkouts) {
        assert.equal(checkout.closes, 1); assert.equal(checkout.closed, true);
        assert(checkout.closeErrors[0] instanceof Error, 'Dedicated admission sessions are always destroyed.');
        let alive = true;
        for (let attempt = 0; attempt < 50 && alive; attempt++) {
          alive = (await control.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1
            AND extract(epoch FROM backend_start)::text=$2 AND application_name=$3) AS alive`,
          [checkout.backend, checkout.start, applicationName])).rows[0].alive;
          if (alive) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(alive, false, 'The exact owned PID/backend-start must disappear after disposal.');
      }
    };
    stage = 'genuine Personal/Team, Cookie/Bearer, native Starter and physical TXT fixtures';
    const workspaces: WorkspaceContext[] = [];
    const filePath = `physical-${crypto.randomUUID()}.txt`;
    for (const [workspaceType, cookie] of [['personal', true], ['team', false]] as const) {
      const workspace = await createPostgresWorkspaceForActor(actor, { type: workspaceType, name: `Lifecycle source ${workspaceType} ${crypto.randomUUID()}` });
      assert.equal(workspace.workspaceType, workspaceType); assert.equal(workspace.permissions.canWrite, true);
      const actualSession = await auth.api.getSession({ headers: await headers(workspace.workspaceId, cookie) });
      assert(actualSession); assert.equal(actualSession.user.id, 'owner'); assert.equal(actualSession.session.id, 'session-owner');
      const initialized = await completeWorkspaceStarterDocumentInitialization(await request(workspace.workspaceId, cookie), workspace.workspaceId, { requireIntent: true });
      assert.equal(initialized.status, 'completed'); await createdFile(workspace, filePath, cookie); workspaces.push(workspace);
    }
    const [workspace, otherWorkspace] = workspaces;
    const initialNative = (await admin.query(`SELECT document_id,representation,schema_version,lifecycle_generation,document_sequence,persisted_at,yjs_state,state_vector
      FROM collaboration_yjs_states WHERE workspace_id=ANY($1::text[]) ORDER BY document_id`, [workspaces.map(value => value.workspaceId)])).rows;
    assert.equal(initialNative.length, 2);
    const assertObservation = (observation: Awaited<ReturnType<typeof readWorkspaceFileLifecycleSourceAuthority>>, selected: WorkspaceContext) => {
      assert(observation); assert.equal(observation.stage.coverage.complete, true, JSON.stringify(observation.stage.coverage.gaps));
      const native = observation.nativeBindings.filter(value => value.expected.path === 'Erste Schritte.md'); assert.equal(native.length, 1);
      assert.equal(native[0].registry.stateLifecycle, 'initialized');
      const physical = observation.stage.namespace.filter(value => value.path === filePath); assert.equal(physical.length, 1);
      assert.equal(physical[0].workspaceId, selected.workspaceId); assert.equal(physical[0].documentId, null);
      assert.equal(physical[0].identity, physical[0].filesystemIdentity);
    };
    await check('absence of both private owner and public lease returns undefined before SQL', async () => {
      const events: SqlEvent[] = []; trace = events;
      try { assert.equal(await readWorkspaceFileLifecycleSourceAuthority(workspace), undefined); assert.deepEqual(events, []); }
      finally { trace = undefined; }
    });
    await check('fabricated public lease cannot authorize a collector or a checkout', async () => {
      let verifications = 0; const events: SqlEvent[] = []; trace = events;
      try {
        await assert.rejects(withWorkspaceFileLifecycleLeases(new Map([[workspace.workspaceId, { active: true, verify: async () => {
          verifications++; return true;
        } }]]), () => readWorkspaceFileLifecycleSourceAuthority(workspace)), code('FILE_LIFECYCLE_SOURCE_INVALID'));
        assert.equal(verifications, 0); assert.deepEqual(events, []);
      } finally { trace = undefined; }
    });
    await check('stale genuine public lease rejects before SQL after its owning guard has ended', async () => {
      const fixture = checkoutFactory(); let stale: ReturnType<typeof getWorkspaceFileLifecycleLeases>;
      await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        stale = new Map(getWorkspaceFileLifecycleLeases()); assert(stale.get(workspace.workspaceId)?.active);
      }, fixture.open);
      await assertDisposed(fixture.checkouts); assert(stale); assert.equal(stale.get(workspace.workspaceId)?.active, false);
      const events: SqlEvent[] = []; trace = events;
      try {
        await assert.rejects(withWorkspaceFileLifecycleLeases(stale, () => readWorkspaceFileLifecycleSourceAuthority(workspace)), code('FILE_LIFECYCLE_SOURCE_INVALID'));
        assert.deepEqual(events, []);
      } finally { trace = undefined; }
    });
    await check('source identity pins at first read after a genuine pre-read search-path change', async () => {
      const fixture = checkoutFactory();
      await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        await fixture.checkouts[0].original.run(`SET search_path="${schema}",public,pg_catalog`);
        assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
        assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
      }, fixture.open);
      await assertDisposed(fixture.checkouts);
    });
    await check('uncloneable caller scope rejects before SQL and cannot be swallowed into owner success', async () => {
      const fixture = checkoutFactory();
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        // Explicit invalid input only. The genuine workspace/rights object is not changed.
        const uncloneable = Object.assign({}, workspace, { brandContext: () => undefined }) as unknown as WorkspaceContext;
        const events: SqlEvent[] = []; trace = events;
        try {
          await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(uncloneable), code('FILE_LIFECYCLE_SOURCE_INVALID'));
          assert.deepEqual(events, []);
        } finally { trace = undefined; }
      }, fixture.open), code('FILE_LIFECYCLE_SOURCE_INVALID'));
      await assertDisposed(fixture.checkouts);
    });
    await check('nested same-workspace short checkout closes before source reader reuses actual outer B', async () => {
      const fixture = checkoutFactory(), events: SqlEvent[] = [];
      try {
        await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
          assert.equal(fixture.checkouts.length, 1); const outer = fixture.checkouts[0];
          await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
            assert.equal(fixture.checkouts.length, 2); assert.equal(fixture.checkouts[1].closed, true); assert.equal(outer.closed, false);
            trace = events;
            try { assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace); }
            finally { trace = undefined; }
          }, fixture.open);
          assert.equal(outer.closed, false); assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
        }, fixture.open);
        assert(events.some(event => isCatalogue(event.sql))); assert(events.some(event => event.sql.includes('pg_advisory_xact_lock_shared')));
        assert(events.every(event => event.backend === fixture.checkouts[0].backend)); assert.equal(fixture.checkouts.length, 2);
      } finally { trace = undefined; }
      await assertDisposed(fixture.checkouts);
    });
    await check('multiworkspace private owner map retains A while nested B is active', async () => {
      const fixture = checkoutFactory(), events: SqlEvent[] = [];
      try {
        await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
          await withWorkspaceFileLifecycleGuard({ workspaceId: otherWorkspace.workspaceId, paths: [filePath] }, async () => {
            assert.equal(fixture.checkouts.length, 2); const [ownerA, ownerB] = fixture.checkouts;
            trace = events;
            try {
              assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
              assertObservation(await readWorkspaceFileLifecycleSourceAuthority(otherWorkspace), otherWorkspace);
              assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
            } finally { trace = undefined; }
            const nativeCalls = events.filter(event => isCatalogue(event.sql)); assert(nativeCalls.length >= 6);
            assert(nativeCalls.some(event => event.backend === ownerA.backend)); assert(nativeCalls.some(event => event.backend === ownerB.backend));
            assert(events.every(event => [ownerA.backend, ownerB.backend].includes(event.backend)));
          }, fixture.open);
          assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
        }, fixture.open);
        assert.equal(fixture.checkouts.length, 2);
      } finally { trace = undefined; }
      await assertDisposed(fixture.checkouts);
    });
    for (const mismatch of ['hidden-public', 'replaced-public', 'foreign-workspace'] as const) await check(`${mismatch} rejects before source SQL`, async () => {
      const fixture = checkoutFactory(); let rejected: unknown;
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        const actualLeases = getWorkspaceFileLifecycleLeases(); assert(actualLeases); const actual = actualLeases.get(workspace.workspaceId); assert(actual);
        const replacement = new Map(actualLeases);
        if (mismatch === 'hidden-public') replacement.delete(workspace.workspaceId);
        if (mismatch === 'replaced-public') replacement.set(workspace.workspaceId, { active: true, verify: async () => true });
        if (mismatch === 'foreign-workspace') replacement.set(otherWorkspace.workspaceId, actual);
        const events: SqlEvent[] = []; trace = events;
        try {
          await assert.rejects(withWorkspaceFileLifecycleLeases(replacement,
            () => readWorkspaceFileLifecycleSourceAuthority(mismatch === 'foreign-workspace' ? otherWorkspace : workspace)), error => {
              rejected = error; return code('FILE_LIFECYCLE_SOURCE_INVALID')(error);
            });
          assert.deepEqual(events, []);
        } finally { trace = undefined; }
        // Explicitly propagate the rejection; no successful ownership claim is
        // inferred from a manually altered public ALS map.
        throw rejected;
      }, fixture.open), code('FILE_LIFECYCLE_SOURCE_INVALID'));
      await assertDisposed(fixture.checkouts);
    });
    for (const field of ['rootPath', 'workspaceType', 'organizationId'] as const) await check(`pinned workspace ${field} drift rejects before the collector`, async () => {
      const fixture = checkoutFactory();
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
        const changed: WorkspaceContext = { ...workspace };
        if (field === 'rootPath') changed.rootPath = otherWorkspace.rootPath;
        if (field === 'workspaceType') changed.workspaceType = 'organization';
        if (field === 'organizationId') changed.organizationId = `wrong-${crypto.randomUUID()}`;
        const events: SqlEvent[] = []; trace = events;
        try {
          await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(changed), code('FILE_LIFECYCLE_SOURCE_INVALID'));
          assert.equal(events.some(event => isCatalogue(event.sql) || event.sql.includes('pg_advisory_xact_lock_shared')), false);
        } finally { trace = undefined; }
      }, fixture.open), code('FILE_LIFECYCLE_SOURCE_INVALID'));
      await assertDisposed(fixture.checkouts);
    });
    for (const drift of ['schema', 'search-path'] as const) await check(`actual ${drift} drift after lazy first pin rejects and poisons owner`, async () => {
      const fixture = checkoutFactory();
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
        await fixture.checkouts[0].original.run(drift === 'schema' ? 'SET search_path=pg_catalog' : `SET search_path="${schema}",public,pg_catalog`);
        const before = fixture.checkouts[0].sql.filter(isCatalogue).length;
        await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), code('FILE_LIFECYCLE_SOURCE_INVALID'));
        assert.equal(fixture.checkouts[0].sql.filter(isCatalogue).length, before);
      }, fixture.open), code('FILE_LIFECYCLE_SOURCE_INVALID'));
      await assertDisposed(fixture.checkouts);
    });
    for (const begin of ['BEGIN', 'BEGIN READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ']) await check(`actual ${begin} before lazy first source read is rejected`, async () => {
      const fixture = checkoutFactory();
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        await fixture.checkouts[0].original.run(begin);
        const before = fixture.checkouts[0].sql.filter(isCatalogue).length;
        await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), code('FILE_LIFECYCLE_SOURCE_INVALID'));
        assert.equal(fixture.checkouts[0].sql.filter(isCatalogue).length, before);
      }, fixture.open), code('FILE_LIFECYCLE_SOURCE_INVALID'));
      await assertDisposed(fixture.checkouts);
    });
    await check('actual exclusive owner key loss after one read rejects and poisons owner', async () => {
      const fixture = checkoutFactory();
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
        const unlocked = await fixture.checkouts[0].original.get('SELECT pg_advisory_unlock($1::bigint) AS unlocked',
          [collaborationAdmissionLockKey(workspace.workspaceId)]) as { unlocked: boolean }; assert.equal(unlocked.unlocked, true);
        const before = fixture.checkouts[0].sql.filter(isCatalogue).length;
        await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), code('FILE_LIFECYCLE_SOURCE_INVALID'));
        assert.equal(fixture.checkouts[0].sql.filter(isCatalogue).length, before);
      }, fixture.open), code('FILE_LIFECYCLE_SOURCE_INVALID'));
      await assertDisposed(fixture.checkouts);
    });
    await check('parallel read rejects synchronously registered reentry and poisons the owner even when caught', async () => {
      const entered = deferred(), release = deferred(); let armed = false, paused = false;
      const fixture = checkoutFactory({ after: async sql => {
        if (armed && !paused && sql.includes('pg_advisory_xact_lock_shared')) { paused = true; entered.resolve(); await release.promise; }
      } });
      let first: ReturnType<typeof readWorkspaceFileLifecycleSourceAuthority> | undefined;
      try {
        await assert.rejects(within(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
          armed = true; first = readWorkspaceFileLifecycleSourceAuthority(workspace); void first.catch(() => undefined);
          await within(entered.promise);
          try { await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), code('FILE_LIFECYCLE_SOURCE_INVALID')); }
          finally { release.resolve(); }
          await assert.rejects(first, code('FILE_LIFECYCLE_SOURCE_INVALID'));
        }, fixture.open)), code('FILE_LIFECYCLE_SOURCE_INVALID'));
      } finally { release.resolve(); if (first) await first.catch(() => undefined); }
      assert.equal(paused, true); await assertDisposed(fixture.checkouts);
    });
    await check('actual SQL divide-by-zero cannot be swallowed to let outer owner report success', async () => {
      let armed = false, failed = false, caught: unknown;
      const fixture = checkoutFactory({ before: async (sql, checkout) => {
        if (armed && !failed && isCatalogue(sql)) { failed = true; await checkout.original.run('SELECT 1/0'); }
      } });
      let outerError: unknown;
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        armed = true;
        await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), error => { caught = error; return error instanceof Error; });
      }, fixture.open), error => { outerError = error; return error instanceof Error; });
      assert.equal(failed, true); assert(caught instanceof Error); assert.equal(outerError, caught);
      await assertDisposed(fixture.checkouts);
    });
    await check('caught actual source SQL fault cannot mask a subsequent callback cleanup 503', async () => {
      let armed = false, failed = false, caught: unknown;
      const cleanup = Object.assign(new Error('Owned fixture callback cleanup acknowledgement was lost.'), {
        code: 'FIXTURE_CALLBACK_CLEANUP_UNCONFIRMED', status: 503,
      });
      const fixture = checkoutFactory({ before: async (sql, checkout) => {
        if (armed && !failed && isCatalogue(sql)) { failed = true; await checkout.original.run('SELECT 1/0'); }
      } });
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        armed = true;
        await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), error => { caught = error; return error instanceof Error; });
        throw cleanup;
      }, fixture.open), error => {
        assert(error instanceof AggregateError); code(cleanup.code, 503)(error);
        assert(error.errors.includes(caught)); assert(error.errors.includes(cleanup)); return true;
      });
      assert.equal(failed, true); assert(caught instanceof Error); await assertDisposed(fixture.checkouts);
    });
    await check('detached in-flight read settles before dedicated B disposal and still rejects the outer guard', async () => {
      const entered = deferred(), release = deferred(), callbackReturned = deferred(); let armed = false, paused = false, outerSettled = false;
      let pending: ReturnType<typeof readWorkspaceFileLifecycleSourceAuthority> | undefined;
      const fixture = checkoutFactory({ after: async sql => {
        if (armed && !paused && sql.includes('pg_advisory_xact_lock_shared')) { paused = true; entered.resolve(); await release.promise; }
      } });
      const outer = withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        armed = true; pending = readWorkspaceFileLifecycleSourceAuthority(workspace); void pending.catch(() => undefined);
        await within(entered.promise); callbackReturned.resolve();
      }, fixture.open);
      void outer.then(() => { outerSettled = true; }, () => { outerSettled = true; });
      try {
        await within(callbackReturned.promise); await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(outerSettled, false); assert.equal(fixture.checkouts[0].closed, false);
        release.resolve(); await assert.rejects(within(outer), code('FILE_LIFECYCLE_SOURCE_DETACHED'));
        assert(pending); await assert.rejects(pending, code('FILE_LIFECYCLE_SOURCE_DETACHED'));
      } finally { release.resolve(); await outer.catch(() => undefined); if (pending) await pending.catch(() => undefined); }
      await assertDisposed(fixture.checkouts);
    });
    await check('timer retained after owning guard cannot run SQL on closed B or open a replacement', async () => {
      const release = deferred(); let retained: Promise<void> | undefined;
      const fixture = checkoutFactory();
      await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
        retained = new Promise<void>((resolve, reject) => { setTimeout(() => {
          void release.promise.then(async () => {
            const events: SqlEvent[] = []; trace = events;
            try {
              await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), code('FILE_LIFECYCLE_SOURCE_DETACHED'));
              assert.deepEqual(events, []); resolve();
            } catch (error) { reject(error); } finally { trace = undefined; }
          }, reject);
        }, 0); });
        void retained.catch(() => undefined);
      }, fixture.open);
      await assertDisposed(fixture.checkouts); assert(retained); release.resolve(); await within(retained);
      assert.equal(fixture.checkouts.length, 1);
    });
    await check('retained old context may reacquire a fresh genuine guard and source owner B', async () => {
      const release = deferred(); let retained: Promise<void> | undefined;
      const fixture = checkoutFactory();
      await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
        retained = new Promise<void>((resolve, reject) => { setTimeout(() => {
          void release.promise.then(async () => {
            const events: SqlEvent[] = []; trace = events;
            try {
              await withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
                assert.equal(fixture.checkouts.length, 2); assert.equal(fixture.checkouts[0].closed, true);
                assert.equal(fixture.checkouts[1].closed, false);
                assertObservation(await readWorkspaceFileLifecycleSourceAuthority(workspace), workspace);
              }, fixture.open);
              assert(events.some(event => isCatalogue(event.sql)));
              assert(events.every(event => event.backend === fixture.checkouts[1].backend)); resolve();
            } catch (error) { reject(error); } finally { trace = undefined; }
          }, reject);
        }, 0); });
        void retained.catch(() => undefined);
      }, fixture.open);
      assert.equal(fixture.checkouts.length, 1); assert.equal(fixture.checkouts[0].closed, true);
      assert(retained); release.resolve(); await within(retained); assert.equal(fixture.checkouts.length, 2);
      await assertDisposed(fixture.checkouts);
    });
    for (const loss of ['commit', 'rollback'] as const) await check(`actual source ${loss.toUpperCase()} acknowledgement loss retains 503 despite callback catch`, async () => {
      let armed = false, sourceBegan = false, injected = false, sqlFault = false, caught: unknown;
      const fixture = checkoutFactory({
        before: async (sql, checkout) => {
          if (armed && loss === 'rollback' && !sqlFault && isCatalogue(sql)) { sqlFault = true; await checkout.original.run('SELECT 1/0'); }
        },
        after: async sql => {
          if (armed && /^BEGIN\b/iu.test(sql)) sourceBegan = true;
          if (armed && sourceBegan && !injected && sql.trim().toUpperCase() === loss.toUpperCase()) {
            injected = true; throw new Error(`Injected lost ${loss.toUpperCase()} response after actual server execution.`);
          }
        },
      });
      let outerError: unknown;
      await assert.rejects(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
        armed = true;
        await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), error => {
          caught = error; return code('FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED', 503)(error);
        });
      }, fixture.open), error => { outerError = error; return code('FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED', 503)(error); });
      assert.equal(sourceBegan, true); assert.equal(injected, true); assert.equal(sqlFault, loss === 'rollback'); assert.equal(outerError, caught);
      await assertDisposed(fixture.checkouts);
    });
    await check('parallel poison followed by actual ROLLBACK response loss preserves transaction-unconfirmed 503', async () => {
      const entered = deferred(), release = deferred(); let armed = false, paused = false, rollbackLost = false;
      let first: ReturnType<typeof readWorkspaceFileLifecycleSourceAuthority> | undefined;
      const fixture = checkoutFactory({ after: async sql => {
        if (armed && !paused && sql.includes('pg_advisory_xact_lock_shared')) { paused = true; entered.resolve(); await release.promise; }
        if (armed && paused && !rollbackLost && sql.trim().toUpperCase() === 'ROLLBACK') {
          rollbackLost = true; throw new Error('Lost actual ROLLBACK response after concurrent source poison.');
        }
      } });
      try {
        await assert.rejects(within(withWorkspaceFileLifecycleGuard({ workspaceId: workspace.workspaceId, paths: [filePath] }, async () => {
          armed = true; first = readWorkspaceFileLifecycleSourceAuthority(workspace); void first.catch(() => undefined);
          await within(entered.promise);
          try { await assert.rejects(readWorkspaceFileLifecycleSourceAuthority(workspace), code('FILE_LIFECYCLE_SOURCE_INVALID')); }
          finally { release.resolve(); }
          await assert.rejects(first, code('FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED', 503));
        }, fixture.open)), code('FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED', 503));
      } finally { release.resolve(); if (first) await first.catch(() => undefined); }
      assert.equal(paused, true); assert.equal(rollbackLost, true); await assertDisposed(fixture.checkouts);
    });
    assert.deepEqual((await admin.query(`SELECT document_id,representation,schema_version,lifecycle_generation,document_sequence,persisted_at,yjs_state,state_vector
      FROM collaboration_yjs_states WHERE workspace_id=ANY($1::text[]) ORDER BY document_id`, [workspaces.map(value => value.workspaceId)])).rows, initialNative);
    for (const selected of workspaces) assert.equal((await readFile(path.join(selected.rootPath, filePath))).byteLength, 0);
    assert.equal(fetches, 0);
    console.log(`Lifecycle source owner PG18: ${cases} ownership/negative families passed on genuine Personal/Team/Cookie/Bearer/Create/Starter fixtures; no caller authorization, Delete or browser acceptance claimed.`);
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
    console.log('Lifecycle source owner cleanup: own schema removed, zero owned clients, DATA removed.');
  }
}
main().catch(error => {
  console.error('Owned lifecycle source owner failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => line.includes('/app/lib/') || line.includes('/scripts/')) : undefined });
  process.exitCode = 1;
});
