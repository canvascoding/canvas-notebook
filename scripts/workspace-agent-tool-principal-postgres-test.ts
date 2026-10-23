import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

// Standalone PG18 fixture. Only the DATABASE_URL is read from the managed
// configuration; all DDL/DML and the runtime pool are confined to a new schema.
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', passed = 0, complete = false;
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && Reflect.get(error, 'code') === expected;
const failure = (error: unknown) => {
  if (!(error instanceof Error) || error instanceof assert.AssertionError || error instanceof TypeError || error instanceof SyntaxError) return false;
  const domainCode = Reflect.get(error, 'code');
  if (['WorkspaceRequestPrincipalError', 'AgentToolInvocationError', 'AgentActorContextError', 'SeatLimitGuardError'].includes(error.name)
    && typeof domainCode === 'string' && /^(?:PRINCIPAL_|AGENT_TOOL_INVOCATION_|SEAT_)|^AGENT_ACTOR_CONTEXT_DENIED$/u.test(domainCode)) return true;
  // Existing readStoredAgentWorkspaceOnConnection / assertPermissions errors;
  // never accept arbitrary PG errors, transport errors or runtime exceptions.
  return error.constructor === Error && (domainCode === undefined || domainCode === 'WORKSPACE_PERMISSION_DENIED') && [
    'The originating agent session is unavailable in this workspace.', 'Workspace not found or inaccessible.',
    'Agent access is no longer available in this workspace.', 'Workspace permission denied',
  ].includes(error.message);
};
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
  const schema = `agent_principal_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^agent_principal_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-agent-principal-'));
  const control = new Client({ connectionString, options: '-c statement_timeout=15000', connectionTimeoutMillis: 5000 });
  const clients = new Set<Client>();
  let created = false, pool: { end: () => Promise<void> } | undefined, fetches = 0;
  let primaryFailure: unknown;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=agent-principal-fixture` });
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
    const { getPostgresRuntimeQueryable, openDb } = await import('../app/lib/db');
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
    const { withWorkspaceAgentToolPrincipal: capture, withWorkspaceAgentToolPrincipalOnConnection: phase } = await import('../app/lib/workspaces/request-principal');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
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
    const denied = async (operation: () => Promise<unknown>, expectedCode?: string) => { await assert.rejects(operation(), expectedCode ? code(expectedCode) : failure); };
    const restorePi = async () => { await admin.query("DELETE FROM pi_sessions WHERE session_id='pi-main'"); await seedPi('pi-main', 'owner', MAIN_AGENT_ID); };

    for (const special of [false, true]) await check(special ? 'special grant genuine committed write' : 'system default genuine committed write', async () => {
      await captured(principal => transaction(async database => {
        await phase(database, principal, async access => {
          assert.equal(access.userId, special ? 'member' : 'owner'); assert.equal(access.agentId, special ? 'special-agent' : MAIN_AGENT_ID);
          assert.equal(access.piSessionId, special ? 'pi-special' : 'pi-main'); assert.equal(access.toolName, 'write_text_file'); assert.equal(access.toolCallId, 'fixture-call');
          assert.equal(access.workspace.workspaceId, 'org-space'); assert.equal(access.workspace.permissions.canWrite, true);
          assert(Object.isFrozen(access.workspace)); await access.assertCurrent();
          await database.run('INSERT INTO fixture_writes VALUES($1,$2)', [special ? 'special' : 'main', 'actual committed write']);
        });
        await database.run('COMMIT');
      }), special);
      assert.equal((await admin.query('SELECT value FROM fixture_writes WHERE id=$1', [special ? 'special' : 'main'])).rows[0]?.value, 'actual committed write');
    });
    await check('null runtime agent identity resolves actual default PI and commits', async () => {
      const origin = await context(); origin.agentId = null;
      await runWithAgentExecutionContext(origin, () => withAgentToolInvocation(origin,
        { toolName: 'write_text_file', toolCallId: 'default-null' }, () => capture({ permission: 'canWrite' }, principal => transaction(async database => {
          await phase(database, principal, async access => {
            assert.equal(access.agentId, MAIN_AGENT_ID); assert.equal(access.piSessionId, 'pi-main');
            await access.assertCurrent(); await database.run("INSERT INTO fixture_writes VALUES('default-null','committed')");
          });
          await database.run('COMMIT');
        }))));
      assert.equal((await admin.query("SELECT value FROM fixture_writes WHERE id='default-null'")).rows[0]?.value, 'committed');
    });
    await check('legacy invocation cannot mint the new Agent principal', async () => {
      const origin = await context(); origin.legacy = true; let calls = 0;
      await assert.rejects(runWithAgentExecutionContext(origin, () => withAgentToolInvocation(origin,
        { toolName: 'write_text_file', toolCallId: 'legacy' }, () => capture({ permission: 'canWrite' }, async () => { calls++; }))), code('PRINCIPAL_ACCESS_DENIED'));
      assert.equal(calls, 0);
    });
    await check('ordinary ALS and cloned origin cannot create invocation authority', async () => {
      const origin = await context();
      await assert.rejects(async () => runWithAgentExecutionContext(origin, () => capture({ permission: 'canRead' }, async () => assert.fail())), code('AGENT_TOOL_INVOCATION_REQUIRED'));
      await assert.rejects(runWithAgentExecutionContext(origin, () => withAgentToolInvocation({ ...origin }, { toolName: 'write_text_file', toolCallId: 'clone' }, async () => assert.fail())), code('AGENT_TOOL_INVOCATION_INVALID'));
    });
    await check('forged, copied and retired principals and retained access fail closed', async () => {
      let retained!: Principal, retainedAccess!: Access;
      await captured(principal => transaction(async database => {
        retained = principal;
        for (const fake of [{}, { ...principal }]) await assert.rejects(phase(database, fake as Principal, async () => assert.fail()), code('PRINCIPAL_REQUIRED'));
        await phase(database, principal, async access => { retainedAccess = access; });
      }));
      await transaction(database => assert.rejects(phase(database, retained, async () => assert.fail()), code('PRINCIPAL_REQUIRED')));
      await assert.rejects(retainedAccess.assertCurrent(), code('PRINCIPAL_REQUIRED'));
    });
    await check('invocation abort before capture and between capture and B', async () => {
      const before = new AbortController(); before.abort();
      await assert.rejects(captured(async () => assert.fail(), false, before.signal), code('AGENT_TOOL_INVOCATION_ABORTED'));
      const during = new AbortController();
      await denied(() => captured(async principal => { during.abort(); await transaction(database => phase(database, principal, async () => assert.fail())); }, false, during.signal));
    });
    await check('selector cannot escape genuine invocation workspace', async () => {
      await denied(() => invoke(() => capture({ permission: 'canWrite', workspaceId: 'foreign-workspace' }, async () => assert.fail())));
    });
    const piDrifts = [
      ['archive', "UPDATE pi_sessions SET archived_at=100 WHERE session_id='pi-main'", 'PRINCIPAL_AUTH_REVOKED'],
      ['user reassignment', "UPDATE pi_sessions SET user_id='member' WHERE session_id='pi-main'", 'PRINCIPAL_AUTH_REVOKED'],
      ['agent reassignment', "UPDATE pi_sessions SET agent_id='special-agent' WHERE session_id='pi-main'", 'PRINCIPAL_AUTH_REVOKED'],
      ['workspace reassignment', "UPDATE pi_sessions SET workspace_id='foreign-workspace' WHERE session_id='pi-main'", 'PRINCIPAL_SCOPE_CHANGED'],
      ['delete', "DELETE FROM pi_sessions WHERE session_id='pi-main'", 'PRINCIPAL_AUTH_REVOKED'],
      ['delete and recreate', `WITH old AS (DELETE FROM pi_sessions WHERE session_id='pi-main' RETURNING *)
        INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
        SELECT session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at FROM old`, 'PRINCIPAL_AUTH_REVOKED'],
    ] as const;
    for (const [name, sql, expectedCode] of piDrifts) {
      await check(`exact PI ${name} before B rejects`, async () => {
        let calls = 0;
        try { await denied(() => captured(async principal => { await admin.query(sql); await transaction(database => phase(database, principal, async () => { calls++; })); }), expectedCode); assert.equal(calls, 0); }
        finally { await restorePi(); }
      });
      await check(`exact PI ${name} in B rejects final check and rolls back`, async () => {
        let calls = 0;
        await denied(() => captured(principal => transaction(database => phase(database, principal, async () => { calls++; await database.run(sql); }))), expectedCode);
        assert.equal(calls, 1, 'The genuine B callback must run before its self-drift is rejected.');
        assert.equal((await admin.query("SELECT count(*)::int AS count FROM pi_sessions WHERE session_id='pi-main' AND user_id='owner' AND archived_at IS NULL")).rows[0].count, 1);
      });
    }
    for (const [name, change, restore, expectedCode] of [
      ['profile revision', "UPDATE agents SET revision=revision+1 WHERE agent_id='special-agent'", "UPDATE agents SET revision=1 WHERE agent_id='special-agent'", 'PRINCIPAL_SCOPE_CHANGED'],
      ['tool config disable', "UPDATE agents SET enabled_tools_json='[]' WHERE agent_id='special-agent'", "UPDATE agents SET enabled_tools_json='[\"write_text_file\"]' WHERE agent_id='special-agent'", 'PRINCIPAL_SCOPE_CHANGED'],
      ['grant revoke', "UPDATE agent_grants SET can_use=0 WHERE id='special-grant'", "UPDATE agent_grants SET can_use=1 WHERE id='special-grant'", undefined],
      ['grant delete', "DELETE FROM agent_grants WHERE id='special-grant'", null, undefined],
      ['seat suspended', "UPDATE team_memberships SET status='suspended' WHERE id='member-seat'", "UPDATE team_memberships SET status='active' WHERE id='member-seat'", undefined],
      ['organization membership revoked', "UPDATE organization_user_permissions SET status='disabled' WHERE user_id='member'", "UPDATE organization_user_permissions SET status='active' WHERE user_id='member'", undefined],
      ['workspace write revoked', "UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'", "UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'", undefined],
      ['user banned', "UPDATE \"user\" SET banned=1 WHERE id='member'", "UPDATE \"user\" SET banned=0 WHERE id='member'", 'PRINCIPAL_AUTH_REVOKED'],
    ] as const) {
      await check(`${name} after capture rejects before callback`, async () => {
        let calls = 0;
        try { await denied(() => captured(async principal => { await admin.query(change); await transaction(database => phase(database, principal, async () => { calls++; })); }, true), expectedCode); assert.equal(calls, 0); }
        finally { if (restore) await admin.query(restore); else await seedGrant(); }
      });
      await check(`${name} in B rejects final check`, async () => {
        let calls = 0;
        await denied(() => captured(principal => transaction(database => phase(database, principal, async () => { calls++; await database.run(change); })), true), expectedCode);
        assert.equal(calls, 1, 'This assertion covers final validation after a real self-write.');
      });
    }
    await check('held phase freezes existing and missing Agent, grant, seat and ACL predicates', async () => {
      const writes = [
        "UPDATE pi_sessions SET archived_at=100 WHERE session_id='pi-special'",
        "DELETE FROM pi_sessions WHERE session_id='pi-special'",
        "UPDATE agents SET revision=revision+1 WHERE agent_id='special-agent'",
        "UPDATE agent_members SET status='active',can_use=1 WHERE agent_id='special-agent' AND user_id='member'",
        "DELETE FROM agent_grants WHERE id='special-grant'",
        "INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,created_at,updated_at) VALUES('new-predicate','special-agent','principal-org','user','member',100,100)",
        "INSERT INTO agent_members(agent_id,organization_id,user_id,created_at,updated_at) VALUES('special-agent','principal-org','inactive',100,100)",
        "UPDATE team_memberships SET status='active' WHERE id='inactive-seat'",
        "UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'",
        'ALTER TABLE agent_grants DISABLE TRIGGER ALL',
        'ALTER TABLE pi_sessions DISABLE TRIGGER ALL',
      ];
      await captured(principal => transaction(database => phase(database, principal, async access => {
        for (const sql of writes) await transaction(async (_peer, client) => { await assert.rejects(client.query(sql), code('55P03')); });
        // Ordinary session cleanup and a genuinely unrelated PI row are not
        // Agent authority predicates and must complete on another backend.
        const peer = await ownClient();
        try {
          await peer.query("UPDATE session SET updated_at=101 WHERE id='browser-unrelated'");
          await peer.query("DELETE FROM session WHERE id='browser-unrelated'");
          await peer.query("UPDATE pi_sessions SET title='unrelated write' WHERE session_id='pi-unrelated'");
          await peer.query("DELETE FROM pi_sessions WHERE session_id='pi-unrelated'");
          await seedPi('pi-unrelated-new', 'owner', MAIN_AGENT_ID);
        } finally { await endClient(peer); }
        await access.assertCurrent();
      })), true);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM session WHERE id='browser-unrelated'")).rows[0].count, 0);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM pi_sessions WHERE session_id='pi-unrelated-new'")).rows[0].count, 1);
    });
    await check('RC/RW, explicit transaction, XID, schema and relation identity', async () => {
      for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE', 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'])
        await denied(() => captured(principal => transaction(database => phase(database, principal, async () => assert.fail()), begin)));
      await denied(() => captured(async principal => { const client = await ownClient(); try { await phase(connection(client), principal, async () => assert.fail()); } finally { await endClient(client); } }));
      for (const sql of ['COMMIT; BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE', `SET LOCAL search_path=${schema}`, 'CREATE TEMP TABLE pi_sessions(id bigint)'])
        await denied(() => captured(principal => transaction(database => phase(database, principal, async access => { await database.run(sql); await access.assertCurrent(); }))));
    });
    await check('backend cannot change behind one SqlConnection facade', async () => {
      await denied(() => captured(principal => transaction(async (_database, initial) => {
        const peer = await ownClient(); let active = initial; await peer.query('BEGIN');
        const facade: SqlConnection = { get: async (sql, values) => (await active.query(sql, values)).rows[0],
          all: async (sql, values) => (await active.query(sql, values)).rows, run: async (sql, values) => ({ changes: (await active.query(sql, values)).rowCount ?? 0 }), close: () => assert.fail() };
        try { await phase(facade, principal, async access => { active = peer; await access.assertCurrent(); }); }
        finally { try { await peer.query('ROLLBACK'); } finally { await endClient(peer); } }
      })));
    });
    await check('runtime abort during B is checked even without an explicit assertion', async () => {
      const abort = new AbortController();
      await denied(() => captured(principal => transaction(database => phase(database, principal, async () => { abort.abort(); })), false, abort.signal));
    });
    await check('mutating actual originating ALS context cannot replace captured provenance', async () => {
      const origin = await context();
      await denied(() => runWithAgentExecutionContext(origin, () => withAgentToolInvocation(origin,
        { toolName: 'write_text_file', toolCallId: 'origin-drift' }, () => capture({ permission: 'canWrite' }, async principal => {
          origin.sessionId = 'pi-unrelated-new';
          await transaction(database => phase(database, principal, async () => assert.fail()));
        }))));
    });
    await check('Agent FK validation rejects deferred, unvalidated and disabled references', async () => {
      const row = (await admin.query(`SELECT conname FROM pg_constraint WHERE conrelid='pi_sessions'::regclass
        AND confrelid='"user"'::regclass AND contype='f' AND cardinality(conkey)=1`)).rows[0];
      assert(row); assert.match(row.conname, /^[a-z_]+$/u);
      const constraint = `"${row.conname}"`;
      for (const mode of ['deferred', 'unvalidated', 'disabled']) {
        try {
          if (mode === 'deferred') await admin.query(`ALTER TABLE pi_sessions ALTER CONSTRAINT ${constraint} DEFERRABLE INITIALLY IMMEDIATE`);
          if (mode === 'unvalidated') {
            await admin.query(`ALTER TABLE pi_sessions DROP CONSTRAINT ${constraint}`);
            await admin.query(`ALTER TABLE pi_sessions ADD CONSTRAINT ${constraint} FOREIGN KEY(user_id) REFERENCES "user"(id) NOT VALID`);
          }
          if (mode === 'disabled') await admin.query('ALTER TABLE pi_sessions DISABLE TRIGGER ALL');
          await assert.rejects(captured(principal => transaction(database => phase(database, principal, async () => assert.fail()))), code('PRINCIPAL_SCHEMA_INVALID'));
        } finally {
          await admin.query(`ALTER TABLE pi_sessions ALTER CONSTRAINT ${constraint} NOT DEFERRABLE`);
          await admin.query(`ALTER TABLE pi_sessions VALIDATE CONSTRAINT ${constraint}`);
          await admin.query('ALTER TABLE pi_sessions ENABLE TRIGGER ALL');
        }
      }
    });
    await check('caught invalid input and reentrant checks poison genuine outer result', async () => {
      await assert.rejects(captured(async principal => { await assert.rejects(phase({} as SqlConnection, principal, async () => assert.fail()), code('PRINCIPAL_INVALID')); }), code('PRINCIPAL_INVALID'));
      await assert.rejects(captured(principal => transaction(database => phase(database, principal, async access => {
        await Promise.allSettled([access.assertCurrent(), access.assertCurrent()]);
      }))), code('PRINCIPAL_REENTRANT'));
    });
    await check('unawaited assertions and detached B phases drain and reject', async () => {
      await assert.rejects(captured(principal => transaction(database => phase(database, principal, async access => { void access.assertCurrent().catch(() => undefined); }))), code('PRINCIPAL_DETACHED'));
      const client = await ownClient(); await client.query('BEGIN'); let detached: Promise<unknown> | undefined;
      try { await assert.rejects(captured(async principal => { detached = phase(connection(client), principal, async () => undefined); void detached.catch(() => undefined); }), code('PRINCIPAL_DETACHED')); }
      finally { await detached?.catch(() => undefined); try { await client.query('ROLLBACK'); } finally { await endClient(client); } }
    });
    await check('phase entry expires and genuine caller exceptions remain primary', async () => {
      await assert.rejects(captured(async principal => { await new Promise(resolve => setTimeout(resolve, 5050)); await transaction(database => phase(database, principal, async () => assert.fail())); }), code('PRINCIPAL_EXPIRED'));
      const marker = new Error('Private fixture callback failure');
      await assert.rejects(captured(() => { throw marker; }), error => error === marker);
    });
    for (const mode of ['rollback acknowledgement', 'release acknowledgement', 'rollback and release acknowledgement'] as const) await check(`cleanup priority: ${mode}`, async () => {
      const blocker = await ownClient(), lock = crypto.randomUUID();
      const rollbackError = new Error('Fixture rollback acknowledgement lost'), releaseError = new Error('Fixture release acknowledgement lost');
      let phaseError: unknown, lifecycleError: unknown, rollbacks = 0, closes = 0, commits = 0, recoveries = 0;
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lock]);
        await assert.rejects(captured(async principal => {
          try { await executeLifecycleTransaction({
            openConnection: async () => {
              const actual = await openDb();
              return { ...actual, run: async (sql, values) => {
                if (sql === 'COMMIT') commits++; if (sql === 'ROLLBACK') rollbacks++;
                const result = await actual.run(sql, values);
                if (sql === 'ROLLBACK' && mode !== 'release acknowledgement') throw rollbackError;
                return result;
              }, close: async (error?: Error) => { closes++; await actual.close(error); if (mode !== 'rollback acknowledgement') throw releaseError; } };
            },
            execute: async database => {
              await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
              try { await phase(database, principal, async () => { await database.get('SELECT pg_advisory_xact_lock(hashtext($1))', [lock]); }); }
              catch (error) { phaseError = error; throw error; }
            }, recoverCommitted: async () => { recoveries++; assert.fail('Failed phase must not COMMIT.'); },
          }); } catch (error) { lifecycleError = error; throw error; }
        }), error => {
          assert.equal(error, lifecycleError); assert(code('PRINCIPAL_BUSY')(phaseError));
          if (mode === 'release acknowledgement') assert.equal(error, releaseError);
          else { assert(error instanceof AggregateError); assert.deepEqual(error.errors, mode === 'rollback acknowledgement' ? [phaseError, rollbackError] : [phaseError, rollbackError, releaseError]); }
          return true;
        });
        assert.equal(rollbacks, 1); assert.equal(closes, 1); assert.equal(commits, 0); assert.equal(recoveries, 0);
      } finally { try { await blocker.query('ROLLBACK'); } finally { await endClient(blocker); } }
    });
    await check('unknown COMMIT delivery reaches durable recovery without principal masking', async () => {
      const commitError = new Error('Fixture actual COMMIT reply lost'), recoveryError = new Error('Fixture recovery proof unavailable');
      let commits = 0, rollbacks = 0, closes = 0, recoveries = 0;
      await assert.rejects(captured(principal => executeLifecycleTransaction({
        openConnection: async () => {
          const actual = await openDb();
          return { ...actual, run: async (sql, values) => {
            if (sql === 'COMMIT') commits++; if (sql === 'ROLLBACK') rollbacks++;
            const result = await actual.run(sql, values); if (sql === 'COMMIT') throw commitError; return result;
          }, close: async (error?: Error) => { closes++; await actual.close(error); } };
        }, execute: async database => {
          await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
          await phase(database, principal, async () => { await database.run("INSERT INTO fixture_writes VALUES('unknown-commit','durable')"); });
          return 'committed';
        }, recoverCommitted: async (value, error) => { recoveries++; assert.equal(value, 'committed'); assert.equal(error, commitError); throw recoveryError; },
      })), error => error === recoveryError);
      assert.equal((await admin.query("SELECT value FROM fixture_writes WHERE id='unknown-commit'")).rows[0]?.value, 'durable');
      assert.deepEqual({ commits, rollbacks, closes, recoveries }, { commits: 1, rollbacks: 0, closes: 1, recoveries: 1 });
    });
    assert.equal(fetches, 0); assert.equal(passed, 49); await own();
    console.log('Agent principal SQL assertions complete:', JSON.stringify({ passed, fetches }));
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
  console.log('Workspace Agent Tool Principal PostgreSQL18 finished:', JSON.stringify({ passed, cleanup: true }));
}
main().catch(error => {
  console.error('Owned Agent principal fixture failed:', { stage, passed, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null }); process.exitCode = 1;
});
