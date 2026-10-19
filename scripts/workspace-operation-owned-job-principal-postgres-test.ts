import assert from 'node:assert/strict';
import { createFixtureWorkspaceOperationLegacyLinkPlan } from './helpers/workspace-operation-legacy-plan-fixture';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { runPgliteFixture as runSqlFixture } from './helpers/pglite-pool-harness';

// Actual PG18, license verifier, stored jobs and unchanged lifecycle guard.
// The marker table proves this foundation's transaction boundary, not a file,
// native archive, Public share, original HTTP request or Tool invocation.
const sourcePath = path.resolve('scripts/workspace-operation-owned-job-principal-postgres-test.ts');
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
const sourceHash = async () => crypto.createHash('sha256').update(await readFile(sourcePath)).digest('hex');
type Row = Record<string, unknown>;
const denied = (error: unknown): boolean => {
  if (!(error instanceof Error) || error instanceof assert.AssertionError) return false;
  const code = Reflect.get(error, 'code');
  if (typeof code === 'string' && (/^(?:BATCH_|PRINCIPAL_|SEAT_|OWNED_|WORKSPACE_OPERATION_JOB_|WORKSPACE_JOB_|JOB_|COLLABORATION_)/u.test(code)
    || code === 'AGENT_ACTOR_CONTEXT_DENIED')) return true;
  // Preserve the actual existing stored-PI/Workspace ACL error contract. Never
  // turn an arbitrary SQL, transport, TypeError or assertion failure into denial.
  return error.constructor === Error && (code === undefined || code === 'WORKSPACE_PERMISSION_DENIED') && [
    'The originating agent session is unavailable in this workspace.', 'Workspace not found or inaccessible.',
    'Agent access is no longer available in this workspace.', 'Workspace permission denied',
  ].includes(error.message);
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned fixture barrier did not settle.')), 10000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function main(): Promise<void> {
  const pinned = await sourceHash();
  console.log('Owned job fixture frozen source:', pinned);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const nonce = crypto.randomUUID(), schema = `owned_job_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^owned_job_[a-f0-9]{32}$/u);
  const organizationId = `job-org-${crypto.randomUUID()}`, workspaceId = `job-ws-${crypto.randomUUID()}`;
  const agentId = `job-agent-${crypto.randomUUID()}`, piSessionId = `job-pi-${crypto.randomUUID()}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-owned-job-principal-'))), dataIdentity = await stat(dataRoot);
  assert.equal(dataIdentity.uid, process.getuid!()); assert.equal(dataIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>();
  const checkouts = new Set<SqlConnection>();
  const failures: unknown[] = [];
  let connected = false, created = false, schemaOid = 0, schemaRemoved = false, dataRemoved = false;
  let pool: { end: () => Promise<void> } | undefined, fetches = 0, passed = 0, stage = 'prepare owned schema';
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=owned-job-principal-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  try {
    await control.connect(); connected = true;
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${nonce}'`);
    schemaOid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid);
    // These values are installed before dynamic DB/Auth imports, never applied to
    // an app process. The actual production verifier trusts our ephemeral key.
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, CANVAS_DATABASE_PROVIDER: 'postgres',
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost',
      BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
      CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'NEXT_PHASE', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'owned-job-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true, organizationId,
      capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true }, seatLimit: 2, quotas: { users: 2 },
      entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('Network is forbidden in this owned fixture.'); };
    const admin = await ownClient();
    const own = async () => {
      const row = (await admin.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path,
        n.oid,obj_description(n.oid,'pg_namespace') AS nonce,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner
        FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0];
      assert(row); assert.equal(row.schema, schema); assert.equal(Number(row.oid), schemaOid); assert.equal(row.nonce, nonce); assert.equal(row.owner, true);
      assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']);
    };
    stage = 'original full global migrations';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const database = await import('../app/lib/db');
    const runtime = database.getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at) VALUES
      ('owner','Owner','owner@owned-job.test',1,'admin',0,100,100),('member','Member','member@owned-job.test',1,'user',0,100,100),
      ('inactive','Inactive','inactive@owned-job.test',1,'user',0,100,100)`);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES($1,'owner','team',1,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_delete_team_files,can_create_public_links,created_at,updated_at)
      VALUES($1,'owner','owner','active',1,1,0,100,100),($1,'member','member','active',1,1,0,100,100),($1,'inactive','member','disabled',0,0,0,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES
      ('owner-seat',$1,'owner@owned-job.test','owner','owner','active',100,100,100,100),
      ('member-seat',$1,'member@owned-job.test','member','member','active',100,200,100,100),
      ('inactive-seat',$1,'inactive@owned-job.test','inactive','member','suspended',100,50,100,100)`, [organizationId]);
    await admin.query('INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES($1,100,100)', [organizationId]);
    const rootRelativePath = `organizations/${organizationId}/shared`;
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,$2,'organization','Owned job',$3,'active',100,100)`, [workspaceId, organizationId, rootRelativePath]);
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'Stored job agent','special','restricted','organization',$2,'["write_text_file"]',100,100)`, [agentId, organizationId]);
    await admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES($1,$2,'member','active',1,100,100)`, [agentId, organizationId]);
    await admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
      VALUES('job-grant',$1,$2,'workspace',$3,1,100,100)`, [agentId, organizationId, workspaceId]);
    const seedPi = () => admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,'member',$2,'fixture','fixture',$3,$4,'organization','Owned job',$5,100,100)`, [piSessionId, agentId, organizationId, workspaceId, rootRelativePath]);
    await seedPi();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,100,100)',
      ['fixture-browser-session', sessionToken, Date.now() + 3600000]);
    await admin.query('CREATE TABLE fixture_job_effects(marker text PRIMARY KEY,user_id text NOT NULL)');
    const { auth } = await import('../app/lib/auth');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { withWorkspaceOperationJobLifecycleOwner: withOwner,
      withWorkspaceOperationJobLifecycleTransaction: transaction } = await import('../app/lib/files/workspace-operation-job-lifecycle-owner');
    const { withWorkspaceFileLifecycleGuard } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { getWorkspaceFileLifecycleLeases } = await import('../app/lib/collaboration/file-lifecycle-admission-context');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    type Owner = Parameters<Parameters<typeof withOwner>[1]>[0];
    type Access = Parameters<Parameters<typeof transaction>[1]>[0];
    const store = new WorkspaceOperationBatchStore();
    const currentWorkspace = async (userId = 'member'): Promise<WorkspaceContext> => {
      const raw = (await admin.query('SELECT id,email,role FROM "user" WHERE id=$1', [userId])).rows[0]; assert(raw);
      const connection = await database.openDb();
      try {
        const workspace = await readPostgresWorkspaceForActorOnConnection(connection, resolveWorkspaceActor(raw), workspaceId);
        assert(workspace); return workspace;
      } finally { await connection.close(); }
    };
    const workspace = await currentWorkspace();
    await mkdir(workspace.rootPath, { recursive: true });
    const filePath = ' original.md', fullPath = path.join(workspace.rootPath, filePath), originalBytes = Buffer.from('# Untouched original\n');
    await writeFile(fullPath, originalBytes, { flag: 'wx', mode: 0o600 });
    const fileIdentity = await stat(fullPath);
    const freshJob = async (actorType: 'user' | 'agent' = 'user', userId = 'member', leaseMs = 90000) => {
      const scope = await currentWorkspace(userId), actionId = crypto.randomUUID();
      // Declared job data only. This is not a planner/graph or original-request
      // authority proof, and the owner callback only writes an owned SQL marker.
      const plan: WorkspaceOperationBatchPlan = { version: 1, workspaceId, planId: 'a'.repeat(64), readiness: 'ready',
        actions: [{ reviewId: actionId, kind: 'delete', selections: [{ sourcePath: filePath }] }],
        pathSteps: [{ reviewId: actionId, kind: 'delete', sourcePath: filePath }], pathMappings: [], deletedPaths: [],
        linkEdits: [], originalDocuments: [], previewContents: [], expectedPathState: [],
        coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
        linkAssessment: { version: 1, complete: true, blockers: [], warnings: [] }, issues: [],
        linkPlan: createFixtureWorkspaceOperationLegacyLinkPlan(workspaceId, [{ reviewId: actionId, kind: 'delete', selections: [{ sourcePath: filePath }] }]) };
      const record = await store.createDirect({ batchId: crypto.randomUUID(), plan, authorization: { mode: 'direct',
        actorUserId: userId, actorId: actorType === 'agent' ? agentId : userId, actorType, actorDisplayName: 'Stored job actor',
        ...(actorType === 'agent' ? { actorSessionId: piSessionId } : {}), requestHash: 'b'.repeat(64),
        jobScope: captureWorkspaceOperationJobScope(scope) } });
      const claimed = await store.claim(crypto.randomUUID(), leaseMs); assert(claimed); assert.equal(claimed.batchId, record.batchId);
      return { claimed, scope };
    };
    const openTracked = () => {
      const state = { opens: 0, closes: 0, pid: 0, commits: 0, raw: undefined as SqlConnection | undefined };
      return { state, open: async () => {
        state.opens++; const raw = await database.openDb(); state.raw = raw; checkouts.add(raw);
        state.pid = Number((await raw.get('SELECT pg_backend_pid() AS pid') as Row).pid);
        return { get: raw.get.bind(raw), all: raw.all.bind(raw), run: async (sql: string, values?: unknown[]) => {
          if (/^COMMIT\s*$/iu.test(sql)) state.commits++; return raw.run(sql, values);
        }, close: async (error?: Error) => { state.closes++; assert.equal(state.closes, 1); assert(error);
          checkouts.delete(raw); await raw.close(error); } } satisfies SqlConnection;
      } };
    };
    const count = async (marker: string) => Number((await admin.query('SELECT count(*) AS count FROM fixture_job_effects WHERE marker=$1', [marker])).rows[0].count);
    const effect = async (access: Access, marker: string) => {
      await access.database.run('INSERT INTO fixture_job_effects(marker,user_id) VALUES($1,$2)', [marker, access.userId]);
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await admin.query('DELETE FROM workspace_file_operation_batches'); await operation(); passed++;
      assert.equal(checkouts.size, 0); console.log('Owned job fixture group passed:', JSON.stringify({ passed, name }));
    };
    await check('actual production license verifier and actual Cookie/Bearer setup controls', async () => {
      for (const cookie of [false, true]) {
        const headers = new Headers({ 'x-canvas-workspace-id': workspaceId });
        if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', sessionToken, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
        else headers.set('authorization', `Bearer ${sessionToken}`);
        const request = new NextRequest('http://localhost/api/files/delete', { headers });
        assert.equal((await auth.api.getSession({ headers: request.headers }))?.session.id, 'fixture-browser-session');
      }
      assert.equal(fetches, 0);
    });
    for (const userId of ['owner', 'member']) await check(`genuine ${userId} job retains exact Guard backend and serial transaction identities`, async () => {
      const job = await freshJob('user', userId), tracked = openTracked(), observed: string[] = [];
      await store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
        assert(Object.isFrozen(owner));
        for (let index = 0; index < 2; index++) await transaction(owner, async access => {
          assert(Object.isFrozen(access)); assert.equal(access.userId, userId); assert.equal(access.actorId, userId); assert.equal(access.actorType, 'user');
          assert.equal(access.batchId, job.claimed.batchId); assert.equal(access.planId, job.claimed.planId);
          assert.equal(access.workspace.workspaceId, workspaceId); assert.equal(access.workspace.permissions.canDelete, true);
          assert.equal(access.workspace.permissions.canCreatePublicLinks, false);
          const row = await access.database.get(`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,
            current_schema() AS schema,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only`) as Row;
          assert.equal(Number(row.pid), tracked.state.pid); assert.equal(row.schema, schema); assert.equal(row.isolation, 'read committed'); assert.equal(row.read_only, 'off');
          assert.equal(typeof row.xid, 'string'); observed.push(String(row.xid));
          const peer = await ownClient();
          try { assert.equal((await peer.query('SELECT pg_try_advisory_lock_shared($1::bigint) AS locked', [collaborationAdmissionLockKey(workspaceId)])).rows[0].locked, false); }
          finally { await endClient(peer); }
          await effect(access, `${userId}-${index}`); await access.assertCurrent();
        });
      }, tracked.open));
      assert.equal(tracked.state.opens, 1); assert.equal(tracked.state.closes, 1); assert.equal(observed.length, 2); assert.notEqual(observed[0], observed[1]);
      assert.equal(await count(`${userId}-0`), 1); assert.equal(await count(`${userId}-1`), 1);
      assert.equal((await control.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS alive', [tracked.state.pid])).rows[0].alive, false);
    });
    await check('ordinary durable User job does not fabricate or require a BetterAuth session', async () => {
      const job = await freshJob(); await admin.query('DELETE FROM "session"');
      assert.equal(await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${sessionToken}` }) }), null);
      await store.withClaim(job.claimed, claim => withOwner(claim, owner => transaction(owner, async access => { await effect(access, 'no-session'); })));
      assert.equal(await count('no-session'), 1);
    });
    await check('actual stored PI and Agent grant authorize the bound Agent job', async () => {
      const job = await freshJob('agent');
      await store.withClaim(job.claimed, claim => withOwner(claim, owner => transaction(owner, async access => {
        assert.equal(access.actorType, 'agent'); assert.equal(access.actorId, agentId); assert.equal(access.userId, 'member');
        assert.equal(access.piSessionId, piSessionId); await effect(access, 'stored-agent');
      })));
      assert.equal(await count('stored-agent'), 1);
    });
    await check('direct Agent membership remains valid when its independent grant is revoked', async () => {
      const job = await freshJob('agent'); let callbacks = 0;
      try {
        await admin.query('UPDATE agent_grants SET can_use=0 WHERE id=\'job-grant\'');
        await store.withClaim(job.claimed, claim => withOwner(claim, owner => transaction(owner, async access => {
          callbacks++; assert.equal(access.actorType, 'agent'); assert.equal(access.actorId, agentId);
          await effect(access, 'direct-agent-membership');
        })));
      } finally { await admin.query('UPDATE agent_grants SET can_use=1 WHERE id=\'job-grant\''); }
      assert.equal(callbacks, 1); assert.equal(await count('direct-agent-membership'), 1);
    });
    await check('genuine inherited Lifecycle lease cannot become a new owned job entry', async () => {
      const job = await freshJob(); let opened = 0, callbacks = 0;
      await assert.rejects(store.withClaim(job.claimed, claim => withWorkspaceFileLifecycleGuard({ workspaceId, paths: [filePath] },
        () => withOwner(claim, async () => { callbacks++; }, async () => { opened++; return database.openDb(); }))), denied);
      assert.equal(opened, 0); assert.equal(callbacks, 0);
    });
    await check('forged owner and caught misuse poison the actual active owner', async () => {
      const job = await freshJob(); let callbacks = 0;
      await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
        await assert.rejects(transaction(Object.freeze({}) as Owner, async () => { callbacks++; }), denied);
        await assert.rejects(transaction(owner, async () => { callbacks++; }), denied);
      })), denied);
      assert.equal(callbacks, 0);
    });
    await check('retained owner, access and SQL facade cannot escape their callback', async () => {
      const job = await freshJob(); let retainedOwner!: Owner, retainedAccess!: Access;
      await store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
        retainedOwner = owner; await transaction(owner, async access => { retainedAccess = access; await access.assertCurrent(); });
      }));
      await assert.rejects(transaction(retainedOwner, async () => assert.fail('retired owner entered')), denied);
      await assert.rejects(async () => retainedAccess.assertCurrent(), denied);
      await assert.rejects(Promise.resolve().then(() => retainedAccess.database.get('SELECT 1')), denied);
    });
    await check('caught callback failure rolls marker back and remains fatal', async () => {
      const job = await freshJob(), original = new Error('Expected owned fixture operation failure.');
      await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
        await transaction(owner, async access => { await effect(access, 'caught-error'); throw original; }).catch(() => undefined);
      })), error => error === original || denied(error));
      assert.equal(await count('caught-error'), 0);
    });
    await check('throwing with an actual facade query in flight drains B before rollback and disposal', async () => {
      const job = await freshJob(), entered = deferred(), thrown = deferred(), release = deferred();
      const original = new Error('Expected callback failure with an actual B query in flight.');
      const events: string[] = []; let raw: SqlConnection | undefined, pending: Promise<unknown> | undefined;
      let insertExecuted = false, responseReleased = false, outerSettled = false, rollbacks = 0, closes = 0;
      const open = async (): Promise<SqlConnection> => {
        raw = await database.openDb(); const actual = raw; checkouts.add(actual);
        return { get: actual.get.bind(actual), all: actual.all.bind(actual), run: async (sql, values) => {
          if (/^ROLLBACK\s*$/iu.test(sql) && insertExecuted) {
            rollbacks++; events.push('rollback'); assert.equal(responseReleased, true, 'Rollback raced the actual in-flight B query.');
          }
          const result = await actual.run(sql, values);
          if (/^INSERT INTO fixture_job_effects\b/u.test(sql) && values?.[0] === 'query-throw') {
            insertExecuted = true; events.push('insert-executed'); entered.resolve();
            await within(release.promise); responseReleased = true; events.push('response-released');
          }
          return result;
        }, close: async error => {
          closes++; events.push('dispose'); assert.equal(closes, 1); assert(error);
          if (insertExecuted) assert.equal(responseReleased, true, 'B was disposed before its query response settled.');
          await actual.close(error); checkouts.delete(actual);
        } };
      };
      const outer = store.withClaim(job.claimed, claim => withOwner(claim, owner => transaction(owner, async access => {
        pending = Promise.resolve(access.database.run('INSERT INTO fixture_job_effects(marker,user_id) VALUES($1,$2)', ['query-throw', access.userId]));
        void pending.catch(() => undefined);
        // The real INSERT has executed on B; throw immediately without awaiting
        // its deliberately held response, rather than inventing a SQL result.
        await within(entered.promise); events.push('callback-throw'); thrown.resolve(); throw original;
      }), open));
      void outer.then(() => { outerSettled = true; }, () => { outerSettled = true; });
      try {
        await within(thrown.promise); await new Promise<void>(done => setImmediate(done));
        assert.equal(insertExecuted, true); assert.equal(responseReleased, false);
        assert.equal(rollbacks, 0); assert.equal(closes, 0); assert.equal(outerSettled, false);
        assert.equal(await count('query-throw'), 0, 'The marker must still be uncommitted on B.');
      } finally { release.resolve(); await within(Promise.allSettled([outer, ...(pending ? [pending] : [])])); }
      await assert.rejects(outer, error => error === original);
      assert.equal(rollbacks, 1); assert.equal(closes, 1); assert.equal(await count('query-throw'), 0);
      assert(events.indexOf('callback-throw') < events.indexOf('response-released'));
      assert(events.indexOf('response-released') < events.indexOf('rollback'));
      assert(events.indexOf('rollback') < events.indexOf('dispose'));
    });
    await check('lost external COMMIT reply disposes actual B and retires its lease before caught callback returns', async () => {
      const job = await freshJob(); let pid = 0, closes = 0, armed = false, injected = false, commits = 0, inserts = 0;
      let callbacks = 0, replayCallbacks = 0, checkedBeforeReturn = false, backendStart = '';
      const transport = Object.assign(new Error('Expected lost actual external COMMIT reply.'), { code: 'ECONNRESET' });
      const unconfirmed = (error: unknown) => {
        const matched = error instanceof Error && Reflect.get(error, 'code') === 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED'
          && Reflect.get(error, 'status') === 503 && Reflect.get(error, 'cause') === transport;
        if (!matched) {
          const own = (value: unknown, key: string): unknown => {
            if (!value || typeof value !== 'object') return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
          };
          const label = (value: unknown): string | null => typeof value === 'string'
            && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value) ? value : null;
          const name = (value: unknown): string | null => {
            let current = value;
            for (let depth = 0; current && typeof current === 'object' && depth < 3; depth++) {
              const actual = label(own(current, 'name')); if (actual) return actual;
              current = Object.getPrototypeOf(current);
            }
            return null;
          };
          const status = (value: unknown): number | string | null => typeof value === 'number' && Number.isSafeInteger(value)
            ? value : typeof value === 'string' && /^\d{1,5}$/u.test(value) ? value : null;
          let remaining = 3;
          const tree = (value: unknown): Record<string, unknown> | null => {
            if (remaining-- <= 0) return null;
            const result: Record<string, unknown> = { isError: value instanceof Error,
              name: name(value), code: label(own(value, 'code')), status: status(own(value, 'status')) };
            if (value instanceof AggregateError) {
              const errors = own(value, 'errors'), length = own(errors, 'length'), children: unknown[] = [];
              if (Array.isArray(errors) && typeof length === 'number') for (let index = 0; index < Math.min(length, 3) && remaining > 0; index++) {
                children.push(tree(own(errors, String(index))));
              }
              result.errors = children;
            }
            return result;
          };
          const cause = own(error, 'cause');
          console.error(JSON.stringify({ diagnostic: 'owned-job-unconfirmed-validator-mismatch',
            isError: error instanceof Error, name: name(error), code: label(own(error, 'code')), status: status(own(error, 'status')),
            causeCode: label(own(cause, 'code')), causeName: name(cause),
            identityCause: error instanceof Error && Reflect.get(error, 'cause') === transport, aggregateTree: tree(error) }));
        }
        return matched;
      };
      const open = async (): Promise<SqlConnection> => {
        const actual = await database.openDb(); checkouts.add(actual);
        const backend = await actual.get(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS backend_start
          FROM pg_stat_activity WHERE pid=pg_backend_pid()`) as Row;
        pid = Number(backend.pid); assert(Number.isSafeInteger(pid) && pid > 0);
        assert(typeof backend.backend_start === 'string' && backend.backend_start);
        backendStart = backend.backend_start;
        return { get: actual.get.bind(actual), all: actual.all.bind(actual), run: async (sql, values) => {
          const result = await actual.run(sql, values);
          if (/^INSERT INTO fixture_job_effects\b/u.test(sql) && values?.[0] === 'lost-commit') { inserts++; armed = true; }
          if (/^COMMIT\s*$/iu.test(sql) && armed && !injected) {
            // The guard preflight and initial no-op policy COMMIT have already
            // succeeded. This is the real external marker transaction COMMIT.
            commits++; injected = true; throw transport;
          }
          return result;
        }, close: async error => {
          closes++; assert.equal(closes, 1); assert(error); await actual.close(error); checkouts.delete(actual);
        } };
      };
      const waitForOriginalBackendAbsent = async (): Promise<void> => {
        assert(pid > 0 && backendStart); const deadline = performance.now() + 1000;
        for (;;) {
          const remaining = Math.floor(deadline - performance.now());
          assert(remaining > 0, 'Original discarded backend was not observed absent within one second.');
          // SELECT observation only. Query read timeout bounds this observer;
          // it is not a server cancellation or a retry of COMMIT/file effects.
          const query = { text: 'SELECT pid,extract(epoch FROM backend_start)::text AS backend_start FROM pg_stat_activity WHERE pid=$1',
            values: [pid], query_timeout: remaining };
          const observed = (await control.query<{ pid: number; backend_start: string }>(query)).rows;
          assert(performance.now() <= deadline, 'Original backend observation exceeded its one-second budget.');
          assert(observed.length <= 1);
          if (observed.length === 0) return;
          assert.equal(Number(observed[0].pid), pid, 'Administrative backend observation returned a different PID.');
          assert.equal(observed[0].backend_start, backendStart, 'Original PID was reused by a different backend; absence is unconfirmed.');
          await new Promise<void>(resolve => setTimeout(resolve, 5));
        }
      };
      await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
        const lease = getWorkspaceFileLifecycleLeases()?.get(workspaceId); assert(lease); assert.equal(lease.active, true);
        try {
          await transaction(owner, async access => { callbacks++; await effect(access, 'lost-commit'); });
          assert.fail('A lost COMMIT reply was reported as success.');
        } catch (error) {
          assert(unconfirmed(error)); assert.equal(injected, true); assert.equal(closes, 1);
          assert.equal(lease.active, false); assert.equal(await lease.verify(), false);
          await waitForOriginalBackendAbsent();
          assert.equal(await count('lost-commit'), 1, 'The actual first COMMIT was durable.');
          await assert.rejects(transaction(owner, async () => { replayCallbacks++; }), unconfirmed);
          checkedBeforeReturn = true;
        }
      }, open)), unconfirmed);
      assert.equal(checkedBeforeReturn, true); assert.equal(callbacks, 1); assert.equal(replayCallbacks, 0);
      assert.equal(commits, 1); assert.equal(inserts, 1); assert.equal(closes, 1); assert.equal(await count('lost-commit'), 1);
    });
    await check('detached live transaction is drained and cannot commit', async () => {
      const job = await freshJob(), entered = deferred(), returned = deferred(), release = deferred();
      let pending: Promise<unknown> | undefined, settled = false;
      const outer = store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
        pending = transaction(owner, async access => { await effect(access, 'detached'); entered.resolve(); await release.promise; settled = true; });
        void pending.catch(() => undefined); await entered.promise; returned.resolve();
      }));
      void outer.catch(() => undefined);
      try { await within(returned.promise); await new Promise<void>(done => setImmediate(done)); }
      finally { release.resolve(); await within(Promise.allSettled([outer, ...(pending ? [pending] : [])])); }
      await assert.rejects(outer, denied);
      assert.equal(settled, true); assert.equal(await count('detached'), 0);
    });
    await check('changing XID on the actual Guard connection cannot authorize a final result', async () => {
      const job = await freshJob(), tracked = openTracked();
      await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, owner => transaction(owner, async access => {
        await effect(access, 'xid-drift'); assert(tracked.state.raw); await tracked.state.raw.run('ROLLBACK'); await tracked.state.raw.run('BEGIN');
        await access.assertCurrent();
      }), tracked.open)), denied);
      assert.equal(await count('xid-drift'), 0); assert.equal(tracked.state.closes, 1);
    });
    await check('root inode replacement between phases is rejected without rebinding', async () => {
      const job = await freshJob(), retiredRoot = `${workspace.rootPath}.retired-${crypto.randomUUID()}`, before = await stat(workspace.rootPath);
      let swapped = false, callbacks = 0;
      try {
        await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
          await transaction(owner, async access => { await access.assertCurrent(); });
          await rename(workspace.rootPath, retiredRoot); swapped = true; await mkdir(workspace.rootPath, { mode: 0o700 });
          await transaction(owner, async () => { callbacks++; });
        })), denied);
      } finally {
        if (swapped) { const retired = await stat(retiredRoot); assert.equal(retired.dev, before.dev); assert.equal(retired.ino, before.ino);
          await rm(workspace.rootPath, { recursive: true }); await rename(retiredRoot, workspace.rootPath); }
      }
      assert.equal(callbacks, 0);
    });
    await check('actual elapsed Claim lease cannot enter a fresh owned phase', async () => {
      const job = await freshJob('user', 'member', 500); let callbacks = 0, waited = false;
      await assert.rejects(store.withClaim(job.claimed, async claim => {
        waited = true; await new Promise(done => setTimeout(done, 530));
        await withOwner(claim, async () => { callbacks++; });
      }), denied);
      assert.equal(waited, true); assert.equal(callbacks, 0);
    });
    await check('changed persisted Claim incarnation rejects the next phase', async () => {
      const job = await freshJob(); let callbacks = 0;
      await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
        await transaction(owner, async access => { await access.assertCurrent(); });
        await admin.query('UPDATE workspace_file_operation_batches SET lease_token=$2 WHERE batch_id=$1', [job.claimed.batchId, crypto.randomUUID()]);
        await transaction(owner, async () => { callbacks++; });
      })), denied);
      assert.equal(callbacks, 0);
    });
    const currentRevocations = [
      ['banned account', 'UPDATE "user" SET banned=1 WHERE id=\'member\'', 'UPDATE "user" SET banned=0 WHERE id=\'member\''],
      ['suspended seat', 'UPDATE team_memberships SET status=\'suspended\' WHERE id=\'member-seat\'', 'UPDATE team_memberships SET status=\'active\' WHERE id=\'member-seat\''],
      ['new earlier eligible seat', 'UPDATE team_memberships SET status=\'active\' WHERE id=\'inactive-seat\'; UPDATE organization_user_permissions SET status=\'active\' WHERE user_id=\'inactive\'',
        'UPDATE team_memberships SET status=\'suspended\' WHERE id=\'inactive-seat\'; UPDATE organization_user_permissions SET status=\'disabled\' WHERE user_id=\'inactive\''],
      ['revoked workspace write', 'UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id=\'member\'', 'UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id=\'member\''],
      ['revoked delete right while write remains', 'UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE user_id=\'member\'', 'UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE user_id=\'member\''],
      ['inactive organization membership', 'UPDATE organization_user_permissions SET status=\'disabled\' WHERE user_id=\'member\'', 'UPDATE organization_user_permissions SET status=\'active\' WHERE user_id=\'member\''],
      ['archived current workspace', `UPDATE canvas_workspaces SET status='archived' WHERE id='${workspaceId}'`, `UPDATE canvas_workspaces SET status='active' WHERE id='${workspaceId}'`],
    ] as const;
    for (const [label, revoke, restore] of currentRevocations) await check(`${label} after Claim rejects current authority`, async () => {
      const job = await freshJob(); let callbacks = 0;
      try { await admin.query(revoke); await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, owner => transaction(owner, async () => { callbacks++; }))), denied); }
      finally { await admin.query(restore); }
      assert.equal(callbacks, 0);
    });
    await check('same-B account revocation after marker is caught by final authorization', async () => {
      const job = await freshJob(), tracked = openTracked();
      await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, owner => transaction(owner, async access => {
        await effect(access, 'final-revocation'); assert(tracked.state.raw);
        // Corrupt the actual same-B policy row after the final facade query;
        // only the owner's automatic final check can observe this change.
        await tracked.state.raw.run('UPDATE "user" SET banned=1 WHERE id=\'member\'');
      }), tracked.open)), denied);
      assert.equal(await count('final-revocation'), 0);
      assert.equal(Number((await admin.query('SELECT banned FROM "user" WHERE id=\'member\'')).rows[0].banned), 0);
    });
    await check('later operation cleanup failure preserves the poisoned SQL failure and uncertain disposal status', async () => {
      const job = await freshJob(), tracked = openTracked();
      const primary = Object.assign(new Error('Owned fixture primary SQL phase failure.'), { code: 'FIXTURE_PRIMARY_FAILURE' });
      const cleanup = new Error('Owned fixture later resource cleanup acknowledgement lost.');
      await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, async owner => {
        await assert.rejects(transaction(owner, async access => { await effect(access, 'cleanup-failure'); throw primary; }), error => error === primary);
        throw Object.assign(new AggregateError([primary, cleanup], 'Owned fixture resource disposal remains uncertain.'),
          { code: 'FIXTURE_DISPOSAL_UNCONFIRMED', status: 503 });
      }, tracked.open)), error => {
        assert(error instanceof AggregateError); assert.equal(Reflect.get(error, 'code'), 'FIXTURE_DISPOSAL_UNCONFIRMED');
        assert.equal(Reflect.get(error, 'status'), 503);
        const observed = new Set<unknown>();
        const visit = (value: unknown): void => {
          if (!(value instanceof Error) || observed.has(value)) return; observed.add(value);
          if (value instanceof AggregateError) for (const child of value.errors) visit(child);
          visit(value.cause);
        };
        visit(error); assert(observed.has(primary)); assert(observed.has(cleanup)); return true;
      });
      assert.equal(await count('cleanup-failure'), 0); assert.equal(tracked.state.closes, 1);
    });
    for (const mode of ['archive', 'delete', 'agent reassignment', 'grant revoke'] as const) await check(`stored Agent ${mode} after Claim rejects current authority`, async () => {
      const job = await freshJob('agent'); let callbacks = 0;
      try {
        if (mode === 'archive') await admin.query('UPDATE pi_sessions SET archived_at=100 WHERE session_id=$1', [piSessionId]);
        if (mode === 'delete') await admin.query('DELETE FROM pi_sessions WHERE session_id=$1', [piSessionId]);
        if (mode === 'agent reassignment') await admin.query('UPDATE pi_sessions SET agent_id=$2 WHERE session_id=$1', [piSessionId, `${agentId}-different`]);
        if (mode === 'grant revoke') {
          await admin.query('UPDATE agent_grants SET can_use=0 WHERE id=\'job-grant\'');
          await admin.query('UPDATE agent_members SET can_use=0 WHERE agent_id=$1 AND user_id=\'member\'', [agentId]);
        }
        await assert.rejects(store.withClaim(job.claimed, claim => withOwner(claim, owner => transaction(owner, async () => { callbacks++; }))), denied);
      } finally {
        if (mode === 'delete') await seedPi();
        else await admin.query('UPDATE pi_sessions SET archived_at=NULL,agent_id=$2 WHERE session_id=$1', [piSessionId, agentId]);
        await admin.query('UPDATE agent_grants SET can_use=1 WHERE id=\'job-grant\'');
        if (mode === 'grant revoke') await admin.query('UPDATE agent_members SET can_use=1 WHERE agent_id=$1 AND user_id=\'member\'', [agentId]);
      }
      assert.equal(callbacks, 0);
    });
    assert.deepEqual(await readFile(fullPath), originalBytes);
    const afterFile = await stat(fullPath); for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(afterFile[field], fileIdentity[field]);
    assert.equal(passed, 30); assert.equal(fetches, 0); await own(); assert.equal(await sourceHash(), pinned);
    console.log('Owned job SQL assertions finished:', JSON.stringify({ passed, fetches, sourceSha256: pinned }));
  } catch (error) { failures.push(error); }
  finally {
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { failures.push(error); } };
    for (const connection of checkouts) await cleanup(async () => { checkouts.delete(connection); await connection.close(new Error('Discarding leaked owned fixture checkout.')); });
    if (pool) await cleanup(() => pool!.end());
    for (const client of clients) await cleanup(() => endClient(client));
    if (created && clients.size === 0) await cleanup(async () => {
      const row = (await control.query(`SELECT oid,obj_description(oid,'pg_namespace') AS nonce,
        nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
      assert(row); assert.equal(Number(row.oid), schemaOid); assert.equal(row.nonce, nonce); assert.equal(row.owner, true);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      schemaRemoved = (await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed === true; assert(schemaRemoved);
    });
    if (connected) await cleanup(() => control.end());
    await cleanup(async () => { const current = await stat(dataRoot); assert.equal(current.dev, dataIdentity.dev); assert.equal(current.ino, dataIdentity.ino);
      assert.equal(current.uid, dataIdentity.uid); await rm(dataRoot, { recursive: true });
      await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT'); dataRemoved = true; });
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    await cleanup(async () => { assert.equal(await sourceHash(), pinned); });
    console.log('Owned job fixture cleanup:', JSON.stringify({ schemaRemoved, dataRemoved, openClients: clients.size, openCheckouts: checkouts.size, passed }));
  }
  if (failures.length) {
    const error = failures[0], code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const locations = error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const match = /\/(app\/.*|scripts\/.*):(\d+):(\d+)\)?$/u.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 4) : undefined;
    throw new Error(`Owned job fixture failed: ${stage}; name=${error instanceof Error ? error.name : 'unknown'}; code=${typeof code === 'string' && /^[A-Z0-9_]{1,128}$/u.test(code) ? code : 'unclassified'}; source=${locations?.join(',') || 'unavailable'}; failures=${failures.length}`);
  }
  assert(schemaRemoved); assert(dataRemoved);
}

void runSqlFixture({ label: 'workspace-operation-owned-job-principal-postgres-test', operation: main,
  successMessage: 'Owned job genuine PG18 assertions and complete resource cleanup passed; no file/Public mutation claimed.' });
