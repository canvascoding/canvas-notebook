import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { WorkspaceAgentToolHistoricalOrigin, WorkspaceAgentToolHistoricalOriginObserver } from '../app/lib/workspaces/request-principal';

// Focused real PG18 PI-origin fixture. This exercises genuine invocation +
// principal factories, not server tool execution or native document admission.
// Full migrations are unchanged; all fixture rows live in one owned schema.
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', passed = 0, complete = false;
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && Reflect.get(error, 'code') === expected;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `agent_origin_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^agent_origin_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-agent-origin-'));
  const control = new Client({ connectionString, options: '-c statement_timeout=15000', connectionTimeoutMillis: 5000 });
  const clients = new Set<Client>();
  let created = false, pool: { end: () => Promise<void> } | undefined, fetches = 0;
  let primaryFailure: unknown;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=agent-origin-fixture` });
    client.on('error', () => undefined); // PG18 transaction_timeout can end our own client.
    clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const connection = (client: Client): SqlConnection => ({
    get: async (sql, values) => (await client.query(sql, values)).rows[0],
    all: async (sql, values) => (await client.query(sql, values)).rows,
    run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
    close: () => { throw new Error('Principal must not close its caller-owned connection.'); },
  });
  const transaction = async <T>(operation: (database: SqlConnection, client: Client) => Promise<T>, begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') => {
    const client = await ownClient();
    try { await client.query(begin); return await operation(connection(client), client); }
    finally { try { await client.query('ROLLBACK'); } finally { await endClient(client); } }
  };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); passed++; console.log('Agent principal case passed:', JSON.stringify({ passed, name }));
  };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: 'principal-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS', 'NEXT_PHASE']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'principal-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('Network use is forbidden in this owned fixture.'); };
    stage = 'actual full migrations';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    const own = async () => {
      const row = (await admin.query("SELECT current_schema() AS schema,current_setting('search_path') AS path")).rows[0];
      assert.equal(row.schema, schema); assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']);
    };
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    stage = 'real Agent, PI, seat and grant fixtures';
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@principal.test',1,'admin',0,100,100),('member','Member','member@principal.test',1,'user',0,100,100),
      ('inactive','Inactive','inactive@principal.test',1,'user',0,100,100)`);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('principal-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES('principal-org','owner','owner','active',1,100,100),('principal-org','member','member','active',1,100,100),
      ('principal-org','inactive','member','disabled',0,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','principal-org','owner@principal.test','owner','owner','active',100,100,100,100),
      ('member-seat','principal-org','member@principal.test','member','member','active',100,200,100,100),
      ('inactive-seat','principal-org','inactive@principal.test','inactive','member','suspended',100,50,100,100)`);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('principal-org',100,100)");
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('org-space','principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`);
    const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'System','main','legacy','organization','principal-org','["write_text_file"]',100,100),
      ('special-agent','Special','special','restricted','organization','principal-org','["write_text_file"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [MAIN_AGENT_ID]);
    await admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES('special-agent','principal-org','owner','active',1,100,100),('special-agent','principal-org','member','inactive',0,100,100)`);
    const seedGrant = () => admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
      VALUES('special-grant','special-agent','principal-org','workspace','org-space',1,100,100)
      ON CONFLICT(id) DO UPDATE SET can_use=1`);
    await seedGrant();
    const seedPi = (sessionId: string, userId: string, agentId: string) => admin.query(`INSERT INTO pi_sessions
      (session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,$2,$3,'fixture','fixture','principal-org','org-space','organization','Organization','organizations/principal-org/shared',100,100)`, [sessionId, userId, agentId]);
    await seedPi('pi-main', 'owner', MAIN_AGENT_ID); await seedPi('pi-special', 'member', 'special-agent'); await seedPi('pi-unrelated', 'owner', MAIN_AGENT_ID);
    await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
      VALUES('browser-unrelated','fixture-token','owner',$1,100,100)`, [Date.now() + 3600000]);
    await admin.query('CREATE TABLE fixture_writes(id text PRIMARY KEY,value text NOT NULL)');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
    const { withWorkspaceAgentToolPrincipal: capture, withWorkspaceAgentToolPrincipalOriginalOrigin: captureOrigin, withWorkspaceAgentToolPrincipalOnConnection: phase } = await import('../app/lib/workspaces/request-principal');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    type Principal = Parameters<typeof phase>[1];
    type Access = Parameters<Parameters<typeof phase>[2]>[0];
    const context = async (special = false): Promise<AgentExecutionContext> => {
      const userId = special ? 'member' : 'owner';
      const workspace = await readPostgresWorkspaceForActorOnConnection(connection(admin), resolveWorkspaceActor({ id: userId, role: special ? 'user' : 'admin', email: `${userId}@principal.test` }), 'org-space');
      assert(workspace); assert.equal(workspace.legacy, false); assert.equal(workspace.permissions.canRunAgent, true);
      return { userId, sessionId: special ? 'pi-special' : 'pi-main', agentId: special ? 'special-agent' : MAIN_AGENT_ID,
        agentTurnId: 'fixture-turn', workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
        workspaceName: workspace.displayName ?? null, organizationId: workspace.organizationId ?? null, customerId: workspace.customerId ?? null,
        projectId: workspace.projectId ?? null, workspaceRoot: workspace.rootPath, workspaceRootRelativePath: workspace.rootRelativePath ?? null,
        canWrite: false, canDelete: false, canShare: false, legacy: false };
    };
    const invoke = async <T>(operation: () => Promise<T>, special = false, signal?: AbortSignal) => {
      const origin = await context(special);
      return runWithAgentExecutionContext(origin, () => withAgentToolInvocation(origin, { toolName: 'write_text_file', toolCallId: 'fixture-call', signal }, operation));
    };
    const captured = <T>(operation: (principal: Principal) => Promise<T>, special = false, signal?: AbortSignal) => invoke(() => capture({ permission: 'canWrite', workspaceId: 'org-space' }, operation), special, signal);

    const originals = <T>(observe: WorkspaceAgentToolHistoricalOriginObserver, operation: (principal: Principal) => Promise<T>,
      special = false, signal?: AbortSignal) => invoke(() => captureOrigin({ permission: 'canRead', workspaceId: 'org-space' }, observe, operation), special, signal);
    const sink = (rows: WorkspaceAgentToolHistoricalOrigin[]): WorkspaceAgentToolHistoricalOriginObserver => origin => { rows.push(origin); };
    const actualIdentity = async () => {
      const realm = (await admin.query(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid::bigint AS schema_oid,
        current_setting('search_path') AS search_path,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid`)).rows[0];
      const pi = (await admin.query("SELECT id FROM pi_sessions WHERE session_id='pi-main'")).rows[0];
      const profile = (await admin.query('SELECT id,revision,workflow_version,workflow_revision FROM agents WHERE agent_id=$1', [MAIN_AGENT_ID])).rows[0];
      const source = await context();
      return { userId: source.userId, agentId: MAIN_AGENT_ID, piSessionId: source.sessionId, toolName: 'write_text_file', toolCallId: 'fixture-call',
        agentTurnId: source.agentTurnId ?? null, piSessionDbId: Number(pi.id), agentProfileId: Number(profile.id), agentProfileRevision: Number(profile.revision),
        workflowVersion: profile.workflow_version === null ? null : Number(profile.workflow_version), workflowRevision: Number(profile.workflow_revision),
        workspaceId: source.workspaceId, workspaceType: source.workspaceType, organizationId: source.organizationId, customerId: source.customerId,
        projectId: source.projectId, ownerUserId: null, rootPath: source.workspaceRoot, rootRelativePath: source.workspaceRootRelativePath,
        legacy: false, status: 'active', schema: realm.schema, schemaOid: Number(realm.schema_oid), searchPath: realm.search_path, databaseOid: Number(realm.database_oid) };
    };
    await admin.query(`INSERT INTO canvas_customers(id,organization_id,name,slug,created_at,updated_at)
      VALUES('origin-customer','principal-org','Origin Customer','origin-customer',100,100)`);
    await admin.query(`INSERT INTO canvas_projects(id,organization_id,name,slug,created_at,updated_at)
      VALUES('origin-project','principal-org','Origin Project','origin-project',100,100)`);

    await check('actual PI origin, full realm, immutable scalars and repeated initial/current/final observations', async () => {
      const expected = await actualIdentity(), seen: WorkspaceAgentToolHistoricalOrigin[] = [];
      await originals(sink(seen), principal => transaction(async (database, client) => {
        const before = (await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
        await phase(database, principal, async access => {
          assert.equal(seen.length, 1); assert.equal(access.piSessionId, 'pi-main'); assert.equal(access.userId, 'owner');
          await access.assertCurrent(); assert.equal(seen.length, 2);
          await database.run("INSERT INTO fixture_writes VALUES('origin-commit','actual B')");
        });
        assert.equal(seen.length, 3);
        const after = (await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
        assert.deepEqual(after, before); await client.query('COMMIT');
      }));
      assert.equal((await admin.query("SELECT value FROM fixture_writes WHERE id='origin-commit'")).rows[0].value, 'actual B');
      for (const original of seen) {
        assert.deepEqual(original, expected); assert(Object.isFrozen(original));
        assert(Object.values(original).every(value => value === null || ['string','number','boolean'].includes(typeof value)));
        for (const forbidden of ['sessionId','token','enabledToolsJson','permissions','database','assertCurrent']) assert(!Object.hasOwn(original, forbidden));
      }
    });
    await check('special Agent uses genuine member seat, grant, stored PI and profile', async () => {
      const seen: WorkspaceAgentToolHistoricalOrigin[] = [];
      await originals(sink(seen), principal => transaction(database => phase(database, principal, async access => {
        assert.equal(access.userId, 'member'); assert.equal(access.agentId, 'special-agent'); await access.assertCurrent();
      })), true);
      assert.equal(seen.length, 3); assert.equal(seen[0].piSessionId, 'pi-special');
      assert.equal(seen[0].agentProfileId, Number((await admin.query("SELECT id FROM agents WHERE agent_id='special-agent'")).rows[0].id));
    });
    await check('actual null Agent origin normalizes only through the existing default Agent resolver', async () => {
      const source = await context(); source.agentId = null;
      const seen: WorkspaceAgentToolHistoricalOrigin[] = [];
      await runWithAgentExecutionContext(source, () => withAgentToolInvocation(source,
        { toolName: 'write_text_file', toolCallId: 'null-default' }, () => captureOrigin({ permission: 'canRead' }, sink(seen),
          principal => transaction(database => phase(database, principal, async () => undefined)))));
      assert.equal(seen.length, 2); assert.equal(seen[0].agentId, MAIN_AGENT_ID); assert.equal(seen[0].toolCallId, 'null-default');
    });
    await check('ordinary existing factory stays opt-out and does not query the additional history header', async () => {
      let historyQueries = 0;
      await captured(principal => transaction(async (database, client) => {
        const wrapped: SqlConnection = { ...database, get: async (sql, values) => {
          if (sql.includes('w.customer_id') && sql.includes('AS database_oid')) historyQueries++;
          return (await client.query(sql, values)).rows[0];
        } };
        await phase(wrapped, principal, async access => { await access.assertCurrent(); });
      }));
      assert.equal(historyQueries, 0);
    });
    await check('OnConnection uses genuine caller B without checkout, close or transaction control', async () => {
      await originals(() => undefined, principal => transaction(async (database, client) => {
        const checkedOut = runtime as unknown as { connect: (...args: unknown[]) => unknown; query: (...args: unknown[]) => unknown };
        const connect = checkedOut.connect, query = checkedOut.query;
        let poolCalls = 0, transactionControls = 0;
        checkedOut.connect = () => { poolCalls++; assert.fail('OnConnection cannot checkout.'); };
        checkedOut.query = () => { poolCalls++; assert.fail('OnConnection cannot query the pool.'); };
        const wrapped: SqlConnection = { ...database, run: async (sql, values) => {
          if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql)) transactionControls++;
          return { changes: (await client.query(sql, values)).rowCount ?? 0 };
        } };
        try { await phase(wrapped, principal, async access => { await access.assertCurrent(); }); }
        finally { checkedOut.connect = connect; checkedOut.query = query; }
        assert.equal(poolCalls, 0); assert.equal(transactionControls, 0);
      }));
    });
    await check('plain ALS and historical identity cannot mint a principal', async () => {
      const source = await context();
      await assert.rejects(async () => runWithAgentExecutionContext(source, () => captureOrigin({ permission: 'canRead' }, () => undefined, async () => assert.fail())), code('AGENT_TOOL_INVOCATION_REQUIRED'));
      await originals(() => undefined, principal => transaction(async database => {
        for (const fake of [{}, { ...principal }, await actualIdentity()])
          await assert.rejects(phase(database, fake as Principal, async () => assert.fail()), code('PRINCIPAL_REQUIRED'));
      }));
    });
    await check('retired principal and retained assertion do not outlive their actual invocation phase', async () => {
      let retained!: Principal, retainedAccess!: Access;
      await originals(() => undefined, principal => transaction(database => phase(database, principal, async access => { retained = principal; retainedAccess = access; })));
      await transaction(database => assert.rejects(phase(database, retained, async () => assert.fail()), code('PRINCIPAL_REQUIRED')));
      await assert.rejects(retainedAccess.assertCurrent(), code('PRINCIPAL_REQUIRED'));
    });
    await check('Promise observer return rejects before the callback', async () => {
      let calls = 0;
      await assert.rejects(originals(async () => undefined, principal => transaction(database => phase(database, principal, async () => { calls++; }))), code('PRINCIPAL_DETACHED'));
      assert.equal(calls, 0);
    });
    await check('nonundefined observer return rejects before the callback', async () => {
      let calls = 0;
      await assert.rejects(originals(() => 1, principal => transaction(database => phase(database, principal, async () => { calls++; }))), code('PRINCIPAL_DETACHED'));
      assert.equal(calls, 0);
    });
    await check('observer exception stays the exact primary and poisons a caught outer phase', async () => {
      const marker = new Error('Owned synchronous sink failure');
      await assert.rejects(originals(() => { throw marker; }, async principal => {
        await transaction(database => assert.rejects(phase(database, principal, async () => assert.fail()), error => error === marker));
      }), error => error === marker);
    });
    await check('final observer failure rolls back actual caller writes', async () => {
      const marker = new Error('Owned final observation failure'); let observations = 0, calls = 0;
      await assert.rejects(originals(() => { if (++observations === 2) throw marker; }, principal => transaction(database => phase(database, principal, async () => {
        calls++; await database.run("INSERT INTO fixture_writes VALUES('observer-rollback','must roll back')");
      }))), error => error === marker);
      assert.equal(calls, 1); assert.equal(observations, 2);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM fixture_writes WHERE id='observer-rollback'")).rows[0].count, 0);
    });
    await check('observer cannot mutate frozen historical scalars', async () => {
      let observations = 0;
      await originals(original => {
        observations++; assert(Object.isFrozen(original)); assert.equal(Reflect.set(original, 'userId', 'member'), false);
        assert.equal(original.userId, 'owner');
      }, principal => transaction(database => phase(database, principal, async access => { await access.assertCurrent(); })));
      assert.equal(observations, 3);
    });
    await check('invalid observer is rejected without creating a principal', async () => {
      let calls = 0;
      await assert.rejects(invoke(() => captureOrigin({ permission: 'canRead' }, null as unknown as WorkspaceAgentToolHistoricalOriginObserver,
        async () => { calls++; })), code('PRINCIPAL_INVALID'));
      assert.equal(calls, 0);
    });
    await check('factory search_path is pinned before B even with identical resolved relations', async () => {
      let calls = 0;
      await assert.rejects(originals(() => undefined, principal => transaction(async (database, client) => {
        await client.query(`SET LOCAL search_path=${schema},pg_catalog,public`);
        await phase(database, principal, async () => { calls++; });
      })), code('PRINCIPAL_SCOPE_CHANGED'));
      assert.equal(calls, 0);
    });
    await check('actual B final search_path change is rejected and rolled back', async () => {
      let calls = 0;
      await assert.rejects(originals(() => undefined, principal => transaction(database => phase(database, principal, async () => {
        calls++; await database.run("INSERT INTO fixture_writes VALUES('path-rollback','must roll back')");
        await database.run(`SET LOCAL search_path=${schema},pg_catalog,public`);
      }))), code('PRINCIPAL_SCOPE_CHANGED'));
      assert.equal(calls, 1); assert.equal((await admin.query("SELECT count(*)::int AS count FROM fixture_writes WHERE id='path-rollback'")).rows[0].count, 0);
    });
    for (const [name, sql] of [
      ['customer', "UPDATE canvas_workspaces SET customer_id='origin-customer' WHERE id='org-space'"],
      ['project', "UPDATE canvas_workspaces SET project_id='origin-project' WHERE id='org-space'"],
      ['owner', "UPDATE canvas_workspaces SET owner_user_id='member' WHERE id='org-space'"],
      ['root', "UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/changed' WHERE id='org-space'"],
    ] as const) await check(`original SQL ${name} scope after factory is not rebound before B`, async () => {
      let calls = 0;
      try {
        await assert.rejects(originals(() => undefined, async principal => {
          await admin.query(sql); await transaction(database => phase(database, principal, async () => { calls++; }));
        }), code('PRINCIPAL_SCOPE_CHANGED'));
        assert.equal(calls, 0);
      } finally { await admin.query("UPDATE canvas_workspaces SET customer_id=NULL,project_id=NULL,owner_user_id=NULL,root_relative_path='organizations/principal-org/shared' WHERE id='org-space'"); }
    });
    await check('original customer self-drift is read from SQL by the final check and rolled back', async () => {
      let calls = 0;
      await assert.rejects(originals(() => undefined, principal => transaction(database => phase(database, principal, async () => {
        calls++; await database.run("UPDATE canvas_workspaces SET customer_id='origin-customer' WHERE id='org-space'");
      }))), code('PRINCIPAL_SCOPE_CHANGED'));
      assert.equal(calls, 1); assert.equal((await admin.query("SELECT customer_id FROM canvas_workspaces WHERE id='org-space'")).rows[0].customer_id, null);
    });
    for (const [name, sql, restore, expectedCode] of [
      ['PI archive', "UPDATE pi_sessions SET archived_at=100 WHERE session_id='pi-main'", "UPDATE pi_sessions SET archived_at=NULL WHERE session_id='pi-main'", 'PRINCIPAL_AUTH_REVOKED'],
      ['profile revision', 'UPDATE agents SET revision=revision+1 WHERE agent_id=$1', 'UPDATE agents SET revision=1 WHERE agent_id=$1', 'PRINCIPAL_SCOPE_CHANGED'],
    ] as const) await check(`opt-in retains actual ${name} revocation`, async () => {
      let calls = 0;
      try {
        await assert.rejects(originals(() => undefined, async principal => {
          await admin.query(sql, name === 'profile revision' ? [MAIN_AGENT_ID] : undefined);
          await transaction(database => phase(database, principal, async () => { calls++; }));
        }), code(expectedCode));
        assert.equal(calls, 0);
      } finally { await admin.query(restore, name === 'profile revision' ? [MAIN_AGENT_ID] : undefined); }
    });
    await check('genuine invocation abort is still checked after the owner callback', async () => {
      const abort = new AbortController(); let calls = 0;
      await assert.rejects(originals(() => undefined, principal => transaction(database => phase(database, principal, async () => { calls++; abort.abort(); })), false, abort.signal), code('AGENT_TOOL_INVOCATION_ABORTED'));
      assert.equal(calls, 1);
    });
    await check('caught reentrant assertion poisons opt-in phase and drains both promises', async () => {
      await assert.rejects(originals(() => undefined, principal => transaction(database => phase(database, principal, async access => {
        await Promise.allSettled([access.assertCurrent(), access.assertCurrent()]);
      }))), code('PRINCIPAL_REENTRANT'));
    });
    await check('unawaited assertion is drained and rejects original lifetime', async () => {
      await assert.rejects(originals(() => undefined, principal => transaction(database => phase(database, principal, async access => {
        void access.assertCurrent().catch(() => undefined);
      }))), code('PRINCIPAL_DETACHED'));
    });
    await check('existing RC/RW and explicit transaction requirements remain', async () => {
      for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE', 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'])
        await assert.rejects(originals(() => undefined, principal => transaction(database => phase(database, principal, async () => assert.fail()), begin)), code('PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(originals(() => undefined, async principal => {
        const client = await ownClient();
        try { await phase(connection(client), principal, async () => assert.fail()); } finally { await endClient(client); }
      }), code('PRINCIPAL_SCOPE_CHANGED'));
    });
    assert.equal(fetches, 0); assert.equal(passed, 26); await own();
    console.log('Agent original-origin SQL assertions complete:', JSON.stringify({ passed, fetches }));
  } catch (error) { primaryFailure = error; }
  finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    if (pool) await cleanup(() => pool!.end());
    for (const client of clients) await cleanup(() => endClient(client));
    if (created && clients.size === 0 && cleanupErrors.length === 0) await cleanup(async () => {
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true);
    });
    await cleanup(() => control.end());
    await cleanup(() => rm(dataRoot, { recursive: true, force: true }));
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Owned Agent fixture cleanup failed.');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  complete = true;
  console.log('Workspace Agent Tool Principal Original Origin PostgreSQL18 finished:', JSON.stringify({ passed, cleanup: true }));
}
main().catch(error => {
  console.error('Owned Agent original-origin fixture failed:', { stage, passed, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null }); process.exitCode = 1;
});
